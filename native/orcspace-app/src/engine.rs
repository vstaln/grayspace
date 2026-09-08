use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_SCROLLBACK: usize = 1_000_000;
const TOKEN_HEADER: &str = "x-orcspace-token";

#[derive(Clone, Debug)]
pub struct TerminalManager {
    inner: Arc<Inner>,
}

#[derive(Debug)]
struct Inner {
    terminals: Mutex<HashMap<String, TerminalHandle>>,
    events: Mutex<VecDeque<TerminalEvent>>,
    token: String,
    control_url: Mutex<Option<String>>,
}

#[derive(Debug)]
struct TerminalHandle {
    tx: mpsc::Sender<TerminalCommand>,
    state: Arc<Mutex<TerminalState>>,
    input_guard: Arc<Mutex<()>>,
}

#[allow(dead_code)]
#[derive(Debug)]
enum TerminalCommand {
    Input {
        data: Vec<u8>,
        response: mpsc::Sender<Result<(), String>>,
    },
    Resize {
        cols: u16,
        rows: u16,
        response: mpsc::Sender<Result<(), String>>,
    },
    Dispose,
}

#[derive(Debug, Default)]
struct TerminalState {
    output: String,
    alive: bool,
    cwd: String,
}

#[derive(Clone, Debug)]
pub struct TerminalSnapshot {
    pub id: String,
    pub output: String,
    pub alive: bool,
    pub cwd: String,
}

#[derive(Clone, Debug)]
pub enum TerminalEvent {
    Output { id: String, data: String },
    Exited { id: String },
}

#[derive(Clone, Debug, Serialize)]
pub struct DeliveryReceipt {
    pub id: String,
    pub terminal_id: String,
    pub status: &'static str,
    pub bytes: usize,
    pub confirmed_at: u128,
}

impl TerminalManager {
    pub fn new(token: String) -> Self {
        Self {
            inner: Arc::new(Inner {
                terminals: Mutex::new(HashMap::new()),
                events: Mutex::new(VecDeque::new()),
                token,
                control_url: Mutex::new(None),
            }),
        }
    }

    pub fn set_control_url(&self, url: String) {
        *self.inner.control_url.lock().expect("control URL mutex") = Some(url);
    }

    pub fn control_url(&self) -> Option<String> {
        self.inner
            .control_url
            .lock()
            .expect("control URL mutex")
            .clone()
    }

    pub fn spawn(&self, id: impl Into<String>) -> Result<(), String> {
        self.spawn_with_options(
            id,
            120,
            32,
            None,
            shell_command(),
            HashMap::new(),
        )
    }

    pub fn spawn_with_options(
        &self,
        id: impl Into<String>,
        cols: u16,
        rows: u16,
        cwd: Option<String>,
        shell: String,
        extra_env: HashMap<String, String>,
    ) -> Result<(), String> {
        let id = id.into();
        let mut terminals = self.inner.terminals.lock().expect("terminals mutex");
        if let Some(existing) = terminals.get(&id) {
            if existing.state.lock().map(|state| state.alive).unwrap_or(false) {
                return Ok(());
            }
            terminals.remove(&id);
        }

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("open pty: {error}"))?;

        let mut command = CommandBuilder::new(&shell);
        command.env("TERM", "xterm-256color");
        command.env("ORCSPACE_TERMINAL_ID", &id);
        command.env("ORCSPACE_AGENT_ID", &id);
        command.env("ORCSPACE_TOKEN", &self.inner.token);
        command.env("ORCSPACE_NATIVE", "1");
        if let Some(url) = self.control_url() {
            command.env("ORCSPACE_URL", url);
        }
        if let Ok(executable) = std::env::current_exe() {
            if let Some(parent) = executable.parent() {
                let separator = if cfg!(windows) { ';' } else { ':' };
                let current_path = std::env::var_os("PATH")
                    .map(|value| value.to_string_lossy().into_owned())
                    .unwrap_or_default();
                command.env(
                    "PATH",
                    format!("{}{}{}", parent.display(), separator, current_path),
                );
            }
        }
        let state_cwd = cwd.clone().or_else(|| {
            std::env::current_dir()
                .ok()
                .and_then(|path| path.to_str().map(str::to_owned))
        }).unwrap_or_default();
        if let Some(cwd) = cwd {
            command.cwd(cwd);
        } else if let Ok(cwd) = std::env::current_dir() {
            command.cwd(cwd);
        }
        for (key, value) in extra_env {
            command.env(key, value);
        }

        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("spawn {shell}: {error}"))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| format!("clone pty reader: {error}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| format!("take pty writer: {error}"))?;
        let state = Arc::new(Mutex::new(TerminalState {
            alive: true,
            cwd: state_cwd,
            ..Default::default()
        }));
        let input_guard = Arc::new(Mutex::new(()));
        let (tx, rx) = mpsc::channel();
        let events = Arc::clone(&self.inner);
        let reader_state = Arc::clone(&state);
        let reader_id = id.clone();

        thread::Builder::new()
            .name(format!("orcspace-pty-reader-{id}"))
            .spawn(move || read_output(reader, reader_state, events, reader_id))
            .map_err(|error| format!("spawn pty reader: {error}"))?;

        let actor_state = Arc::clone(&state);
        let actor_id = id.clone();
        thread::Builder::new()
            .name(format!("orcspace-pty-actor-{id}"))
            .spawn(move || run_actor(pair.master, writer, child, rx, actor_state, actor_id))
            .map_err(|error| format!("spawn pty actor: {error}"))?;

        terminals.insert(
            id,
            TerminalHandle {
                tx,
                state,
                input_guard,
            },
        );
        Ok(())
    }

    pub fn dispose(&self, id: &str) -> Result<(), String> {
        let handle = self
            .inner
            .terminals
            .lock()
            .expect("terminals mutex")
            .remove(id)
            .ok_or_else(|| format!("unknown terminal {id}"))?;
        handle
            .tx
            .send(TerminalCommand::Dispose)
            .map_err(|_| format!("terminal {id} actor stopped"))
    }

    pub fn dispose_all(&self) {
        let ids: Vec<String> = self
            .inner
            .terminals
            .lock()
            .map(|terminals| terminals.keys().cloned().collect())
            .unwrap_or_default();
        for id in ids {
            let _ = self.dispose(&id);
        }
    }

    #[allow(dead_code)]
    pub fn write_raw(&self, id: &str, data: &[u8]) -> Result<(), String> {
        self.write_serialized(id, data)
    }

    pub fn write_line(&self, id: &str, text: &str) -> Result<DeliveryReceipt, String> {
        self.write_text(id, text, true)
    }

    pub fn write_text(
        &self,
        id: &str,
        text: &str,
        press_enter: bool,
    ) -> Result<DeliveryReceipt, String> {
        let handle = self.handle(id)?;
        let _guard = handle.input_guard.lock().expect("terminal input mutex");
        let bytes = encode_terminal_input(text, press_enter)?;
        let count = bytes.len();
        self.send_input(&handle, bytes)?;
        Ok(DeliveryReceipt {
            id: format!("delivery-{}", uuid::Uuid::new_v4().simple()),
            terminal_id: id.to_owned(),
            status: "written",
            bytes: count,
            confirmed_at: now_millis(),
        })
    }

    #[allow(dead_code)]
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let handle = self.handle(id)?;
        let (response_tx, response_rx) = mpsc::channel();
        handle
            .tx
            .send(TerminalCommand::Resize {
                cols,
                rows,
                response: response_tx,
            })
            .map_err(|_| format!("terminal {id} actor stopped"))?;
        response_rx
            .recv()
            .map_err(|_| format!("terminal {id} actor stopped"))?
    }

    pub fn snapshot(&self, id: &str) -> Result<TerminalSnapshot, String> {
        let handle = self.handle(id)?;
        let state = handle.state.lock().expect("terminal state mutex");
        Ok(TerminalSnapshot {
            id: id.to_owned(),
            output: state.output.clone(),
            alive: state.alive,
            cwd: state.cwd.clone(),
        })
    }

    pub fn snapshots(&self) -> Vec<TerminalSnapshot> {
        let ids: Vec<String> = self
            .inner
            .terminals
            .lock()
            .expect("terminals mutex")
            .keys()
            .cloned()
            .collect();
        ids.into_iter()
            .filter_map(|id| self.snapshot(&id).ok())
            .collect()
    }

    pub fn drain_events(&self) -> Vec<TerminalEvent> {
        let mut events = self.inner.events.lock().expect("events mutex");
        events.drain(..).collect()
    }

    fn handle(&self, id: &str) -> Result<TerminalHandle, String> {
        self.inner
            .terminals
            .lock()
            .expect("terminals mutex")
            .get(id)
            .map(|handle| TerminalHandle {
                tx: handle.tx.clone(),
                state: Arc::clone(&handle.state),
                input_guard: Arc::clone(&handle.input_guard),
            })
            .ok_or_else(|| format!("unknown terminal {id}"))
    }

    fn write_serialized(&self, id: &str, data: &[u8]) -> Result<(), String> {
        let handle = self.handle(id)?;
        let _guard = handle.input_guard.lock().expect("terminal input mutex");
        self.send_input(&handle, data.to_vec())
    }

    fn send_input(&self, handle: &TerminalHandle, data: Vec<u8>) -> Result<(), String> {
        let (response_tx, response_rx) = mpsc::channel();
        handle
            .tx
            .send(TerminalCommand::Input {
                data,
                response: response_tx,
            })
            .map_err(|_| "terminal actor stopped".to_owned())?;
        response_rx
            .recv()
            .map_err(|_| "terminal actor stopped".to_owned())?
    }
}

fn run_actor(
    master: Box<dyn MasterPty + Send>,
    mut writer: Box<dyn Write + Send>,
    mut child: Box<dyn Child + Send + Sync>,
    rx: mpsc::Receiver<TerminalCommand>,
    state: Arc<Mutex<TerminalState>>,
    id: String,
) {
    let master = master;
    while let Ok(command) = rx.recv() {
        match command {
            TerminalCommand::Input { data, response } => {
                let result = writer
                    .write_all(&data)
                    .and_then(|_| writer.flush())
                    .map_err(|error| format!("write terminal {id}: {error}"));
                let _ = response.send(result);
            }
            TerminalCommand::Resize {
                cols,
                rows,
                response,
            } => {
                let result = master
                    .resize(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    })
                    .map_err(|error| format!("resize terminal {id}: {error}"));
                let _ = response.send(result);
            }
            TerminalCommand::Dispose => {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
        }
    }
    if let Ok(mut current) = state.lock() {
        current.alive = false;
    }
}

fn read_output(
    mut reader: Box<dyn Read + Send>,
    state: Arc<Mutex<TerminalState>>,
    inner: Arc<Inner>,
    id: String,
) {
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let count = match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => count,
        };
        let data = String::from_utf8_lossy(&buffer[..count]).into_owned();
        if let Ok(mut current) = state.lock() {
            current.output.push_str(&data);
            if current.output.len() > MAX_SCROLLBACK {
                let cut = current.output.len() - MAX_SCROLLBACK;
                let boundary = current.output[cut..]
                    .find('\n')
                    .map(|offset| cut + offset + 1)
                    .unwrap_or(cut);
                current.output.drain(..boundary);
            }
        }
        if let Ok(mut events) = inner.events.lock() {
            events.push_back(TerminalEvent::Output {
                id: id.clone(),
                data,
            });
            while events.len() > 512 {
                events.pop_front();
            }
        }
    }
    if let Ok(mut current) = state.lock() {
        current.alive = false;
    }
    if let Ok(mut events) = inner.events.lock() {
        events.push_back(TerminalEvent::Exited { id });
    }
}

fn shell_command() -> String {
    #[cfg(windows)]
    {
        std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_owned())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_owned())
    }
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn encode_terminal_input(text: &str, press_enter: bool) -> Result<Vec<u8>, String> {
    let line = text.replace(['\r', '\n'], " ");
    if line.trim().is_empty() {
        return Err("message must contain non-whitespace text".to_owned());
    }
    let mut bytes = line.into_bytes();
    if press_enter {
        bytes.push(b'\r');
    }
    Ok(bytes)
}

#[derive(Clone)]
pub struct ControlServer {
    url: String,
}

impl ControlServer {
    pub fn start(manager: TerminalManager, token: String) -> Result<Self, String> {
        let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
            .map_err(|error| format!("bind control server: {error}"))?;
        let address = listener
            .local_addr()
            .map_err(|error| format!("read control server address: {error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("configure control server: {error}"))?;
        let state = HttpState { manager, token };
        thread::Builder::new()
            .name("orcspace-control-server".to_owned())
            .spawn(move || {
                let runtime = match tokio::runtime::Runtime::new() {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        eprintln!("control server runtime: {error}");
                        return;
                    }
                };
                runtime.block_on(async move {
                    let socket = match tokio::net::TcpListener::from_std(listener) {
                        Ok(socket) => socket,
                        Err(error) => {
                            eprintln!("control server listener: {error}");
                            return;
                        }
                    };
                    let app = Router::new()
                        .route("/orchestration/workers", get(list_workers))
                        .route("/orchestration/workers/tell", post(tell_worker))
                        .route("/terminal/{id}/write", post(write_terminal))
                        .with_state(state);
                    if let Err(error) = axum::serve(socket, app).await {
                        eprintln!("control server stopped: {error}");
                    }
                });
            })
            .map_err(|error| format!("spawn control server: {error}"))?;
        Ok(Self {
            url: format!("http://{address}"),
        })
    }

    pub fn url(&self) -> String {
        self.url.clone()
    }
}

#[derive(Clone)]
struct HttpState {
    manager: TerminalManager,
    token: String,
}

#[derive(Serialize)]
struct WorkerList {
    workers: Vec<WorkerInfo>,
}

#[derive(Serialize)]
struct WorkerInfo {
    id: String,
    name: String,
    alive: bool,
    busy: bool,
    cwd: String,
}

#[derive(Deserialize)]
struct TellRequest {
    to: String,
    text: String,
}

#[derive(Deserialize)]
struct WriteRequest {
    #[serde(alias = "command", alias = "input", alias = "content")]
    text: Option<String>,
    #[serde(rename = "pressEnter", default = "default_true")]
    press_enter: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Serialize)]
struct WriteResponse {
    ok: bool,
    id: String,
    text: String,
    delivery: Option<DeliveryReceipt>,
}

async fn list_workers(
    State(state): State<HttpState>,
    headers: HeaderMap,
) -> Result<Json<WorkerList>, (StatusCode, String)> {
    authenticate(&headers, &state.token)?;
    let workers = state
        .manager
        .snapshots()
        .into_iter()
        .map(|snapshot| WorkerInfo {
            id: snapshot.id.clone(),
            name: snapshot.id,
            alive: snapshot.alive,
            busy: false,
            cwd: snapshot.cwd,
        })
        .collect();
    Ok(Json(WorkerList { workers }))
}

async fn tell_worker(
    State(state): State<HttpState>,
    headers: HeaderMap,
    Json(request): Json<TellRequest>,
) -> Result<Json<WriteResponse>, (StatusCode, String)> {
    authenticate(&headers, &state.token)?;
    let manager = state.manager.clone();
    let to = request.to.clone();
    let text = request.text.clone();
    let receipt = tokio::task::spawn_blocking(move || manager.write_line(&to, &text))
        .await
        .map_err(|error| bad_request(format!("delivery task failed: {error}")))?
        .map_err(bad_request)?;
    Ok(Json(WriteResponse {
        ok: true,
        id: request.to.clone(),
        text: request.text,
        delivery: Some(receipt),
    }))
}

async fn write_terminal(
    State(state): State<HttpState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(request): Json<WriteRequest>,
) -> Result<Json<WriteResponse>, (StatusCode, String)> {
    authenticate(&headers, &state.token)?;
    let text = request
        .text
        .ok_or_else(|| bad_request("terminal.write requires text".to_owned()))?;
    let manager = state.manager.clone();
    let press_enter = request.press_enter;
    let delivery_id = id.clone();
    let delivery_text = text.clone();
    let receipt = tokio::task::spawn_blocking(move || {
        manager.write_text(&delivery_id, &delivery_text, press_enter)
    })
    .await
    .map_err(|error| bad_request(format!("delivery task failed: {error}")))?
    .map_err(bad_request)?;
    Ok(Json(WriteResponse {
        ok: true,
        id,
        text,
        delivery: Some(receipt),
    }))
}

fn authenticate(headers: &HeaderMap, token: &str) -> Result<(), (StatusCode, String)> {
    let supplied = headers
        .get(TOKEN_HEADER)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if supplied == token {
        Ok(())
    } else {
        Err((StatusCode::UNAUTHORIZED, "invalid control token".to_owned()))
    }
}

fn bad_request(error: String) -> (StatusCode, String) {
    (StatusCode::BAD_REQUEST, error)
}

#[cfg(test)]
mod tests {
    use super::{encode_terminal_input, WriteRequest};
    use serde_json::json;

    #[test]
    fn line_normalization_rejects_space_only_messages() {
        assert!(encode_terminal_input("   ", true).is_err());
        assert_eq!(encode_terminal_input("a\r\nb", true).unwrap(), b"a  b\r");
        assert_eq!(encode_terminal_input("a", false).unwrap(), b"a");
    }

    #[test]
    fn write_request_defaults_to_enter_and_accepts_camel_case() {
        let defaulted: WriteRequest = serde_json::from_value(json!({"text": "run"})).unwrap();
        assert!(defaulted.press_enter);
        let raw: WriteRequest =
            serde_json::from_value(json!({"text": "run", "pressEnter": false})).unwrap();
        assert!(!raw.press_enter);
    }
}
