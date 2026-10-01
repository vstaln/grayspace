//! Where the control server listens.
//!
//! Mirrors src/main/ipcSocket.ts, and the choice matters more than it looks.
//! The Electron app does **not** listen on a TCP port: it opens a named pipe on
//! Windows and a unix domain socket everywhere else. Three things follow from
//! that, and all three are why this is the convention to match rather than
//! improve on:
//!
//! * no port is occupied, so two OrcSpace installs — or OrcSpace and anything
//!   else — cannot collide, and nothing has to be told which port to use;
//! * access is governed by the operating system's own permissions on the pipe
//!   or the socket file, not by "we only bound to loopback";
//! * nothing is reachable from the network at all, not even in principle, so a
//!   misconfigured firewall cannot expose the command bus.
//!
//! The path is identical to the one Electron uses, so `orc` finds either
//! implementation without being told which is running.

use std::path::{Path, PathBuf};

/// The environment variable every spawned terminal is told the socket through.
///
/// It is not `ORCSPACE_URL`: `cli/orc.mjs` checks the socket path first and
/// treats `ORCSPACE_URL` as an http address. Putting a pipe path in the URL
/// variable makes every agent try to reach the control server over HTTP at a
/// name that is not one — which fails silently, per agent, at spawn time.
pub const SOCKET_PATH_ENV: &str = "ORCSPACE_SOCKET_PATH";

/// The directory shared with Electron and the JavaScript CLI.  Keeping the
/// token beside the socket discovery files lets a standalone native build be
/// addressed by `orc` without requiring callers to copy an environment value
/// around manually.
pub fn user_data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("ORCSPACE_TEST_USER_DATA") {
        return PathBuf::from(dir);
    }
    if let Some(dir) = std::env::var_os("ORCSPACE_DEV_USER_DATA") {
        return PathBuf::from(dir);
    }
    if cfg!(windows) {
        if let Some(dir) = std::env::var_os("APPDATA") {
            return PathBuf::from(dir).join("OrcSpace");
        }
        if let Some(dir) = std::env::var_os("LOCALAPPDATA") {
            return PathBuf::from(dir).join("OrcSpace");
        }
    } else if cfg!(target_os = "macos") {
        if let Some(dir) = std::env::var_os("HOME") {
            return PathBuf::from(dir)
                .join("Library")
                .join("Application Support")
                .join("OrcSpace");
        }
    } else if let Some(dir) = std::env::var_os("XDG_CONFIG_HOME") {
        return PathBuf::from(dir).join("OrcSpace");
    } else if let Some(dir) = std::env::var_os("HOME") {
        return PathBuf::from(dir).join(".config").join("OrcSpace");
    }
    PathBuf::from(".orcspace")
}

pub fn control_token_path() -> PathBuf {
    user_data_dir().join("control-token")
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
        || std::env::var_os("ORCSPACE_DEV_USER_DATA").is_some()
}

/// The pipe or socket the control server listens on.
///
/// `ORCSPACE_SOCKET_PATH` overrides everything, which is what lets a test — or
/// a second instance — run without touching the real one.
pub fn socket_path(is_dev: bool) -> String {
    if let Ok(explicit) = std::env::var("ORCSPACE_SOCKET_PATH") {
        if !explicit.is_empty() {
            return explicit;
        }
    }
    let suffix = if is_dev { "-dev" } else { "" };
    if cfg!(windows) {
        format!(r"\\.\pipe\orcspace{suffix}")
    } else {
        let mut path = std::env::temp_dir();
        path.push(format!("orcspace{suffix}.sock"));
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
        if std::env::var_os("ORCSPACE_SOCKET_PATH").is_some() {
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
        if std::env::var_os("ORCSPACE_SOCKET_PATH").is_some() {
            return;
        }
        let path = socket_path(false);
        if cfg!(windows) {
            assert_eq!(path, r"\\.\pipe\orcspace");
        } else {
            assert!(path.ends_with("orcspace.sock"), "got {path}");
        }
    }

    /// Regression: the native app first advertised its socket through
    /// `ORCSPACE_URL`, which `orc` treats as an http address — so every agent
    /// it spawned would have failed to reach the control server. Both sides of
    /// that contract are checked here, against the real CLI, so a rename on
    /// either side fails a test instead of a fleet.
    #[test]
    fn the_cli_reads_the_variable_the_engine_writes() {
        let cli = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../cli/orc.mjs")
            .canonicalize();
        let Ok(cli) = cli else {
            // Checked out without the CLI: nothing to contradict.
            return;
        };
        let source = std::fs::read_to_string(cli).expect("orc.mjs is readable");
        assert!(
            source.contains(SOCKET_PATH_ENV),
            "cli/orc.mjs no longer reads {SOCKET_PATH_ENV}"
        );
        // And it must be preferred over the http fallback, or a stale
        // ORCSPACE_URL in the environment would win.
        let socket_at = source.find(SOCKET_PATH_ENV).expect("checked above");
        if let Some(url_at) = source.find("ORCSPACE_URL") {
            assert!(
                socket_at < url_at,
                "orc.mjs must check the socket path before falling back to a URL"
            );
        }
    }

    #[test]
    fn no_path_is_a_tcp_address() {
        if std::env::var_os("ORCSPACE_SOCKET_PATH").is_some() {
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
