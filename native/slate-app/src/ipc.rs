//! Where the control server listens.
//!
//! Mirrors src/main/ipcSocket.ts, and the choice matters more than it looks.
//! The desktop app does **not** listen on a TCP port: it opens a named pipe on
//! Windows and a unix domain socket everywhere else. Three things follow from
//! that, and all three are why this is the convention to match rather than
//! improve on:
//!
//! * no port is occupied, so two Slate installs — or Slate and anything
//!   else — cannot collide, and nothing has to be told which port to use;
//! * access is governed by the operating system's own permissions on the pipe
//!   or the socket file, not by "we only bound to loopback";
//! * nothing is reachable from the network at all, not even in principle, so a
//!   misconfigured firewall cannot expose the command bus.
//!
//! The path is consistent across platforms, so `slate` finds the socket
//! without being told which is running.

use std::path::{Path, PathBuf};

/// The environment variable every spawned terminal is told the socket through.
///
/// It is not `SLATE_URL`: `cli/slate.mjs` checks the socket path first and
/// treats `SLATE_URL` as an http address.
pub const SOCKET_PATH_ENV: &str = "SLATE_SOCKET_PATH";

/// The directory shared with the control server and CLI.
pub fn user_data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("SLATE_TEST_USER_DATA") {
        return PathBuf::from(dir);
    }
    if let Some(dir) = std::env::var_os("SLATE_DEV_USER_DATA") {
        return PathBuf::from(dir);
    }
    if cfg!(windows) {
        if let Some(dir) = std::env::var_os("APPDATA") {
            return PathBuf::from(dir).join("Slate");
        }
        if let Some(dir) = std::env::var_os("LOCALAPPDATA") {
            return PathBuf::from(dir).join("Slate");
        }
    } else if cfg!(target_os = "macos") {
        if let Some(dir) = std::env::var_os("HOME") {
            return PathBuf::from(dir)
                .join("Library")
                .join("Application Support")
                .join("Slate");
        }
    } else if let Some(dir) = std::env::var_os("XDG_CONFIG_HOME") {
        return PathBuf::from(dir).join("Slate");
    } else if let Some(dir) = std::env::var_os("HOME") {
        return PathBuf::from(dir).join(".config").join("Slate");
    }
    PathBuf::from(".slate")
}

pub fn control_token_path() -> PathBuf {
    user_data_dir().join("control-token")
}

/// `runtimePresence.ts` — the on-disk discovery record tools read without
/// connecting to the socket: which instance, on which socket, in which
/// workspace. Written at startup, cleared on a clean quit.
pub fn runtime_path() -> PathBuf {
    user_data_dir().join("runtime.json")
}

pub fn write_runtime_presence(socket_path: &str, workspace_dir: &str) {
    let path = runtime_path();
    let written_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64);
    let body = serde_json::json!({
        "app": "slate",
        "socketPath": socket_path,
        "pid": std::process::id(),
        "workspaceDir": workspace_dir,
        "writtenAt": written_at,
    });
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let temp = path.with_extension(format!("{}.tmp", std::process::id()));
    if let Ok(mut file) = std::fs::File::create(&temp) {
        use std::io::Write;
        let _ = file.write_all(serde_json::to_string_pretty(&body).unwrap().as_bytes());
        let _ = file.sync_all();
        drop(file);
        let _ = std::fs::rename(&temp, &path);
    }
}

pub fn clear_runtime_presence() {
    let _ = std::fs::remove_file(runtime_path());
}

/// In-app control call — panes and the canvas mutate through the same HTTP
/// routes the `slate` CLI hits. The engine's in-memory stores persist after
/// every routed change, so the socket is the single writer; a direct file
/// write from the UI would be clobbered by the next routed persist.
/// Blocking with a short timeout — the server is this same process over
/// the unix socket, so the answer is milliseconds not seconds.
pub fn control_request(
    method: &str,
    path: &str,
    body: Option<&serde_json::Value>,
) -> Result<serde_json::Value, String> {
    use std::io::{Read, Write};
    let socket = socket_path(is_dev_environment());
    let token = std::fs::read_to_string(control_token_path())
        .map(|value| value.trim().to_owned())
        .unwrap_or_default();
    #[cfg(unix)]
    let mut stream = {
        let stream = std::os::unix::net::UnixStream::connect(&socket)
            .map_err(|e| format!("control socket {socket}: {e}"))?;
        let timeout = std::time::Duration::from_secs(10);
        stream
            .set_read_timeout(Some(timeout))
            .map_err(|e| e.to_string())?;
        stream
            .set_write_timeout(Some(timeout))
            .map_err(|e| e.to_string())?;
        stream
    };
    #[cfg(windows)]
    let mut stream = {
        if !socket.starts_with(r"\\.\pipe\") {
            return Err("Control endpoint must be a local named pipe".into());
        }
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&socket)
            .map_err(|e| format!("control pipe: {e}"))?
    };
    let payload = body
        .map(serde_json::to_vec)
        .transpose()
        .map_err(|e| e.to_string())?;
    let mut head = format!(
        "{method} {path} HTTP/1.1\r\nHost: slate\r\nx-slate-token: {token}\r\nConnection: close\r\n"
    );
    if let Some(bytes) = &payload {
        head.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            bytes.len()
        ));
    }
    head.push_str("\r\n");
    stream
        .write_all(head.as_bytes())
        .and_then(|_| {
            if let Some(bytes) = &payload {
                stream.write_all(bytes)
            } else {
                Ok(())
            }
        })
        .map_err(|e| format!("control write: {e}"))?;
    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .map_err(|e| format!("control read: {e}"))?;
    let text = String::from_utf8_lossy(&response);
    let status: u16 = text
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);
    let body_start = text.find("\r\n\r\n").map(|i| i + 4).unwrap_or(text.len());
    let json = serde_json::from_slice::<serde_json::Value>(text[body_start..].trim().as_bytes())
        .unwrap_or(serde_json::Value::Null);
    if !(200..300).contains(&status) {
        return Err(format!(
            "control {method} {path}: {status} {}",
            json.get("error").and_then(|e| e.as_str()).unwrap_or("")
        ));
    }
    Ok(json)
}

/// The shell's `writeAtomic`: temp file → fsync → `.bak` snapshot of the
/// previous good copy → rename. Every small store file went through it;
/// anything weaker can strand a reader on a torn write or a crash between
/// write and rename.
pub fn write_file_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension(format!("{}.tmp", std::process::id()));
    let mut file = std::fs::File::create(&temp)?;
    use std::io::Write;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    // The .bak lands BEFORE the rename: it is always the last-known-good,
    // which is what read_store_recovered falls back to.
    if path.exists() {
        let _ = std::fs::copy(path, path.with_extension("bak"));
    }
    std::fs::rename(&temp, path)
}

/// `readStoreJson`: a corrupt primary is quarantined to
/// `<name>.corrupt-<ms>` (never silently overwritten by the next save) and
/// the `.bak` from the last good write is tried instead. Returns `None`
/// when nothing readable exists — callers then use their default shape.
pub fn read_store_recovered(path: &Path) -> Option<Vec<u8>> {
    match std::fs::read(path) {
        Ok(bytes) => {
            if serde_json::from_slice::<serde_json::Value>(&bytes).is_ok() {
                Some(bytes)
            } else {
                let stamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |elapsed| elapsed.as_millis() as u64);
                let quarantine = path.with_extension(format!("corrupt-{stamp}"));
                let _ = std::fs::rename(path, quarantine);
                std::fs::read(path.with_extension("bak")).ok()
            }
        }
        Err(_) => std::fs::read(path.with_extension("bak")).ok(),
    }
}

/// Atomically publish the token used by the control server.  A unique temp
/// file prevents a reader from observing a partial token during startup.
pub fn persist_control_token(token: &str) -> std::io::Result<PathBuf> {
    let path = control_token_path();
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)?;
    let temp = parent.join(format!(
        ".control-token-{}-{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp)?;
    use std::io::Write;
    file.write_all(token.as_bytes())?;
    file.sync_all()?;
    drop(file);
    if let Err(error) = std::fs::rename(&temp, &path) {
        let _ = std::fs::remove_file(&temp);
        return Err(error);
    }
    Ok(path)
}

/// Matches `isDevEnvironment()`: a dev run is anything started by the dev
/// tooling, so its socket never collides with an installed app's.
pub fn is_dev_environment() -> bool {
    std::env::var_os("ELECTRON_RENDERER_URL").is_some()
        || std::env::var("NODE_ENV").is_ok_and(|value| value == "development")
        || std::env::var_os("SLATE_DEV_USER_DATA").is_some()
}

/// The pipe or socket the control server listens on.
///
/// `SLATE_SOCKET_PATH` overrides everything, which is what lets a test — or
/// a second instance — run without touching the real one.
pub fn socket_path(is_dev: bool) -> String {
    if let Ok(explicit) = std::env::var("SLATE_SOCKET_PATH") {
        if !explicit.is_empty() {
            return explicit;
        }
    }
    let suffix = if is_dev { "-dev" } else { "" };
    if cfg!(windows) {
        format!(r"\\.\pipe\slate{suffix}")
    } else {
        let mut path = std::env::temp_dir();
        path.push(format!("slate{suffix}.sock"));
        path.to_string_lossy().into_owned()
    }
}

/// Clears a socket file left behind by a process that did not shut down
/// cleanly. A unix socket is a file: binding onto an existing one fails with
/// `AddrInUse` even when nothing is listening, which would make one crash
/// prevent every later start. Windows named pipes have no such residue.
pub fn prepare_socket_path(path: &str) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::{
            io::ErrorKind,
            os::unix::{fs::FileTypeExt, net::UnixStream},
        };
        let metadata = match std::fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        if !metadata.file_type().is_socket() {
            return Err(std::io::Error::new(
                ErrorKind::AlreadyExists,
                "Control path is not a socket",
            ));
        }
        match UnixStream::connect(path) {
            Ok(_) => {
                return Err(std::io::Error::new(
                    ErrorKind::AddrInUse,
                    "Control server is already running",
                ))
            }
            Err(error) if error.kind() == ErrorKind::ConnectionRefused => {
                std::fs::remove_file(path)?
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    #[cfg(windows)]
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The suffix is what keeps a dev run off the installed app's socket.
    #[test]
    fn a_dev_socket_is_named_apart_from_a_release_one() {
        // Guarded: an override in the environment would mask the difference.
        if std::env::var_os("SLATE_SOCKET_PATH").is_some() {
            return;
        }
        let release = socket_path(false);
        let dev = socket_path(true);
        assert_ne!(release, dev);
        assert!(dev.contains("-dev"), "got {dev}");
        assert!(!release.contains("-dev"), "got {release}");
    }

    #[test]
    fn the_path_matches_the_platform_convention() {
        if std::env::var_os("SLATE_SOCKET_PATH").is_some() {
            return;
        }
        let path = socket_path(false);
        if cfg!(windows) {
            assert_eq!(path, r"\\.\pipe\slate");
        } else {
            assert!(path.ends_with("slate.sock"), "got {path}");
        }
    }

    /// Regression: the native app advertised its socket through
    /// `SLATE_SOCKET_PATH`, which `slate` reads. Both sides of
    /// that contract are checked here, against the real CLI, so a rename on
    /// either side fails a test instead of a fleet.
    #[test]
    fn the_cli_reads_the_variable_the_engine_writes() {
        let cli = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../cli/slate.mjs")
            .canonicalize();
        let Ok(cli) = cli else {
            // Checked out without the CLI: nothing to contradict.
            return;
        };
        let source = std::fs::read_to_string(cli).expect("slate.mjs is readable");
        assert!(
            source.contains(SOCKET_PATH_ENV),
            "cli/slate.mjs no longer reads {SOCKET_PATH_ENV}"
        );
        // And it must be preferred over the http fallback, or a stale
        // SLATE_URL in the environment would win.
        let socket_at = source.find(SOCKET_PATH_ENV).expect("checked above");
        if let Some(url_at) = source.find("SLATE_URL") {
            assert!(
                socket_at < url_at,
                "slate.mjs must check the socket path before falling back to a URL"
            );
        }
    }

    #[test]
    fn no_path_is_a_tcp_address() {
        if std::env::var_os("SLATE_SOCKET_PATH").is_some() {
            return;
        }
        for path in [socket_path(false), socket_path(true)] {
            assert!(
                !path.contains("127.0.0.1") && !path.contains("localhost"),
                "the control server must not fall back to a port: {path}"
            );
        }
    }
}
