use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use orcspace_app::queue::ActorRateLimiter;
use std::{
    collections::{HashMap, VecDeque},
    fs,
    io::{Read, Write},
    path::{Path as FsPath, PathBuf},

    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        mpsc, Arc, Condvar, Mutex, Weak,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const MAX_SCROLLBACK: usize = 1_000_000;
/// How far past the cap the buffer is allowed to grow before it is compacted.
///
/// Trimming to exactly `MAX_SCROLLBACK` meant `String::drain` ran on every
/// single chunk once a terminal had produced a megabyte — and a drain from the
/// front moves everything behind it, so that is a ~1MB memmove per chunk. Agent
/// output arrives token by token, so "per chunk" is hundreds of times a second,
/// all of it while holding the terminal's state mutex and therefore blocking
/// writes and resizes too. That is the sluggishness that only ever showed up
/// after a session had been running for a while.
///
/// Compacting one slack's worth at a time turns that into one memmove per
/// 256KB of output instead of one per token.
const SCROLLBACK_SLACK: usize = 256 * 1024;
const TOKEN_HEADER: &str = "x-orcspace-token";
/// Ceiling for output that has been read from the PTYs but not yet handed to
/// the app. Only reached when the consumer stalls; past it the oldest output
/// is dropped (already stale for a live view) so a chatty agent can never
/// grow the engine without bound. Exit events are never dropped — losing one
/// leaves a widget waiting forever on a session that already ended.
const MAX_PENDING_EVENT_BYTES: usize = 8 * 1024 * 1024;
/// Ceiling for input queued for one terminal's writer thread. Writes are
/// handed over without waiting (see `enqueue_input`), so this is what keeps a
/// shell that has stopped reading its input from growing the queue forever.
const MAX_PENDING_INPUT_BYTES: usize = 1024 * 1024;
const MAX_HTTP_BODY_BYTES: usize = 2 * 1024 * 1024;
const SUBMIT_GAP: Duration = Duration::from_millis(200);
/// How long a single write into a PTY may stay in flight before the terminal
/// is treated as no longer reading its input.
///
/// A write into ConPTY (and into a Unix pty master) blocks once the child
/// stops draining it, with no timeout available at this layer. Without this
/// check the queue simply filled to `MAX_PENDING_INPUT_BYTES` while every
/// keystroke — Ctrl+C included — was accepted and never delivered, which is
/// what made a busy terminal look permanently hung. Past this threshold new
/// input is rejected immediately so the caller learns the truth on the very
/// first keystroke instead of after a megabyte of silence.
const STUCK_WRITE_MS: u64 = 2_000;
/// Ctrl+C. Recognised in `deliver_input` only to spot the one keystroke that
/// must still mean something on a terminal that has stopped reading.
const INTERRUPT_BYTE: u8 = 0x03;
/// Longest payload still treated as "the user pressed Ctrl+C" rather than as
/// bulk input that happens to contain the byte. A keystroke is one byte; a
/// pasted file is not allowed to buy itself an exemption from the queue cap.
const MAX_INTERRUPT_INPUT_BYTES: usize = 8;
/// Invisible SGR reset prepended to the first output after a drop: dropping
/// can cut an escape sequence in half, and without the reset the truncated
/// sequence bleeds styles into (or swallows) everything after it.
const RESYNC_PREFIX: &str = "\u{1b}[0m";

/// Take a lock, ignoring poisoning.
///
/// Every lock in this file used to be taken with either `.expect(..)` or
/// `if let Ok(..)`. Both turn one thread's panic into a much larger failure:
/// `.expect` aborts the whole engine, so a single terminal's panic kills every
/// other terminal in the app at once, and `if let Ok` silently skips the work
/// — for `push_event` that means dropping output, or an exit event, leaving a
/// widget waiting forever on a session that already ended.
///
/// The data these mutexes guard is a scrollback string, an event queue and a
/// handle map: a panic mid-update can leave a message truncated, but never
/// leaves any of them in a state the code below cannot handle. Carrying on
/// with the recovered value is strictly better than either alternative.
fn lock_recover<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Clone, Debug)]
pub struct TerminalManager {
    inner: Arc<Inner>,
}

#[derive(Debug)]
struct Inner {
    terminals: Mutex<HashMap<String, TerminalHandle>>,
    events: Mutex<EventQueue>,
    /// Signalled whenever output lands, so the engine's drain thread reacts
    /// immediately instead of polling on a fixed tick.
    events_ready: Condvar,
    token: String,
    control_socket: Mutex<Option<String>>,
}

#[derive(Debug, Default)]
struct EventQueue {
    items: VecDeque<TerminalEvent>,
    bytes: usize,
    /// Terminal ids that had output dropped or trimmed under pressure.
    /// Consumed by the next drain, which prefixes a resync reset onto the
    /// first Output event for each affected id — and only that id. A single
    /// shared flag here used to mean whichever terminal happened to produce
    /// the first Output event in a batch got the reset while the terminal
    /// that actually lost data did not, leaving it to keep rendering with
    /// whatever ANSI state a truncated escape sequence left it in.
    dropped: std::collections::HashSet<String>,
}

#[derive(Debug)]
struct TerminalHandle {
    /// Input only. Kept separate from `control_tx` because a write into a PTY
    /// blocks for as long as the child refuses to read: sharing one channel
    /// made resize and dispose queue behind a stuck keystroke, so the only
    /// way out of a wedged terminal was closing the widget.
    input_tx: mpsc::Sender<TerminalInput>,
    /// Resize/dispose. Served by a thread that never writes to the PTY, so it
    /// stays responsive no matter what the child is doing.
    control_tx: mpsc::Sender<ControlCommand>,
    state: Arc<Mutex<TerminalState>>,
    input_guard: Arc<Mutex<()>>,
    /// Bytes handed to the writer thread that it has not written yet.
    pending_input: Arc<AtomicUsize>,
    /// Unix-millis timestamp of the write currently in flight, or 0 when the
    /// writer is idle. Read by `enqueue_input` to spot a wedged child.
    writing_since: Arc<AtomicU64>,
    /// OS pid of the shell, used to kill the whole process tree on dispose.
    /// `child.kill()` alone only terminates the direct child and leaves
    /// grandchildren (agents, servers) orphaned.
    child_pid: Option<u32>,
}

#[derive(Debug)]
struct TerminalInput {
    data: Vec<u8>,
    press_enter: bool,
    acknowledgement: Option<mpsc::Sender<Result<(), String>>>,
}

#[derive(Debug)]
enum ControlCommand {
    Resize { cols: u16, rows: u16 },
    /// Ctrl+C on a terminal whose input is already wedged. The byte itself
    /// cannot be typed — it would queue behind the write that is stuck — so
    /// the foreground program is stopped directly instead.
    Interrupt,
    Dispose,
    /// Sent by the writer thread when the PTY can no longer be written to, so
    /// the actor tears the session down exactly as it does for a dispose.
    WriterFailed,
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
                events: Mutex::new(EventQueue::default()),
                events_ready: Condvar::new(),
                token,
                control_socket: Mutex::new(None),
            }),
        }
    }

    /// Records where the control server is listening, so every terminal this
    /// manager spawns can be told how to reach it.
    pub fn set_control_socket(&self, path: String) {
        *lock_recover(&self.inner.control_socket) = Some(path);
    }

    pub fn control_socket(&self) -> Option<String> {
        lock_recover(&self.inner.control_socket).clone()
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
        // Fast check under the lock; the slow PTY work below runs unlocked so
        // one spawn can never stall every other terminal operation.
        {
            let terminals = lock_recover(&self.inner.terminals);
            if let Some(existing) = terminals.get(&id) {
                if lock_recover(&existing.state).alive {
                    return Ok(());
                }
            }
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
        for arg in windows_utf8_shell_args(&shell) {
            command.arg(arg);
        }
        command.env("TERM", "xterm-256color");
        command.env("ORCSPACE_TERMINAL_ID", &id);
        command.env("ORCSPACE_AGENT_ID", &id);
        command.env("ORCSPACE_TOKEN", &self.inner.token);
        command.env("ORCSPACE_NATIVE", "1");
        // See SOCKET_PATH_ENV: this is deliberately not ORCSPACE_URL, and a
        // test pins both sides of that contract against the real orc.mjs.
        if let Some(path) = self.control_socket() {
            command.env(orcspace_app::ipc::SOCKET_PATH_ENV, path);
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
        // The Windows-only `chcp` args above (`windows_utf8_shell_args`) and
        // this are the same fix for the same class of bug on the two
        // platform families: a shell that renders non-ASCII text as
        // replacement characters looks exactly like a frozen or corrupted
        // terminal even though the process underneath is fine. PTYs on
        // macOS/Linux have no equivalent to a console codepage — any
        // locale-aware program instead decides its own text encoding from
        // `LANG`/`LC_ALL`, so forcing a UTF-8 locale here is the correct
        // counterpart. Set unconditionally, before `extra_env` below, so an
        // explicit value the caller supplies (Electron always sends one)
        // still wins — this only fills the gap for callers that don't,
        // chiefly this binary's own standalone native-GUI mode, which used
        // to hand the shell an empty environment.
        let lang = std::env::var("LANG").unwrap_or_else(|_| "en_US.UTF-8".to_owned());
        command.env("LC_ALL", std::env::var("LC_ALL").unwrap_or_else(|_| lang.clone()));
        command.env("LANG", lang);
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

        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("spawn {shell}: {error}"))?;
        let child_pid = child.process_id();

        // The shell is running from here on. Every failure below used to
        // return with `?`, which drops the child handle without killing
        // anything — portable_pty's Child, like std's, does not kill on drop.
        // That left a live shell (and whatever it starts) with no handle, no
        // map entry and no way to ever reach it again. These failures are
        // resource exhaustion, which is exactly when leaking one per attempt
        // makes things worse. The concurrent-spawn path further down already
        // tears its own child down for the same reason.
        macro_rules! abandon_child {
            ($child:expr, $message:expr) => {{
                if let Some(pid) = child_pid {
                    kill_process_tree(pid);
                }
                let _ = $child.kill();
                let _ = $child.wait();
                return Err($message);
            }};
        }

        let reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(error) => abandon_child!(child, format!("clone pty reader: {error}")),
        };
        let writer = match pair.master.take_writer() {
            Ok(writer) => writer,
            Err(error) => abandon_child!(child, format!("take pty writer: {error}")),
        };
        let state = Arc::new(Mutex::new(TerminalState {
            alive: true,
            cwd: state_cwd,
            ..Default::default()
        }));
        let input_guard = Arc::new(Mutex::new(()));
        let pending_input = Arc::new(AtomicUsize::new(0));
        let writing_since = Arc::new(AtomicU64::new(0));
        // Two channels, two threads: a write into a PTY blocks for as long as
        // the child refuses to drain it, so the thread that writes must never
        // be the thread that answers a resize, a dispose or an interrupt.
        // One shared channel is what let a single stuck keystroke freeze
        // everything about a terminal, Ctrl+C and close included.
        let (input_tx, input_rx) = mpsc::channel::<TerminalInput>();
        let (control_tx, control_rx) = mpsc::channel::<ControlCommand>();
        let events = Arc::clone(&self.inner);
        let reader_state = Arc::clone(&state);
        let reader_id = id.clone();

        if let Err(error) = thread::Builder::new()
            .name(format!("orcspace-pty-reader-{id}"))
            .spawn(move || read_output(reader, reader_state, events, reader_id))
        {
            abandon_child!(child, format!("spawn pty reader: {error}"));
        }

        let writer_pending = Arc::clone(&pending_input);
        let writer_writing_since = Arc::clone(&writing_since);
        let writer_control = control_tx.clone();
        let writer_id = id.clone();
        if let Err(error) = thread::Builder::new()
            .name(format!("orcspace-pty-writer-{id}"))
            .spawn(move || {
                run_writer(
                    writer,
                    input_rx,
                    writer_control,
                    writer_pending,
                    writer_writing_since,
                    writer_id,
                )
            })
        {
            abandon_child!(child, format!("spawn pty writer: {error}"));
        }

        let actor_state = Arc::clone(&state);
        // Weak, not Arc: `Inner` owns the map that owns this actor's command
        // sender, so a strong reference here would keep that sender alive
        // through the actor itself and its `recv()` could never end.
        let actor_inner = Arc::downgrade(&self.inner);
        let actor_pending = Arc::clone(&pending_input);
        let actor_id = id.clone();
        thread::Builder::new()
            .name(format!("orcspace-pty-actor-{id}"))
            .spawn(move || {
                run_actor(
                    pair.master,
                    child,
                    child_pid,
                    control_rx,
                    actor_state,
                    actor_inner,
                    actor_pending,
                    actor_id,
                )
            })
            .map_err(|error| {
                // The closure — and with it the child handle — is dropped when
                // the thread fails to start, so the pid is all that is left to
                // clean up with. Killing the tree also closes the PTY, which
                // ends the reader thread started just above.
                if let Some(pid) = child_pid {
                    kill_process_tree(pid);
                }
                format!("spawn pty actor: {error}")
            })?;

        {
            let mut terminals = lock_recover(&self.inner.terminals);
            // Re-check: a concurrent spawn for the same id may have won while
            // the PTY was created unlocked. The loser tears down its own
            // just-created child instead of orphaning it.
            if let Some(existing) = terminals.get(&id) {
                if lock_recover(&existing.state).alive {
                    drop(terminals);
                    if let Some(pid) = child_pid {
                        kill_process_tree(pid);
                    }
                    let _ = control_tx.send(ControlCommand::Dispose);
                    return Ok(());
                }
                terminals.remove(&id);
            }
            terminals.insert(
                id,
                TerminalHandle {
                    input_tx,
                    control_tx,
                    state,
                    input_guard,
                    pending_input,
                    writing_since,
                    child_pid,
                },
            );
        }
        Ok(())
    }

    pub fn dispose(&self, id: &str) -> Result<(), String> {
        let handle = lock_recover(&self.inner.terminals)
            .remove(id)
            .ok_or_else(|| format!("unknown terminal {id}"))?;
        // Kill the whole tree: the actor may be blocked behind a stuck write,
        // and `child.kill()` alone would orphan grandchildren. Killing runs on
        // its own thread because `taskkill` takes ~100ms and this call sits on
        // the engine's command loop, which must stay free to pump output.
        if let Some(pid) = handle.child_pid {
            let _ = thread::Builder::new()
                .name(format!("orcspace-pty-kill-{id}"))
                .spawn(move || {
                    kill_process_tree(pid);
                });
        }
        handle
            .control_tx
            .send(ControlCommand::Dispose)
            .map_err(|_| format!("terminal {id} actor stopped"))
    }

    pub fn dispose_all(&self) {
        let ids: Vec<String> = lock_recover(&self.inner.terminals).keys().cloned().collect();
        for id in ids {
            let _ = self.dispose(&id);
        }
    }

    #[allow(dead_code)]
    pub fn write_raw(&self, id: &str, data: &[u8]) -> Result<(), String> {
        self.deliver_input(id, data.to_vec())
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
        let bytes = encode_terminal_input(text, false)?;
        let count = bytes.len() + usize::from(press_enter);
        let handle = self.handle(id)?;
        let (tx, rx) = mpsc::channel();
        {
            let _guard = lock_recover(&handle.input_guard);
            if write_in_flight_ms(&handle.writing_since) >= STUCK_WRITE_MS
                || handle.pending_input.load(Ordering::Acquire).saturating_add(count) > MAX_PENDING_INPUT_BYTES
            {
                return Err(format!("terminal {id} is not reading input"));
            }
            push_terminal_input(id, &handle, TerminalInput {
                data: bytes,
                press_enter,
                acknowledgement: Some(tx),
            })?;
        }
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|_| format!("terminal {id}: input write not confirmed; delivery is uncertain, do not resend automatically"))??;
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
        handle
            .control_tx
            .send(ControlCommand::Resize { cols, rows })
            .map_err(|_| format!("terminal {id} actor stopped"))
    }

    pub fn snapshot(&self, id: &str) -> Result<TerminalSnapshot, String> {
        let handle = self.handle(id)?;
        let state = lock_recover(&handle.state);
        Ok(TerminalSnapshot {
            id: id.to_owned(),
            output: state.output.clone(),
            alive: state.alive,
            cwd: state.cwd.clone(),
        })
    }

    pub fn snapshots(&self) -> Vec<TerminalSnapshot> {
        let ids: Vec<String> = lock_recover(&self.inner.terminals).keys().cloned().collect();
        ids.into_iter()
            .filter_map(|id| self.snapshot(&id).ok())
            .collect()
    }

    /// Non-blocking drain, used by the egui frame loop.
    pub fn drain_events(&self) -> Vec<TerminalEvent> {
        let mut queue = lock_recover(&self.inner.events);
        take_events(&mut queue)
    }

    /// Blocking drain, used by the headless engine so output is forwarded the
    /// moment it is read instead of on a polling tick — and so forwarding can
    /// never end up queued behind command handling.
    pub fn wait_events(&self, timeout: Duration) -> Vec<TerminalEvent> {
        let queue = lock_recover(&self.inner.events);
        let (mut queue, _) = self
            .inner
            .events_ready
            .wait_timeout_while(queue, timeout, |queue| queue.items.is_empty())
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        take_events(&mut queue)
    }

    fn handle(&self, id: &str) -> Result<TerminalHandle, String> {
        lock_recover(&self.inner.terminals)
            .get(id)
            .map(|handle| TerminalHandle {
                input_tx: handle.input_tx.clone(),
                control_tx: handle.control_tx.clone(),
                state: Arc::clone(&handle.state),
                input_guard: Arc::clone(&handle.input_guard),
                pending_input: Arc::clone(&handle.pending_input),
                writing_since: Arc::clone(&handle.writing_since),
                child_pid: handle.child_pid,
            })
            .ok_or_else(|| format!("unknown terminal {id}"))
    }

    /// The one entry point for everything typed into a terminal.
    ///
    /// The guard keeps concurrent callers from interleaving their bytes. The
    /// check under it is the escape hatch for a terminal that has stopped
    /// reading: the Ctrl+C the user just pressed could only ever queue behind
    /// the write that is stuck, so it is escalated to the control thread —
    /// the one thread a blocked PTY cannot reach.
    fn deliver_input(&self, id: &str, data: Vec<u8>) -> Result<(), String> {
        let handle = self.handle(id)?;
        let _guard = lock_recover(&handle.input_guard);
        if is_interrupt(&data) {
            if write_in_flight_ms(&handle.writing_since) >= STUCK_WRITE_MS {
                handle
                    .control_tx
                    .send(ControlCommand::Interrupt)
                    .map_err(|_| format!("terminal {id} actor stopped"))?;
                // Reported as an error on purpose: the keystroke did not
                // reach the child (nothing can, in this state), and the
                // widget prints this, so the user learns why the terminal
                // went quiet and what was done about it instead of typing
                // into a void.
                return Err(format!(
                    "terminal {id} is not reading input; stopped what it was running"
                ));
            }
            // Backed up but still moving: the interrupt takes its turn behind
            // the input already queued, and is never refused for want of
            // queue space. The cap is there to bound bulk input, and one
            // keystroke — this keystroke above all — is not that.
            return push_input(id, &handle, data);
        }
        enqueue_input(id, &handle, data)
    }
}

/// Hand input to the terminal's writer thread without waiting for the write
/// to complete.
///
/// Waiting here used to stall the caller for up to a second per keystroke,
/// and the engine's command loop is a caller: a single shell that was slow to
/// read its input froze input *and* output for every terminal in the app,
/// which looked exactly like a hung session that only closing could fix. The
/// channel already guarantees ordering, so the only thing the wait bought was
/// error reporting — and a write that genuinely fails means the session is
/// gone, which the actor now reports as an exit instead.
fn enqueue_input(id: &str, handle: &TerminalHandle, data: Vec<u8>) -> Result<(), String> {
    // A single write that has been in flight this long means the child has
    // stopped draining its stdin. Accepting more input behind it would report
    // success for bytes that may never be delivered — the exact silence that
    // made a wedged terminal look alive until the widget was closed.
    if write_in_flight_ms(&handle.writing_since) >= STUCK_WRITE_MS {
        return Err(format!("terminal {id} is not reading input"));
    }
    let queued = handle.pending_input.load(Ordering::Acquire);
    if queued.saturating_add(data.len()) > MAX_PENDING_INPUT_BYTES {
        return Err(format!("terminal {id} is not reading input"));
    }
    push_input(id, handle, data)
}

/// Hand bytes to the writer thread. No capacity check: callers decide whether
/// this payload is allowed past the queue cap.
fn push_input(id: &str, handle: &TerminalHandle, data: Vec<u8>) -> Result<(), String> {
    push_terminal_input(id, handle, TerminalInput { data, press_enter: false, acknowledgement: None })
}

fn push_terminal_input(id: &str, handle: &TerminalHandle, input: TerminalInput) -> Result<(), String> {
    let len = input.data.len() + usize::from(input.press_enter);
    handle.pending_input.fetch_add(len, Ordering::AcqRel);
    handle.input_tx.send(input).map_err(|_| {
        // The writer thread is gone, so nothing will ever drain this. Undo
        // the reservation or the terminal would look permanently backed up.
        handle.pending_input.fetch_sub(len, Ordering::AcqRel);
        format!("terminal {id} actor stopped")
    })
}

/// True for the Ctrl+C keystroke itself, not for bulk input that happens to
/// carry the byte somewhere inside it.
fn is_interrupt(data: &[u8]) -> bool {
    data.len() <= MAX_INTERRUPT_INPUT_BYTES && data.contains(&INTERRUPT_BYTE)
}

/// The one thread that writes into a PTY.
///
/// Everything here is allowed to block. `write_all` into ConPTY (and into a
/// unix pty master) parks for as long as the child refuses to drain its
/// stdin, with no timeout available at this layer — which is exactly why it
/// gets a thread to itself. The control thread stays free to resize, kill or
/// interrupt the session while this one is parked, so a child that stopped
/// reading no longer takes the whole terminal down with it.
fn run_writer(
    mut writer: Box<dyn Write + Send>,
    rx: mpsc::Receiver<TerminalInput>,
    control_tx: mpsc::Sender<ControlCommand>,
    pending_input: Arc<AtomicUsize>,
    writing_since: Arc<AtomicU64>,
    id: String,
) {
    let mut last_bulk_write: Option<Instant> = None;
    while let Ok(input) = rx.recv() {
        // Published before the write and cleared after it: this is what lets
        // `enqueue_input` tell "busy for a moment" from "stopped reading",
        // and reject new input on the spot instead of queueing it behind
        // bytes that may never be delivered.
        writing_since.store(now_millis_u64(), Ordering::Release);
        // Electron sends text and Enter as separate raw requests. A slow
        // writer can receive both at once despite the caller's own delay.
        if input.data == b"\r" {
            if let Some(last) = last_bulk_write {
                thread::sleep(SUBMIT_GAP.saturating_sub(last.elapsed()));
            }
        }
        let result = writer.write_all(&input.data).and_then(|_| writer.flush()).and_then(|_| {
            if input.press_enter {
                // Delay at the actual writer, after the paste has drained, not
                // at the caller where a backed-up queue can erase the gap.
                thread::sleep(SUBMIT_GAP);
                writer.write_all(b"\r")?;
                writer.flush()?;
            }
            Ok(())
        });
        last_bulk_write = if input.data.len() > 1 && !input.press_enter {
            Some(Instant::now())
        } else {
            None
        };
        writing_since.store(0, Ordering::Release);
        pending_input.fetch_sub(input.data.len() + usize::from(input.press_enter), Ordering::AcqRel);
        if let Some(ack) = input.acknowledgement {
            let _ = ack.send(result.as_ref().map(|_| ()).map_err(|error| format!("write terminal {id}: {error}")));
        }
        if let Err(error) = result {
            // A PTY whose writer is broken cannot be typed into again. The
            // control thread turns this into the same teardown a dispose
            // gets, so the widget shows an exit instead of silently
            // swallowing every keystroke.
            eprintln!("write terminal {id}: {error}");
            let _ = control_tx.send(ControlCommand::WriterFailed);
            break;
        }
    }
    // Whatever is still queued will never be written.
    pending_input.store(0, Ordering::Release);
    writing_since.store(0, Ordering::Release);
}

/// A terminal's control thread: resize, interrupt, dispose.
///
/// It owns the master and the child handle but never the writer, so none of
/// these can end up queued behind a write the child is not reading. That
/// queueing is what left closing the widget as the only way out of a wedged
/// terminal.
#[allow(clippy::too_many_arguments)]
fn run_actor(
    master: Box<dyn MasterPty + Send>,
    mut child: Box<dyn Child + Send + Sync>,
    child_pid: Option<u32>,
    rx: mpsc::Receiver<ControlCommand>,
    state: Arc<Mutex<TerminalState>>,
    inner: Weak<Inner>,
    pending_input: Arc<AtomicUsize>,
    id: String,
) {
    let mut disposed = false;
    while let Ok(command) = rx.recv() {
        match command {
            ControlCommand::Resize { cols, rows } => {
                if let Err(error) = master.resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                }) {
                    // Geometry is cosmetic: never end a session over it.
                    eprintln!("resize terminal {id}: {error}");
                }
            }
            ControlCommand::Interrupt => {
                // Reached only when the child has stopped reading its stdin,
                // so the \x03 the user typed cannot be delivered at all.
                // What the terminal is running is stopped directly instead;
                // the shell itself is deliberately left alive, because
                // closing the widget was the only way out before and that
                // took the whole session with it.
                if let Some(pid) = child_pid {
                    interrupt_process_tree(pid);
                }
            }
            ControlCommand::Dispose => {
                // Tree-kill first: the direct child's own exit does not stop
                // grandchildren (agents, dev servers), which would otherwise
                // keep running headless after the widget is closed.
                if let Some(pid) = child_pid {
                    kill_process_tree(pid);
                }
                let _ = child.kill();
                let _ = child.wait();
                disposed = true;
                break;
            }
            ControlCommand::WriterFailed => break,
        }
    }
    // ClosePseudoConsole may wait for its processes. Stop them before dropping
    // the master, including on a broken writer rather than explicit disposal.
    if !disposed {
        if let Some(pid) = child_pid { kill_process_tree(pid); }
        let _ = child.kill();
    }
    // Closes the PTY, which ends the reader thread and releases the writer
    // thread if it is still parked inside a write.
    drop(master);
    pending_input.store(0, Ordering::Release);
    lock_recover(&state).alive = false;
    if !disposed {
        // The reader thread announces the ordinary end of a session, but it
        // only notices once the PTY reaches EOF. When the actor stops first
        // (broken writer, dropped handle) nothing else would ever tell the
        // app, and the widget would sit there accepting input that goes
        // nowhere. Duplicate exits are harmless — consumers ignore the second.
        if let Some(inner) = inner.upgrade() {
            push_event(&inner, TerminalEvent::Exited { id });
        }
    }
}

fn push_event(inner: &Arc<Inner>, event: TerminalEvent) {
    let mut queue = lock_recover(&inner.events);
    queue.bytes = queue.bytes.saturating_add(event_bytes(&event));
    queue.items.push_back(event);
    // Exit events are never dropped: losing one strands a widget on a session
    // that already ended. Only stale output goes, oldest first.
    while queue.bytes > MAX_PENDING_EVENT_BYTES {
        let outputs: Vec<usize> = queue
            .items
            .iter()
            .enumerate()
            .filter(|(_, item)| matches!(item, TerminalEvent::Output { .. }))
            .map(|(index, _)| index)
            .take(2)
            .collect();
        // Stop at the last remaining chunk — dropping it would throw away the
        // newest output too and leave the widget with nothing at all. It is
        // trimmed to the budget instead, just below.
        if outputs.len() < 2 {
            break;
        }
        let Some(dropped) = queue.items.remove(outputs[0]) else {
            break;
        };
        queue.bytes = queue.bytes.saturating_sub(event_bytes(&dropped));
        if let TerminalEvent::Output { id, .. } = &dropped {
            queue.dropped.insert(id.clone());
        }
    }
    if queue.bytes > MAX_PENDING_EVENT_BYTES {
        let mut shrunk = None;
        for item in &mut queue.items {
            if let TerminalEvent::Output { id, data } = item {
                keep_tail(data, MAX_PENDING_EVENT_BYTES);
                shrunk = Some((id.clone(), data.len()));
                break;
            }
        }
        if let Some((id, len)) = shrunk {
            queue.bytes = len;
            queue.dropped.insert(id);
        }
    }
    inner.events_ready.notify_all();
}

/// Shrink `data` in place to at most `max_bytes`, keeping the newest bytes and
/// never cutting a UTF-8 character in half.
fn keep_tail(data: &mut String, max_bytes: usize) {
    if data.len() <= max_bytes {
        return;
    }
    let mut cut = data.len() - max_bytes;
    while cut < data.len() && !data.is_char_boundary(cut) {
        cut += 1;
    }
    data.drain(..cut);
}

fn take_events(queue: &mut EventQueue) -> Vec<TerminalEvent> {
    let mut events: Vec<TerminalEvent> = queue.items.drain(..).collect();
    queue.bytes = 0;
    if !queue.dropped.is_empty() {
        let mut pending = std::mem::take(&mut queue.dropped);
        for event in events.iter_mut() {
            if pending.is_empty() {
                break;
            }
            if let TerminalEvent::Output { id, data } = event {
                // `remove` only matches once per id, so a second Output
                // event for the same terminal later in this same batch is
                // left alone — one drop gets one reset.
                if pending.remove(id.as_str()) {
                    data.insert_str(0, RESYNC_PREFIX);
                }
            }
        }
        // An id with no Output event in this batch at all (the terminal
        // went quiet right after losing data) stays pending so the next
        // batch that does carry its output still gets the reset, instead of
        // the signal being silently discarded here.
        queue.dropped = pending;
    }
    events
}

fn event_bytes(event: &TerminalEvent) -> usize {
    match event {
        TerminalEvent::Output { data, .. } => data.len(),
        TerminalEvent::Exited { .. } => 0,
    }
}

/// Best-effort termination of a shell and everything it spawned. Returns
/// true when the OS accepted the request. Never panics, never blocks the
/// caller beyond the OS call itself.
fn kill_process_tree(pid: u32) -> bool {
    // 0 means "my own process group" to kill(2) and "the current process" to
    // parts of the Win32 API. Never let one through: the engine would be
    // taking itself, and every terminal it owns, down with it.
    if pid == 0 {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        /// The engine itself runs without a console, so Windows hands any
        /// console-subsystem child it starts a brand-new console window.
        /// Without this flag `taskkill` flashes a black window on screen
        /// every single time a terminal widget is closed.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        // portable-pty puts the shell in its own session (setsid, so the slave
        // can become the controlling terminal), which makes the shell's pid
        // its process-group id too — a negative pid therefore reaps every
        // descendant. This used to do nothing at all, leaving the actor's
        // `child.kill()` to take down the direct child only: agents, dev
        // servers and other grandchildren kept running headless after the
        // widget was closed, which is precisely what the Windows branch above
        // goes out of its way to prevent.
        let Ok(pid) = i32::try_from(pid) else {
            return false;
        };
        // SAFETY: kill(2) is async-signal-safe and only reports errors through
        // its return value; `pid` is non-zero and positive, so neither the
        // "own process group" nor the "every process" target can be selected.
        if unsafe { libc::kill(-pid, libc::SIGKILL) } == 0 {
            return true;
        }
        // Not a group leader, or the group is already gone: at least make sure
        // the shell itself is down.
        unsafe { libc::kill(pid, libc::SIGKILL) == 0 }
    }
}

/// Milliseconds the writer thread has spent inside one write, or 0 when it
/// is not writing at all.
fn write_in_flight_ms(writing_since: &AtomicU64) -> u64 {
    let started = writing_since.load(Ordering::Acquire);
    if started == 0 {
        return 0;
    }
    // Saturating: a clock stepped backwards reads as "not stuck", which is
    // the safe direction — input keeps flowing instead of being refused.
    now_millis_u64().saturating_sub(started)
}

fn now_millis_u64() -> u64 {
    u64::try_from(now_millis()).unwrap_or(u64::MAX)
}

/// Stop what a wedged terminal is running, without ending the session.
///
/// Called when the user pressed Ctrl+C on a terminal whose input is no longer
/// being read, so the keystroke itself can never arrive. The shell survives:
/// the point is to leave the user with a working terminal instead of the
/// close-the-widget-and-lose-everything they had before.
fn interrupt_process_tree(pid: u32) -> bool {
    // 0 means "my own process group" to kill(2) and "the current process" to
    // parts of the Win32 API — never let one through.
    if pid == 0 {
        return false;
    }
    #[cfg(windows)]
    {
        // Windows cannot signal a process attached to someone else's
        // pseudoconsole, so the foreground program is terminated instead,
        // which is what Ctrl+C on an unresponsive terminal is asking for.
        // Only the shell's children go; the shell itself stays.
        let mut stopped = false;
        for child in direct_children(pid) {
            stopped |= kill_process_tree(child);
        }
        stopped
    }
    #[cfg(not(windows))]
    {
        let Ok(pid) = i32::try_from(pid) else {
            return false;
        };
        // SAFETY: kill(2) is async-signal-safe and reports errors through its
        // return value only; the pid is positive and non-zero, so neither the
        // "own process group" nor the "every process" target can be selected.
        // portable-pty puts the shell in its own session, so the negated pid
        // addresses that group: the shell ignores SIGINT as any interactive
        // shell does, and the job it is running takes it.
        unsafe { libc::kill(-pid, libc::SIGINT) == 0 }
    }
}

/// Direct children of `pid`, as the OS sees them right now.
///
/// Safe to key off the parent id because the engine holds an open handle to
/// the shell, which stops Windows from recycling its pid while it runs.
#[cfg(windows)]
fn direct_children(pid: u32) -> Vec<u32> {
    use winapi::um::handleapi::{CloseHandle, INVALID_HANDLE_VALUE};
    use winapi::um::tlhelp32::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let mut children = Vec::new();
    // SAFETY: the snapshot handle is checked against INVALID_HANDLE_VALUE
    // before use and closed on every path out; `entry` is zeroed with the
    // dwSize the API requires, and both walk calls only write into it.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return children;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                if entry.th32ParentProcessID == pid && entry.th32ProcessID != 0 {
                    children.push(entry.th32ProcessID);
                }
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
    }
    children
}

fn read_output(
    mut reader: Box<dyn Read + Send>,
    state: Arc<Mutex<TerminalState>>,
    inner: Arc<Inner>,
    id: String,
) {
    let mut buffer = [0_u8; 16 * 1024];
    let mut decoder = Utf8Stream::default();
    loop {
        let count = match reader.read(&mut buffer) {
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Ok(0) | Err(_) => 0,
            Ok(count) => count,
        };
        let data = decoder.decode(&buffer[..count], count == 0);
        if data.is_empty() {
            if count == 0 { break; }
            continue;
        }
        {
            let mut current = lock_recover(&state);
            current.output.push_str(&data);
            if current.output.len() > MAX_SCROLLBACK + SCROLLBACK_SLACK {
                let mut cut = current.output.len() - MAX_SCROLLBACK;
                while !current.output.is_char_boundary(cut) { cut += 1; }
                let boundary = current.output[cut..]
                    .find('\n')
                    .map(|offset| cut + offset + 1)
                    .unwrap_or(cut);
                current.output.drain(..boundary);
            }
        }
        push_event(
            &inner,
            TerminalEvent::Output {
                id: id.clone(),
                data,
            },
        );
        if count == 0 { break; }
    }
    lock_recover(&state).alive = false;
    push_event(&inner, TerminalEvent::Exited { id });
}

#[derive(Default)]
struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    fn decode(&mut self, bytes: &[u8], eof: bool) -> String {
        self.pending.extend_from_slice(bytes);
        let mut text = String::new();
        let mut offset = 0;
        while offset < self.pending.len() {
            match std::str::from_utf8(&self.pending[offset..]) {
                Ok(valid) => {
                    text.push_str(valid);
                    offset = self.pending.len();
                }
                Err(error) => {
                    let end = offset + error.valid_up_to();
                    text.push_str(std::str::from_utf8(&self.pending[offset..end]).unwrap());
                    offset = end;
                    if let Some(invalid) = error.error_len() {
                        text.push('\u{fffd}');
                        offset += invalid;
                    } else {
                        if eof {
                            text.push('\u{fffd}');
                            offset = self.pending.len();
                        }
                        break;
                    }
                }
            }
        }
        self.pending.drain(..offset);
        text
    }
}

/// Startup arguments for Windows shells.
/// Empty everywhere else.
///
/// ConPTY defaults a new console to the system's legacy OEM codepage (866 or
/// 1251 on a Russian install), not UTF-8. Every env var set alongside
/// (`LANG`, `LC_ALL`, `TERM`, `COLORTERM`) declares UTF-8 intent, but Windows
/// console apps mostly ignore those — they take their encoding from the
/// console. Left at the OEM default, a child that prints non-ASCII text
/// (Cyrillic, in the reported case) writes bytes xterm.js cannot parse as
/// UTF-8, rendering as a wall of replacement characters that reads as a
/// frozen or broken terminal even though the process is running fine.
///
/// cmd.exe intentionally receives no setup command so it opens directly on
/// its first prompt row. PowerShell keeps its non-printing UTF-8 setup.
fn windows_utf8_shell_args(shell: &str) -> Vec<&'static str> {
    #[cfg(windows)]
    {
        let lower = shell.to_ascii_lowercase();
        if lower.contains("powershell") || lower.contains("pwsh") {
            vec!["-NoLogo", "-NoExit", "-Command", "chcp 65001 > $null"]
        } else {
            vec!["/K"]
        }
    }
    #[cfg(not(windows))]
    {
        let _ = shell;
        Vec::new()
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
    socket_path: String,
}

impl ControlServer {
    /// Starts the control server on a named pipe (Windows) or unix domain
    /// socket, never on a TCP port.
    ///
    /// This matches what the Electron app does, and the reason is not
    /// aesthetic: no port is occupied so nothing can collide, access is
    /// governed by the operating system's permissions on the pipe rather than
    /// by "we only bound to loopback", and the command bus is not reachable
    /// from the network even in principle. `orc` finds either implementation at
    /// the same path without being told which is running.
    pub fn start(manager: TerminalManager, token: String) -> Result<Self, String> {
        let storage = orcspace_app::ipc::user_data_dir().join("orchestration.json");
        Self::start_at_with_storage(
            manager,
            token,
            orcspace_app::listener::default_path(),
            storage,
        )
    }

    /// Starts on an explicit path. A test — or a second instance — uses this to
    /// stay off the real socket.
    pub fn start_at(
        manager: TerminalManager,
        token: String,
        path: String,
    ) -> Result<Self, String> {
        let storage = PathBuf::from(format!("{path}.orchestration.json"));
        Self::start_at_with_storage(manager, token, path, storage)
    }

    fn start_at_with_storage(
        manager: TerminalManager,
        token: String,
        path: String,
        orchestration_file: PathBuf,
    ) -> Result<Self, String> {
        let state = HttpState {
            manager,
            token,
            orchestration: Arc::new(Mutex::new(load_orchestration(&orchestration_file))),
            orchestration_file,
            rate_limiter: Arc::new(Mutex::new(ActorRateLimiter::default())),
        };

        // The listener is opened on this thread, before the server thread is
        // spawned, so a name already in use is reported to the caller rather
        // than printed into the void from a background thread.
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        let listen_path = path.clone();

        thread::Builder::new()
            .name("orcspace-control-server".to_owned())
            .spawn(move || {
                let runtime = match tokio::runtime::Runtime::new() {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        let _ = ready_tx.send(Err(format!("control server runtime: {error}")));
                        return;
                    }
                };
                runtime.block_on(async move {
                    let listener = match orcspace_app::listener::bind(&listen_path).await {
                        Ok(listener) => listener,
                        Err(error) => {
                            let _ = ready_tx
                                .send(Err(format!("bind control server at {listen_path}: {error}")));
                            return;
                        }
                    };
                    let _ = ready_tx.send(Ok(()));

                    let app = Router::new()
                        .route("/orchestration/workers", get(list_workers))
                        .route("/orchestration/workers/tell", post(tell_worker))
                        .route("/terminal/{id}/write", post(write_terminal))
                        .route("/terminal/{id}/output", get(read_terminal_output))
                        // Everything the ported router knows is served here, so
                        // adding a domain to `http::route` serves it without
                        // touching this file. The four routes above stay
                        // explicit because they reach the terminal manager,
                        // which the pure router deliberately does not see.
                        .fallback(handle_routed)
                        .layer(DefaultBodyLimit::max(MAX_HTTP_BODY_BYTES))
                        .with_state(state);
                    if let Err(error) = axum::serve(listener, app).await {
                        eprintln!("control server stopped: {error}");
                    }
                });
            })
            .map_err(|error| format!("spawn control server: {error}"))?;

        ready_rx
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| "control server did not start".to_owned())??;

        Ok(Self { socket_path: path })
    }

    /// The pipe or socket path the server is listening on. Not an http address:
    /// there is no port, by design.
    pub fn socket_path(&self) -> String {
        self.socket_path.clone()
    }
}

fn load_orchestration(path: &FsPath) -> orcspace_app::orchestration::OrchestrationStore {
    let Ok(bytes) = fs::read(path) else {
        return orcspace_app::orchestration::OrchestrationStore::new();
    };
    match serde_json::from_slice::<serde_json::Value>(&bytes) {
        Ok(value) if value.is_object() => {
            orcspace_app::orchestration::OrchestrationStore::load(&value)
        }
        Ok(_) | Err(_) => {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let corrupt = PathBuf::from(format!("{}.corrupt-{stamp}", path.display()));
            let _ = fs::rename(path, corrupt);
            orcspace_app::orchestration::OrchestrationStore::new()
        }
    }
}

fn persist_orchestration(
    path: &FsPath,
    store: &orcspace_app::orchestration::OrchestrationStore,
) -> std::io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| FsPath::new("."));
    fs::create_dir_all(parent)?;
    let temp = parent.join(format!(
        ".orchestration-{}-{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    let result = (|| {
        let data = serde_json::to_vec_pretty(&store.to_json())
            .map_err(std::io::Error::other)?;
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temp)?;
        file.write_all(&data)?;
        file.sync_all()?;
        drop(file);
        #[cfg(windows)]
        {
            let _ = fs::remove_file(path);
        }
        fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[derive(Clone)]
struct HttpState {
    manager: TerminalManager,
    token: String,
    /// Shared because the fallback handler mutates it and axum hands each
    /// request its own clone of the state.
    orchestration: Arc<Mutex<orcspace_app::orchestration::OrchestrationStore>>,
    orchestration_file: PathBuf,
    rate_limiter: Arc<Mutex<ActorRateLimiter>>,
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
    #[serde(rename = "agentId")]
    agent_id: Option<String>,
}

#[derive(Deserialize)]
struct WriteRequest {
    #[serde(alias = "command", alias = "input", alias = "content")]
    text: Option<String>,
    #[serde(rename = "pressEnter", default = "default_true")]
    press_enter: bool,
    #[serde(rename = "agentId")]
    agent_id: Option<String>,
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
    check_rate_limit(&state, &headers, None)?;
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
    check_rate_limit(&state, &headers, request.agent_id.as_deref())?;
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
    check_rate_limit(&state, &headers, request.agent_id.as_deref())?;
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

#[derive(Serialize)]
struct OutputResponse {
    output: String,
}

async fn read_terminal_output(
    State(state): State<HttpState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<OutputResponse>, (StatusCode, String)> {
    authenticate(&headers, &state.token)?;
    check_rate_limit(&state, &headers, None)?;
    let snapshot = state
        .manager
        .snapshot(&id)
        .map_err(|error| (StatusCode::NOT_FOUND, error))?;
    Ok(Json(OutputResponse {
        output: snapshot.output,
    }))
}

/// Bridges the pure router to axum: authenticate, translate, answer.
///
/// The authorization check happens here, once, before anything is routed —
/// exactly as `isTrustedCaller` gates `route()` in the TypeScript. The router
/// itself never sees a token, so no route can forget to check one.
async fn handle_routed(
    State(state): State<HttpState>,
    headers: HeaderMap,
    method: axum::http::Method,
    uri: axum::http::Uri,
    body: axum::body::Bytes,
) -> (StatusCode, Json<serde_json::Value>) {
    if authenticate(&headers, &state.token).is_err() {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "a valid control token is required" })),
        );
    }

    let mut query = indexmap::IndexMap::new();
    for pair in uri.query().unwrap_or_default().split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        query.insert(key.to_owned(), percent_decode_query(value));
    }

    let parsed_body = if body.is_empty() {
        serde_json::json!({})
    } else {
        match serde_json::from_slice::<serde_json::Value>(&body) {
            Ok(value) if value.is_object() => value,
            Ok(_) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "error": "request body must be a JSON object",
                        "code": "invalid"
                    })),
                );
            }
            Err(_) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "error": "request body must be valid JSON",
                        "code": "invalid"
                    })),
                );
            }
        }
    };
    let agent_id = headers
        .get("x-agent-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
        .or_else(|| query.get("agentId").cloned())
        .or_else(|| parsed_body.get("agentId").and_then(|value| value.as_str()).map(str::to_owned));
    if let Err((status, error)) = check_rate_limit(&state, &headers, agent_id.as_deref()) {
        return (
            status,
            Json(serde_json::json!({ "error": error, "code": "rate_limited" })),
        );
    }

    let request = orcspace_app::http::Request {
        method: method.as_str().to_owned(),
        path: uri.path().to_owned(),
        query,
        // A body that is absent or unparseable is null, which every route
        // treats as "no fields given" rather than as an error — the same as a
        // GET with no body at all.
        body: parsed_body,
        agent_id,
    };

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let mut store = lock_recover(&state.orchestration);
    let mut deps = orcspace_app::http::RouteDeps {
        orchestration: &mut store,
        app_version: env!("CARGO_PKG_VERSION"),
        workspace_dir: None,
        now,
    };

    match orcspace_app::http::route(&request, &mut deps) {
        Some(response) => {
            if method != axum::http::Method::GET.as_str() && response.status < 400 {
                if let Err(error) = persist_orchestration(&state.orchestration_file, &store) {
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({
                            "error": format!("failed to persist orchestration: {error}"),
                            "code": "failed"
                        })),
                    );
                }
            }
            (
                StatusCode::from_u16(response.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
                Json(response.body),
            )
        }
        None => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "no such route", "code": "not_found" })),
        ),
    }
}

/// Query values arrive percent-encoded, with `+` for a space.
fn percent_decode_query(raw: &str) -> String {
    let bytes = raw.replace('+', " ").into_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) =
                u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16)
            {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn check_rate_limit(
    state: &HttpState,
    headers: &HeaderMap,
    hint: Option<&str>,
) -> Result<(), (StatusCode, String)> {
    let header = headers.get("x-agent-id").and_then(|value| value.to_str().ok());
    let raw = hint.filter(|value| !value.trim().is_empty()).or(header).unwrap_or("api").trim();
    let key = raw
        .char_indices()
        .nth(128)
        .map(|(index, _)| &raw[..index])
        .unwrap_or(raw);
    let now = now_millis().min(i64::MAX as u128) as i64;
    if lock_recover(&state.rate_limiter).try_consume(key, 1.0, now) {
        Ok(())
    } else {
        Err((StatusCode::TOO_MANY_REQUESTS, "too many requests".to_owned()))
    }
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
    use super::{
        encode_terminal_input, take_events, windows_utf8_shell_args, EventQueue, TerminalEvent,
        WriteRequest, MAX_PENDING_EVENT_BYTES, RESYNC_PREFIX,
    };
    use serde_json::json;
    use std::sync::atomic::AtomicU64;
    use std::sync::Arc;

    #[test]
    fn line_normalization_rejects_space_only_messages() {
        assert!(encode_terminal_input("   ", true).is_err());
        assert_eq!(encode_terminal_input("a\r\nb", true).unwrap(), b"a  b\r");
        assert_eq!(encode_terminal_input("a", false).unwrap(), b"a");
    }

    #[cfg(windows)]
    #[test]
    fn cmd_starts_without_setup_args() {
        // cmd.exe receives no startup command, keeping its prompt on row one.
        let cmd = windows_utf8_shell_args(r"C:\Windows\System32\cmd.exe");
        assert_eq!(cmd, vec!["/K"], "cmd.exe must open directly on its first prompt row");

        let ps = windows_utf8_shell_args(r"C:\...\WindowsPowerShell\v1.0\powershell.exe");
        assert!(
            ps.contains(&"-NoExit"),
            "must keep the PowerShell session interactive"
        );
        assert!(ps.iter().any(|arg| arg.contains("65001")));
        // Nothing may end with a carriage return: these are argv entries, not
        // keystrokes typed into a running shell.
        for arg in cmd.iter().chain(ps.iter()) {
            assert!(!arg.contains('\r'), "argv entry must not carry an Enter: {arg}");
        }
    }

    #[test]
    fn write_request_defaults_to_enter_and_accepts_camel_case() {
        let defaulted: WriteRequest = serde_json::from_value(json!({"text": "run"})).unwrap();
        assert!(defaulted.press_enter);
        let raw: WriteRequest =
            serde_json::from_value(json!({"text": "run", "pressEnter": false})).unwrap();
        assert!(!raw.press_enter);
    }

    fn output(id: &str, data: &str) -> TerminalEvent {
        TerminalEvent::Output {
            id: id.to_owned(),
            data: data.to_owned(),
        }
    }

    #[test]
    fn unicode_scrollback_overflow_does_not_kill_the_reader() {
        let manager = super::TerminalManager::new("test".to_owned());
        let state = Arc::new(std::sync::Mutex::new(super::TerminalState {
            output: "я".repeat(super::MAX_SCROLLBACK / 2), alive: true,
            ..Default::default()
        }));
        // Enough to cross the slack so the compaction actually runs: that is
        // the path where the cut lands inside a two-byte char and used to be
        // able to kill the reader.
        let overflow = vec![b'x'; super::SCROLLBACK_SLACK + 1];
        super::read_output(Box::new(std::io::Cursor::new(overflow)), Arc::clone(&state),
            Arc::clone(&manager.inner), "test".to_owned());
        let state = state.lock().unwrap();
        assert!(state.output.len() < super::MAX_SCROLLBACK + super::SCROLLBACK_SLACK,
            "the buffer must actually have been compacted");
        assert!(!state.alive);
    }

    #[test]
    fn utf8_split_across_reads_is_preserved_and_invalid_input_is_bounded() {
        let mut decoder = super::Utf8Stream::default();
        let expected = "Привет 🌍 世界";
        let mut actual = String::new();
        for byte in expected.as_bytes() {
            actual.push_str(&decoder.decode(&[*byte], false));
            assert!(decoder.pending.len() <= 3);
        }
        actual.push_str(&decoder.decode(&[], true));
        assert_eq!(actual, expected);
        assert_eq!(decoder.decode(&[0xff, 0xe2], false), "\u{fffd}");
        assert_eq!(decoder.decode(&[], true), "\u{fffd}");
        assert!(decoder.pending.is_empty());
    }

    #[test]
    fn output_pressure_drops_old_output_but_never_an_exit() {
        let inner = Arc::new(super::Inner {
            terminals: std::sync::Mutex::new(std::collections::HashMap::new()),
            events: std::sync::Mutex::new(EventQueue::default()),
            events_ready: std::sync::Condvar::new(),
            token: "t".to_owned(),
            control_socket: std::sync::Mutex::new(None),
        });

        super::push_event(&inner, output("term-1", "oldest"));
        super::push_event(
            &inner,
            TerminalEvent::Exited {
                id: "term-1".to_owned(),
            },
        );
        super::push_event(
            &inner,
            output("term-1", &"x".repeat(MAX_PENDING_EVENT_BYTES + 1)),
        );

        let mut queue = inner.events.lock().unwrap();
        let events = take_events(&mut queue);
        assert!(
            events
                .iter()
                .any(|event| matches!(event, TerminalEvent::Exited { .. })),
            "an exit event must survive output pressure"
        );
        let outputs: Vec<&String> = events
            .iter()
            .filter_map(|event| match event {
                TerminalEvent::Output { data, .. } => Some(data),
                _ => None,
            })
            .collect();
        assert_eq!(outputs.len(), 1, "the stale chunk should have been dropped");
        assert!(
            outputs[0].starts_with(RESYNC_PREFIX),
            "a drop must be followed by a resync reset"
        );
    }

    #[test]
    fn resync_reset_targets_only_the_terminal_that_actually_dropped_output() {
        // Terminal B loses output to pressure; terminal A did not. The reset
        // must land on B's next chunk, not A's — a shared flag used to hand
        // it to whichever terminal's Output event happened to come first.
        let mut queue = EventQueue::default();
        queue.dropped.insert("term-b".to_owned());
        queue.items.push_back(output("term-a", "unaffected"));
        queue.items.push_back(output("term-b", "resumed"));

        let events = take_events(&mut queue);
        let by_id = |id: &str| -> &String {
            events
                .iter()
                .find_map(|event| match event {
                    TerminalEvent::Output { id: eid, data } if eid == id => Some(data),
                    _ => None,
                })
                .unwrap()
        };
        assert_eq!(by_id("term-a"), "unaffected", "an unrelated terminal must not gain a reset");
        assert!(
            by_id("term-b").starts_with(RESYNC_PREFIX),
            "the terminal that actually dropped output must get the reset"
        );
        assert!(queue.dropped.is_empty(), "the pending drop is consumed once applied");
    }

    #[test]
    fn resync_reset_stays_pending_until_the_affected_terminal_produces_output() {
        // The affected terminal went quiet right after losing data: this
        // batch carries no Output event for it at all. The signal must
        // survive to the next drain instead of being silently discarded.
        let mut queue = EventQueue::default();
        queue.dropped.insert("term-b".to_owned());
        queue.items.push_back(output("term-a", "unrelated"));

        let first = take_events(&mut queue);
        assert_eq!(first.len(), 1);
        assert!(
            queue.dropped.contains("term-b"),
            "the pending reset for term-b must survive a batch that never mentions it"
        );

        queue.items.push_back(output("term-b", "finally back"));
        let second = take_events(&mut queue);
        let TerminalEvent::Output { data, .. } = &second[0] else {
            panic!("expected an Output event");
        };
        assert!(data.starts_with(RESYNC_PREFIX));
    }

    #[test]
    fn draining_without_drops_leaves_output_untouched() {
        let mut queue = EventQueue::default();
        queue.items.push_back(output("term-1", "hello"));
        let events = take_events(&mut queue);
        assert_eq!(events.len(), 1);
        assert!(matches!(&events[0], TerminalEvent::Output { data, .. } if data == "hello"));
        assert_eq!(queue.bytes, 0);
    }

    #[test]
    fn an_idle_writer_never_reads_as_stuck() {
        // 0 is the idle marker, not a timestamp from 1970: reading it as one
        // would refuse every keystroke on a perfectly healthy terminal.
        let idle = AtomicU64::new(0);
        assert_eq!(super::write_in_flight_ms(&idle), 0);
    }

    #[test]
    fn message_enter_is_separate_and_acknowledged_after_flush() {
        use std::io::Write;
        use std::sync::{mpsc, Arc, Mutex, atomic::AtomicUsize};
        use std::time::{Duration, Instant};
        struct RecordingWriter(Arc<Mutex<Vec<(Vec<u8>, Instant)>>>);
        impl Write for RecordingWriter {
            fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().push((data.to_vec(), Instant::now()));
                Ok(data.len())
            }
            fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
        }
        let writes = Arc::new(Mutex::new(Vec::new()));
        let (tx, rx) = mpsc::channel();
        let (control_tx, _) = mpsc::channel();
        let (ack_tx, ack_rx) = mpsc::channel();
        let pending = Arc::new(AtomicUsize::new(13));
        tx.send(super::TerminalInput {
            data: b"hello".to_vec(), press_enter: true, acknowledgement: Some(ack_tx),
        }).unwrap();
        tx.send(super::TerminalInput {
            data: b"x".to_vec(), press_enter: false, acknowledgement: None,
        }).unwrap();
        tx.send(super::TerminalInput {
            data: b"world".to_vec(), press_enter: false, acknowledgement: None,
        }).unwrap();
        tx.send(super::TerminalInput {
            data: b"\r".to_vec(), press_enter: false, acknowledgement: None,
        }).unwrap();
        drop(tx);
        let output = Arc::clone(&writes);
        let queued = Arc::clone(&pending);
        let worker = std::thread::spawn(move || super::run_writer(
            Box::new(RecordingWriter(output)), rx, control_tx, queued,
            Arc::new(AtomicU64::new(0)), "test".to_owned(),
        ));
        ack_rx.recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
        assert!(writes.lock().unwrap().iter().any(|(bytes, _)| bytes == b"\r"));
        worker.join().unwrap();
        let writes = writes.lock().unwrap();
        assert_eq!(writes.iter().map(|(bytes, _)| bytes.as_slice()).collect::<Vec<_>>(), vec![b"hello".as_slice(), b"\r", b"x", b"world", b"\r"]);
        assert!(writes[1].1.duration_since(writes[0].1) >= Duration::from_millis(200));
        assert!(writes[4].1.duration_since(writes[3].1) >= Duration::from_millis(200));
        assert_eq!(pending.load(std::sync::atomic::Ordering::Acquire), 0);
    }

    #[test]
    fn failed_submit_is_not_acknowledged_as_success() {
        struct FailedSubmit;
        impl std::io::Write for FailedSubmit {
            fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
                if data == b"\r" { return Err(std::io::Error::other("submit failed")); }
                Ok(data.len())
            }
            fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
        }
        let (tx, rx) = std::sync::mpsc::channel();
        let (control_tx, control_rx) = std::sync::mpsc::channel();
        let (ack_tx, ack_rx) = std::sync::mpsc::channel();
        tx.send(super::TerminalInput {
            data: b"hello".to_vec(), press_enter: true, acknowledgement: Some(ack_tx),
        }).unwrap();
        drop(tx);
        super::run_writer(Box::new(FailedSubmit), rx, control_tx,
            std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(6)),
            std::sync::Arc::new(AtomicU64::new(0)), "test".to_owned());
        assert!(ack_rx.recv().unwrap().unwrap_err().contains("submit failed"));
        assert!(matches!(control_rx.recv().unwrap(), super::ControlCommand::WriterFailed));
    }

    #[test]
    fn a_write_that_never_returns_crosses_the_stuck_threshold() {
        let started = super::now_millis_u64() - super::STUCK_WRITE_MS - 1;
        let stuck = AtomicU64::new(started);
        assert!(super::write_in_flight_ms(&stuck) >= super::STUCK_WRITE_MS);
    }

    #[test]
    fn a_write_that_just_started_is_not_stuck() {
        let fresh = AtomicU64::new(super::now_millis_u64());
        assert!(super::write_in_flight_ms(&fresh) < super::STUCK_WRITE_MS);
    }

    #[test]
    fn a_ctrl_c_keystroke_is_recognised_as_an_interrupt() {
        assert!(super::is_interrupt(b"\x03"));
        assert!(super::is_interrupt(b"\x03\r"));
    }

    #[test]
    fn bulk_input_carrying_the_byte_is_not_an_interrupt() {
        // Otherwise a pasted file with a stray 0x03 in it would let itself
        // past the queue cap, or worse, kill what the terminal is running.
        let mut pasted = vec![b'a'; 4096];
        pasted[2048] = 0x03;
        assert!(!super::is_interrupt(&pasted));
    }

    #[test]
    fn interrupt_refuses_pid_zero() {
        // Same trap as kill_process_tree: 0 would target the engine itself.
        assert!(!super::interrupt_process_tree(0));
    }

    #[test]
    fn kill_process_tree_refuses_pid_zero() {
        // kill(2) reads 0 as "my own process group", so letting one through
        // would have the engine kill itself and every terminal it owns.
        assert!(!super::kill_process_tree(0));
    }

    #[cfg(windows)]
    #[test]
    fn kill_process_tree_on_missing_pid_reports_failure() {
        // Must never panic and must report that nothing was killed. Windows
        // only: on unix this now sends a real signal, and no pid is
        // guaranteed to be free, so a live process could be caught.
        assert!(!super::kill_process_tree(4_194_303));
    }
}

/// End-to-end checks that the control server really answers over the pipe or
/// socket it claims to — not over a port, and not only in the pure router.
#[cfg(test)]
mod transport_tests {
    use super::{ControlServer, TerminalManager, TOKEN_HEADER};
    use std::io::{Read, Write};

    /// A test path, so a run never touches the real OrcSpace socket.
    fn test_path(name: &str) -> String {
        let unique = std::process::id();
        if cfg!(windows) {
            format!(r"\\.\pipe\orcspace-test-{name}-{unique}")
        } else {
            std::env::temp_dir()
                .join(format!("orcspace-test-{name}-{unique}.sock"))
                .to_string_lossy()
                .into_owned()
        }
    }

    /// Minimal HTTP/1.1 over the transport, so the test exercises the real
    /// socket rather than calling the router directly.
    fn request(path_to_socket: &str, method: &str, target: &str, token: &str, body: Option<&str>) -> String {
        let mut stream = open(path_to_socket);
        let body = body.unwrap_or("");
        let request = format!(
            "{method} {target} HTTP/1.1\r\nHost: orcspace\r\n{TOKEN_HEADER}: {token}\r\n\
             Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(request.as_bytes()).expect("write request");
        stream.flush().expect("flush");
        let mut response = Vec::new();
        let _ = stream.read_to_end(&mut response);
        String::from_utf8_lossy(&response).into_owned()
    }

    #[cfg(windows)]
    fn open(path: &str) -> std::fs::File {
        use std::os::windows::fs::OpenOptionsExt;
        // A pipe instance may be momentarily busy between accepts; a short
        // retry is normal client behaviour, not a workaround.
        for _ in 0..40 {
            match std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .attributes(0)
                .open(path)
            {
                Ok(file) => return file,
                Err(_) => std::thread::sleep(std::time::Duration::from_millis(25)),
            }
        }
        panic!("could not open {path}");
    }

    #[cfg(unix)]
    fn open(path: &str) -> std::os::unix::net::UnixStream {
        for _ in 0..40 {
            match std::os::unix::net::UnixStream::connect(path) {
                Ok(stream) => return stream,
                Err(_) => std::thread::sleep(std::time::Duration::from_millis(25)),
            }
        }
        panic!("could not connect to {path}");
    }

    fn body_of(response: &str) -> serde_json::Value {
        let body = response
            .split_once("\r\n\r\n")
            .map(|(_, body)| body)
            .unwrap_or("");
        serde_json::from_str(body.trim()).unwrap_or(serde_json::Value::Null)
    }

    #[test]
    fn the_server_answers_over_the_pipe_and_reports_its_path() {
        let path = test_path("health");
        let manager = TerminalManager::new("token-for-tests-0123456789abcdef".to_owned());
        let server = ControlServer::start_at(manager, "tok".to_owned(), path.clone())
            .expect("server starts");

        // The reported address is the socket path, not an http:// URL — there
        // is no port to report.
        assert_eq!(server.socket_path(), path);
        assert!(
            !server.socket_path().starts_with("http"),
            "got {}",
            server.socket_path()
        );

        let response = request(&path, "GET", "/health", "tok", None);
        assert!(response.starts_with("HTTP/1.1 200"), "got {response}");
        let body = body_of(&response);
        assert_eq!(body["app"], serde_json::json!("orcspace"));
        assert_eq!(body["server"], serde_json::json!("orcspace-control"));
    }

    /// The token is checked once, before routing. A caller without it gets
    /// nothing, not even a 404 that would confirm which routes exist.
    #[test]
    fn a_request_without_the_token_is_refused() {
        let path = test_path("auth");
        let manager = TerminalManager::new("token-for-tests-0123456789abcdef".to_owned());
        let _server = ControlServer::start_at(manager, "right".to_owned(), path.clone())
            .expect("server starts");

        let refused = request(&path, "GET", "/health", "wrong", None);
        assert!(refused.starts_with("HTTP/1.1 401"), "got {refused}");
        assert_eq!(
            body_of(&refused)["error"],
            serde_json::json!("a valid control token is required")
        );
    }

    /// The whole stack: a real socket, the axum adapter, the ported router and
    /// the orchestration store, answering two requests that depend on each
    /// other.
    #[test]
    fn state_persists_across_requests_on_one_server() {
        let path = test_path("state");
        let manager = TerminalManager::new("token-for-tests-0123456789abcdef".to_owned());
        let _server = ControlServer::start_at(manager, "tok".to_owned(), path.clone())
            .expect("server starts");

        let created = request(
            &path,
            "POST",
            "/orchestration/runs",
            "tok",
            Some(r#"{"objective":"ship it"}"#),
        );
        assert!(created.starts_with("HTTP/1.1 201"), "got {created}");
        let run_id = body_of(&created)["data"]["id"].as_str().unwrap().to_owned();

        let listed = request(&path, "GET", "/orchestration/runs", "tok", None);
        assert!(listed.starts_with("HTTP/1.1 200"), "got {listed}");
        let body = body_of(&listed);
        assert_eq!(body["runs"].as_array().unwrap().len(), 1);
        assert_eq!(body["active"]["id"], serde_json::json!(run_id));
    }

    #[test]
    fn an_unknown_route_is_a_404_rather_than_a_hang() {
        let path = test_path("404");
        let manager = TerminalManager::new("token-for-tests-0123456789abcdef".to_owned());
        let _server = ControlServer::start_at(manager, "tok".to_owned(), path.clone())
            .expect("server starts");

        let response = request(&path, "GET", "/nothing/here", "tok", None);
        assert!(response.starts_with("HTTP/1.1 404"), "got {response}");
        assert_eq!(body_of(&response)["code"], serde_json::json!("not_found"));
    }

    #[test]
    fn terminal_output_route_reports_output_or_not_found() {
        let path = test_path("output");
        let manager = TerminalManager::new("token-for-tests-0123456789abcdef".to_owned());
        let _server = ControlServer::start_at(manager, "tok".to_owned(), path.clone())
            .expect("server starts");

        let response = request(&path, "GET", "/terminal/nonexistent/output", "tok", None);
        assert!(response.starts_with("HTTP/1.1 404"), "got {response}");
    }

    /// A second server on a name already in use must fail loudly on the
    /// caller's thread rather than print into the void from a background one.
    #[test]
    fn a_second_server_on_the_same_path_is_refused() {
        let path = test_path("collision");
        let first_manager = TerminalManager::new("token-for-tests-0123456789abcdef".to_owned());
        let _first = ControlServer::start_at(first_manager, "tok".to_owned(), path.clone())
            .expect("the first server starts");

        let second_manager = TerminalManager::new("token-for-tests-0123456789abcdef".to_owned());
        let second = ControlServer::start_at(second_manager, "tok".to_owned(), path.clone());
        assert!(
            second.is_err(),
            "a second instance must not silently steal the first one's clients"
        );
    }
}
