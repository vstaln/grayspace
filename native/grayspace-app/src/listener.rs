//! A listener that occupies no port.
//!
//! Windows gets a named pipe, everything else a unix domain socket, matching
//! what the Electron app does (see `ipc.rs` for why). Both are wrapped in
//! axum's `Listener` trait so the rest of the server does not know or care
//! which one it is running on.

use crate::ipc::socket_path;
use std::io;

/// Opens the control-server listener for this platform.
pub async fn bind(path: &str) -> io::Result<PlatformListener> {
    PlatformListener::bind(path).await
}

/// The path this process should listen on, honouring `GRAYSPACE_SOCKET_PATH`
/// and the dev suffix exactly as Electron does.
pub fn default_path() -> String {
    socket_path(crate::ipc::is_dev_environment())
}

#[cfg(windows)]
mod platform {
    use super::*;
    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

    /// A named pipe serves one client per instance, so the listener always
    /// holds the *next* instance ready. Creating it only after a client
    /// connected would leave a window in which a caller gets
    /// `FILE_NOT_FOUND` — which is the classic named-pipe race, and it shows
    /// up as `grayspace` failing intermittently under load rather than reliably.
    pub struct PlatformListener {
        path: String,
        next: Option<NamedPipeServer>,
    }

    impl PlatformListener {
        pub async fn bind(path: &str) -> io::Result<Self> {
            // `first_pipe_instance` fails if the name is already taken, which
            // is how a second GraySpace finds out another one is running
            // instead of silently stealing its clients.
            let first = ServerOptions::new()
                .first_pipe_instance(true)
                .create(path)?;
            Ok(Self {
                path: path.to_owned(),
                next: Some(first),
            })
        }

        pub fn path(&self) -> &str {
            &self.path
        }
    }

    impl axum::serve::Listener for PlatformListener {
        type Io = NamedPipeServer;
        type Addr = ();

        async fn accept(&mut self) -> (Self::Io, Self::Addr) {
            loop {
                let server = match self.next.take() {
                    Some(server) => server,
                    None => match ServerOptions::new().create(&self.path) {
                        Ok(server) => server,
                        Err(error) => {
                            // Out of instances or the name went away: wait
                            // rather than spin, and let the next attempt try
                            // again. Returning would end the server entirely.
                            eprintln!("control pipe unavailable: {error}");
                            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                            continue;
                        }
                    },
                };
                if let Err(error) = server.connect().await {
                    eprintln!("control pipe connect failed: {error}");
                    continue;
                }
                // Ready before this one is handed off, closing the race.
                self.next = ServerOptions::new().create(&self.path).ok();
                return (server, ());
            }
        }

        fn local_addr(&self) -> io::Result<Self::Addr> {
            Ok(())
        }
    }
}

#[cfg(unix)]
mod platform {
    use super::*;
    use crate::ipc::prepare_socket_path;
    use std::os::unix::fs::PermissionsExt;
    use tokio::net::{UnixListener, UnixStream};

    pub struct PlatformListener {
        path: String,
        inner: UnixListener,
    }

    impl PlatformListener {
        pub async fn bind(path: &str) -> io::Result<Self> {
            // A socket file left by a crash would make every later start fail
            // with AddrInUse even though nothing is listening.
            prepare_socket_path(path)?;
            let inner = UnixListener::bind(path)?;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
            Ok(Self {
                path: path.to_owned(),
                inner,
            })
        }

        pub fn path(&self) -> &str {
            &self.path
        }
    }

    impl Drop for PlatformListener {
        fn drop(&mut self) {
            // The socket file outlives the process otherwise.
            let _ = std::fs::remove_file(&self.path);
        }
    }

    impl axum::serve::Listener for PlatformListener {
        type Io = UnixStream;
        type Addr = ();

        async fn accept(&mut self) -> (Self::Io, Self::Addr) {
            loop {
                match self.inner.accept().await {
                    Ok((stream, _)) => return (stream, ()),
                    Err(error) => {
                        // A per-connection error must not end the server.
                        eprintln!("control socket accept failed: {error}");
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    }
                }
            }
        }

        fn local_addr(&self) -> io::Result<Self::Addr> {
            Ok(())
        }
    }
}

pub use platform::PlatformListener;
