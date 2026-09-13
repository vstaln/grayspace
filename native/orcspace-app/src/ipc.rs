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

use std::path::PathBuf;

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
        let mut path = PathBuf::from(std::env::temp_dir());
        path.push(format!("orcspace{suffix}.sock"));
        path.to_string_lossy().into_owned()
    }
}

/// Clears a socket file left behind by a process that did not shut down
/// cleanly. A unix socket is a file: binding onto an existing one fails with
/// `AddrInUse` even when nothing is listening, which would make one crash
/// prevent every later start. Windows named pipes have no such residue.
pub fn prepare_socket_path(path: &str) {
    if cfg!(windows) {
        return;
    }
    let _ = std::fs::remove_file(path);
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
