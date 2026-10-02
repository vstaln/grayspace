use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use orcspace_app::platform::{
    interrupt_process_tree, kill_process_tree, prime_conpty_handshake,
    shell_arguments as windows_utf8_shell_args, shell_command,
};
use orcspace_app::queue::ActorRateLimiter;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet, VecDeque},
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
/// the app. When it is reached, the PTY reader waits here; the OS PTY buffer
/// then provides backpressure instead of deleting live terminal bytes.
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
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Clone, Debug)]
pub struct TerminalManager {
    inner: Arc<Inner>,
}

#[derive(Debug)]
struct Inner {
    retain_scrollback: bool,
    terminals: Mutex<HashMap<String, TerminalHandle>>,
    events: Mutex<EventQueue>,
    /// Signalled whenever output lands, so the engine's drain thread reacts
    /// immediately instead of polling on a fixed tick.
    events_ready: Condvar,
    token: String,
    control_socket: Mutex<Option<String>>,
    /// Terminal id to the name the UI shows and `orc` addresses. One map, so
    /// a terminal cannot be called one thing on screen and another on the CLI.
    names: Mutex<HashMap<String, String>>,
}

#[derive(Debug, Default)]
struct EventQueue {
    notified: bool,
    items: VecDeque<TerminalEvent>,
    bytes: usize,
    /// Ids being disposed; a reader blocked on a full queue must wake and stop
    /// instead of keeping a closed terminal alive forever.
    stopped: HashSet<String>,
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
    /// Gate shared with the PTY reader so renderer backpressure can pause OS
    /// reads. The child then naturally blocks on its PTY output buffer.
    output_gate: Arc<(Mutex<bool>, Condvar)>,
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
    Resize {
        cols: u16,
        rows: u16,
    },
    /// Ctrl+C on a terminal whose input is already wedged. The byte itself
    /// cannot be typed — it would queue behind the write that is stuck — so
    /// the foreground program is stopped directly instead.
    Interrupt,
    Dispose,
    /// Sent by the writer thread when the PTY can no longer be written to, so
    /// the actor tears the session down exactly as it does for a dispose.
    WriterFailed,
    ChildExited,
}

#[derive(Debug, Default)]
struct TerminalState {
    output: String,
    alive: bool,
    cwd: String,
    /// Whether the program running in this terminal has turned on DECSET
    /// 2004. Only then may a delivery be wrapped as a bracketed paste.
    bracketed_paste: bool,
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
        Self::with_scrollback(token, true)
    }

    pub fn streaming(token: String) -> Self {
        Self::with_scrollback(token, false)
    }

    fn with_scrollback(token: String, retain_scrollback: bool) -> Self {
        Self {
            inner: Arc::new(Inner {
                retain_scrollback,
                terminals: Mutex::new(HashMap::new()),
                events: Mutex::new(EventQueue::default()),
                events_ready: Condvar::new(),
                token,
                control_socket: Mutex::new(None),
                names: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub fn set_name(&self, id: &str, name: &str) {
        lock_recover(&self.inner.names).insert(id.to_owned(), name.to_owned());
    }

    pub fn name(&self, id: &str) -> Option<String> {
        lock_recover(&self.inner.names).get(id).cloned()
    }

    pub fn names(&self) -> HashMap<String, String> {
        lock_recover(&self.inner.names).clone()
    }

    /// Turns whatever a caller typed — an id or a name — into a terminal id.
    /// Names beat ids in the docs, so `orc tell backend` has to land even
    /// though nothing is keyed by name.
    pub fn resolve(&self, target: &str) -> String {
        if lock_recover(&self.inner.terminals).contains_key(target) {
            return target.to_owned();
        }
        lock_recover(&self.inner.names)
            .iter()
            .find(|(_, name)| name.eq_ignore_ascii_case(target))
            .map_or_else(|| target.to_owned(), |(id, _)| id.clone())
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
        self.spawn_with_options(id, 120, 32, None, shell_command(), HashMap::new())
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
        allow_terminal_events(&self.inner, &id);

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
        command.env_remove("NO_COLOR");
        command.env("COLORTERM", "truecolor");
        command.env("TERM_PROGRAM", "OrcSpace");
        command.env("ORCSPACE_TERMINAL_ID", &id);
        command.env("ORCSPACE_AGENT_ID", &id);
        command.env("ORCSPACE_TOKEN", &self.inner.token);
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
        command.env(
            "LC_ALL",
            std::env::var("LC_ALL").unwrap_or_else(|_| lang.clone()),
        );
        command.env("LANG", lang);
        let state_cwd = cwd
            .clone()
            .or_else(|| {
                std::env::current_dir()
                    .ok()
                    .and_then(|path| path.to_str().map(str::to_owned))
            })
            .unwrap_or_default();
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
        let mut writer = match pair.master.take_writer() {
            Ok(writer) => writer,
            Err(error) => abandon_child!(child, format!("take pty writer: {error}")),
        };
        prime_conpty_handshake(&mut writer);
        let state = Arc::new(Mutex::new(TerminalState {
            alive: true,
            cwd: state_cwd,
            ..Default::default()
        }));
        let input_guard = Arc::new(Mutex::new(()));
        let pending_input = Arc::new(AtomicUsize::new(0));
        let writing_since = Arc::new(AtomicU64::new(0));
        let output_gate = Arc::new((Mutex::new(false), Condvar::new()));
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
        let reader_gate = Arc::clone(&output_gate);
        let startup_input = cfg!(windows).then(|| (input_tx.clone(), Arc::clone(&pending_input)));

        if let Err(error) = thread::Builder::new()
            .name(format!("orcspace-pty-reader-{id}"))
            .spawn(move || {
                read_output(
                    reader,
                    reader_state,
                    events,
                    reader_id,
                    startup_input,
                    reader_gate,
                )
            })
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
        let actor_exit_tx = control_tx.clone();
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
                    actor_exit_tx,
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
                    output_gate,
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
        set_output_gate(&handle.output_gate, false);
        stop_terminal_events(&self.inner, id);
        // Freeing the name lets the pool hand it to the next terminal.
        lock_recover(&self.inner.names).remove(id);
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
        let ids: Vec<String> = lock_recover(&self.inner.terminals)
            .keys()
            .cloned()
            .collect();
        for id in ids {
            let _ = self.dispose(&id);
        }
    }

    #[allow(dead_code)]
    pub fn write_raw(&self, id: &str, data: &[u8]) -> Result<(), String> {
        self.deliver_input(id, data.to_vec())
    }

    pub fn write_message(&self, id: &str, text: &str) -> Result<DeliveryReceipt, String> {
        let bracketed = lock_recover(&self.handle(id)?.state).bracketed_paste;
        let bytes = encode_terminal_message_input(text, bracketed)?;
        self.write_encoded(id, bytes, true)
    }

    pub fn write_text(
        &self,
        id: &str,
        text: &str,
        press_enter: bool,
    ) -> Result<DeliveryReceipt, String> {
        let bytes = encode_terminal_input(text, false)?;
        self.write_encoded(id, bytes, press_enter)
    }

    fn write_encoded(
        &self,
        id: &str,
        bytes: Vec<u8>,
        press_enter: bool,
    ) -> Result<DeliveryReceipt, String> {
        let count = bytes.len() + usize::from(press_enter);
        let handle = self.handle(id)?;
        let (tx, rx) = mpsc::channel();
        {
            let _guard = lock_recover(&handle.input_guard);
            if write_in_flight_ms(&handle.writing_since) >= STUCK_WRITE_MS
                || handle
                    .pending_input
                    .load(Ordering::Acquire)
                    .saturating_add(count)
                    > MAX_PENDING_INPUT_BYTES
            {
                return Err(format!("terminal {id} is not reading input"));
            }
            push_terminal_input(
                id,
                &handle,
                TerminalInput {
                    data: bytes,
                    press_enter,
                    acknowledgement: Some(tx),
                },
            )?;
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

    pub fn set_output_paused(&self, id: &str, paused: bool) -> Result<(), String> {
        let handle = self.handle(id)?;
        set_output_gate(&handle.output_gate, paused);
        Ok(())
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
        let mut ids: Vec<String> = lock_recover(&self.inner.terminals)
            .keys()
            .cloned()
            .collect();
        ids.sort();
        ids.into_iter()
            .filter_map(|id| self.snapshot(&id).ok())
            .collect()
    }

    pub fn terminal_ids(&self) -> Vec<String> {
        lock_recover(&self.inner.terminals)
            .keys()
            .cloned()
            .collect()
    }

    /// Non-blocking drain, used by the egui frame loop.
    pub fn drain_events(&self) -> Vec<TerminalEvent> {
        let mut queue = lock_recover(&self.inner.events);
        let events = take_events(&mut queue);
        self.inner.events_ready.notify_all();
        events
    }

    /// Blocking drain, used by the headless engine so output is forwarded the
    /// moment it is read instead of on a polling tick — and so forwarding can
    /// never end up queued behind command handling.
    pub fn notify_response(&self) {
        lock_recover(&self.inner.events).notified = true;
        self.inner.events_ready.notify_one();
    }

    pub fn wait_events(&self) -> Vec<TerminalEvent> {
        let queue = lock_recover(&self.inner.events);
        let mut queue = self
            .inner
            .events_ready
            .wait_while(queue, |queue| queue.items.is_empty() && !queue.notified)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        queue.notified = false;
        let events = take_events(&mut queue);
        self.inner.events_ready.notify_all();
        events
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
                output_gate: Arc::clone(&handle.output_gate),
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
    push_terminal_input(
        id,
        handle,
        TerminalInput {
            data,
            press_enter: false,
            acknowledgement: None,
        },
    )
}

fn push_terminal_input(
    id: &str,
    handle: &TerminalHandle,
    input: TerminalInput,
) -> Result<(), String> {
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
        let result = writer
            .write_all(&input.data)
            .and_then(|_| writer.flush())
            .and_then(|_| {
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
        pending_input.fetch_sub(
            input.data.len() + usize::from(input.press_enter),
            Ordering::AcqRel,
        );
        if let Some(ack) = input.acknowledgement {
            let _ = ack.send(
                result
                    .as_ref()
                    .map(|_| ())
                    .map_err(|error| format!("write terminal {id}: {error}")),
            );
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
    _pending_input: Arc<AtomicUsize>,
    id: String,
    exit_tx: mpsc::Sender<ControlCommand>,
) {
    let mut disposed = false;
    let mut natural_exit = false;
    let mut killer = child.clone_killer();
    // The OS signals process exit directly. ConPTY's reader may not reach EOF
    // until this actor closes the master, so it cannot be our exit detector.
    let waiter = thread::Builder::new()
        .name(format!("orcspace-pty-wait-{id}"))
        .spawn(move || {
            let result = child.wait();
            let _ = exit_tx.send(if result.is_ok() {
                ControlCommand::ChildExited
            } else {
                ControlCommand::WriterFailed
            });
        });
    if let Err(error) = &waiter {
        eprintln!("wait terminal {id}: {error}");
        if let Some(pid) = child_pid {
            kill_process_tree(pid);
        }
        let _ = killer.kill();
    }
    while waiter.is_ok() {
        let Ok(command) = rx.recv() else {
            break;
        };
        match command {
            ControlCommand::ChildExited => {
                natural_exit = true;
                break;
            }
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
                let _ = killer.kill();
                disposed = true;
                break;
            }
            ControlCommand::WriterFailed => break,
        }
    }
    // ClosePseudoConsole may wait for its processes. Stop them before dropping
    // the master, including on a broken writer rather than explicit disposal.
    if !disposed {
        if let Some(pid) = child_pid {
            kill_process_tree(pid);
        }
        let _ = killer.kill();
    }
    // Closes the PTY, which ends the reader thread and releases the writer
    // thread if it is still parked inside a write.
    drop(master);
    lock_recover(&state).alive = false;
    if !disposed && !natural_exit {
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

fn set_output_gate(gate: &Arc<(Mutex<bool>, Condvar)>, paused: bool) {
    let (state, ready) = &**gate;
    *lock_recover(state) = paused;
    if !paused {
        ready.notify_all();
    }
}

fn allow_terminal_events(inner: &Arc<Inner>, id: &str) {
    lock_recover(&inner.events).stopped.remove(id);
    inner.events_ready.notify_all();
}

fn stop_terminal_events(inner: &Arc<Inner>, id: &str) {
    let mut queue = lock_recover(&inner.events);
    queue.stopped.insert(id.to_owned());
    let mut retained = VecDeque::with_capacity(queue.items.len());
    while let Some(event) = queue.items.pop_front() {
        let event_id = match &event {
            TerminalEvent::Output { id, .. } | TerminalEvent::Exited { id } => id,
        };
        if event_id == id {
            queue.bytes = queue.bytes.saturating_sub(event_bytes(&event));
        } else {
            retained.push_back(event);
        }
    }
    queue.items = retained;
    inner.events_ready.notify_all();
}

fn push_event(inner: &Arc<Inner>, event: TerminalEvent) {
    let (id, bytes) = match &event {
        TerminalEvent::Output { id, data } => (id.as_str(), data.len()),
        TerminalEvent::Exited { id } => (id.as_str(), 0),
    };
    let mut queue = lock_recover(&inner.events);
    while queue.bytes > 0
        && queue.bytes.saturating_add(bytes) > MAX_PENDING_EVENT_BYTES
        && !queue.stopped.contains(id)
    {
        queue = inner
            .events_ready
            .wait(queue)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
    }
    if queue.stopped.contains(id) {
        return;
    }
    queue.bytes = queue.bytes.saturating_add(bytes);
    queue.items.push_back(event);
    inner.events_ready.notify_all();
}

fn take_events(queue: &mut EventQueue) -> Vec<TerminalEvent> {
    let events = queue.items.drain(..).collect();
    queue.bytes = 0;
    events
}

fn event_bytes(event: &TerminalEvent) -> usize {
    match event {
        TerminalEvent::Output { data, .. } => data.len(),
        TerminalEvent::Exited { .. } => 0,
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

fn read_output(
    mut reader: Box<dyn Read + Send>,
    state: Arc<Mutex<TerminalState>>,
    inner: Arc<Inner>,
    id: String,
    startup_input: Option<(mpsc::Sender<TerminalInput>, Arc<AtomicUsize>)>,
    output_gate: Arc<(Mutex<bool>, Condvar)>,
) {
    let mut buffer = [0_u8; 16 * 1024];
    let mut decoder = Utf8Stream::default();
    // The tail of the previous chunk, so a mode toggle split across two reads
    // is still seen whole. `\x1b[?2004h` is eight bytes.
    let mut modes = orcspace_app::terminal_protocol::Decoder::default();
    let mut startup = orcspace_app::conpty_startup::StartupFilter::default();
    loop {
        let (paused, ready) = &*output_gate;
        let mut paused = lock_recover(paused);
        while *paused {
            paused = ready
                .wait(paused)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        drop(paused);
        let count = match reader.read(&mut buffer) {
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Ok(0) | Err(_) => 0,
            Ok(count) => count,
        };
        let filtered;
        let bytes = if let Some((sender, pending)) = &startup_input {
            let (mut output, replies) = startup.process(&buffer[..count]);
            if !replies.is_empty() {
                let size = replies.len();
                pending.fetch_add(size, Ordering::AcqRel);
                if sender
                    .send(TerminalInput {
                        data: replies,
                        press_enter: false,
                        acknowledgement: None,
                    })
                    .is_err()
                {
                    pending.fetch_sub(size, Ordering::AcqRel);
                }
            }
            if count == 0 {
                output.extend(startup.finish());
            }
            filtered = output;
            filtered.as_slice()
        } else {
            &buffer[..count]
        };
        let data = decoder.decode(bytes, count == 0);
        if data.is_empty() {
            if count == 0 {
                break;
            }
            continue;
        }
        for control in modes.advance(data.as_bytes()) {
            use orcspace_app::terminal_protocol::Control;
            match control {
                Control::Mode(2004, enabled) => lock_recover(&state).bracketed_paste = enabled,
                Control::Reset => lock_recover(&state).bracketed_paste = false,
                _ => {}
            }
        }
        if inner.retain_scrollback {
            let mut current = lock_recover(&state);
            current.output.push_str(&data);
            if current.output.len() > MAX_SCROLLBACK + SCROLLBACK_SLACK {
                let mut cut = current.output.len() - MAX_SCROLLBACK;
                while !current.output.is_char_boundary(cut) {
                    cut += 1;
                }
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
        if count == 0 {
            break;
        }
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

/// Encodes one delivery. The paste markers go on only when the receiving
/// program asked for them: `cmd.exe` and other plain shells never enable
/// DECSET 2004, and its line editor takes the leading escape as "clear the
/// line" — which ate all but the first character of every `orc tell`.
fn encode_terminal_message_input(text: &str, bracketed: bool) -> Result<Vec<u8>, String> {
    let line = text.replace("\r\n", "\n").replace('\r', "\n");
    if line.trim().is_empty() {
        return Err("message must contain non-whitespace text".to_owned());
    }
    if line
        .bytes()
        .any(|byte| (byte < b' ' && byte != b'\t' && byte != b'\n') || byte == 0x7f)
    {
        return Err("message contains unsafe terminal control characters".to_owned());
    }
    if !bracketed {
        // Without paste markers a newline is a submit, so a multi-line
        // message would run its first line and leave the rest as commands.
        return Ok(line.replace('\n', " ").into_bytes());
    }
    let mut bytes = b"\x1b[200~".to_vec();
    bytes.extend_from_slice(line.as_bytes());
    bytes.extend_from_slice(b"\x1b[201~");
    Ok(bytes)
}

/// The state DECSET 2004 was last left in by this chunk of output.
#[cfg(test)]
fn bracketed_paste_toggle(data: &str) -> Option<bool> {
    orcspace_app::terminal_screen::last_mode_toggle(data.as_bytes(), 2004)
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
    #[cfg(test)]
    pub fn start_at(manager: TerminalManager, token: String, path: String) -> Result<Self, String> {
        let storage =
            std::env::temp_dir().join(format!("orcspace-test-{}.json", uuid::Uuid::new_v4()));
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
                            let _ = ready_tx.send(Err(format!(
                                "bind control server at {listen_path}: {error}"
                            )));
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
        let data = serde_json::to_vec_pretty(&store.to_json()).map_err(std::io::Error::other)?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(&data)?;
        file.sync_all()?;
        drop(file);
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
    #[serde(default)]
    text: String,
    #[serde(default)]
    images: Vec<String>,
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
    let names = state.manager.names();
    let workers = state
        .manager
        .snapshots()
        .into_iter()
        .map(|snapshot| WorkerInfo {
            name: names
                .get(&snapshot.id)
                .cloned()
                .unwrap_or_else(|| snapshot.id.clone()),
            id: snapshot.id,
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
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    authenticate(&headers, &state.token)?;
    check_rate_limit(&state, &headers, request.agent_id.as_deref())?;
    let manager = state.manager.clone();
    let to = state.manager.resolve(&request.to);
    let text = request.text.clone();
    if request.images.len() > 16 {
        return Err(bad_request("At most 16 images per delivery".into()));
    }
    let sources = request.images.clone();
    let (receipt, images) = tokio::task::spawn_blocking(move || -> Result<_, String> {
        if sources.is_empty() {
            return manager
                .write_message(&to, &text)
                .map(|r| (r, Vec::<String>::new()));
        }
        if !manager.snapshot(&to)?.alive {
            return Err("Terminal has exited".into());
        }
        let directory = orcspace_app::ipc::user_data_dir().join("media");
        let images = sources
            .iter()
            .map(|source| {
                orcspace_app::attachments::import_image(std::path::Path::new(source), &directory)
                    .map(|path| path.to_string_lossy().into_owned())
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut content = String::new();
        for path in &images {
            content.push_str(&orcspace_app::attachments::path_token(path)?);
        }
        content.push_str(&text.replace(['\r', '\n'], " "));
        // This branch only runs when at least one image was attached, so the
        // delivery must be submitted even when the accompanying text is blank.
        let receipt = manager.write_text(&to, &content, true)?;
        Ok((receipt, images))
    })
    .await
    .map_err(|error| bad_request(format!("delivery task failed: {error}")))?
    .map_err(bad_request)?;
    let mut response = serde_json::json!({"ok": true, "id": request.to, "text": request.text, "delivery": receipt});
    if !images.is_empty() {
        response["images"] = serde_json::json!(images);
        response["mode"] = serde_json::json!("path");
    }
    Ok(Json(response))
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
    let id = state.manager.resolve(&id);
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
        .snapshot(&state.manager.resolve(&id))
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
        .or_else(|| {
            parsed_body
                .get("agentId")
                .and_then(|value| value.as_str())
                .map(str::to_owned)
        });
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
    let previous = store.to_json();
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
                    *store = orcspace_app::orchestration::OrchestrationStore::load(&previous);
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
    let header = headers
        .get("x-agent-id")
        .and_then(|value| value.to_str().ok());
    let raw = hint
        .filter(|value| !value.trim().is_empty())
        .or(header)
        .unwrap_or("api")
        .trim();
    let key = raw
        .char_indices()
        .nth(128)
        .map(|(index, _)| &raw[..index])
        .unwrap_or(raw);
    let now = now_millis().min(i64::MAX as u128) as i64;
    if lock_recover(&state.rate_limiter).try_consume(key, 1.0, now) {
        Ok(())
    } else {
        Err((
            StatusCode::TOO_MANY_REQUESTS,
            "too many requests".to_owned(),
        ))
    }
}

fn authenticate(headers: &HeaderMap, token: &str) -> Result<(), (StatusCode, String)> {
    let supplied = headers
        .get(TOKEN_HEADER)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if constant_time_token_eq(supplied, token) {
        Ok(())
    } else {
        Err((StatusCode::UNAUTHORIZED, "invalid control token".to_owned()))
    }
}

fn constant_time_token_eq(supplied: &str, expected: &str) -> bool {
    let supplied_hash = Sha256::digest(supplied.as_bytes());
    let expected_hash = Sha256::digest(expected.as_bytes());
    supplied_hash
        .iter()
        .zip(expected_hash.iter())
        .fold(0_u8, |diff, (left, right)| diff | (left ^ right))
        == 0
}

fn bad_request(error: String) -> (StatusCode, String) {
    (StatusCode::BAD_REQUEST, error)
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    use super::windows_utf8_shell_args;
    use super::{
        constant_time_token_eq, encode_terminal_input, encode_terminal_message_input, take_events,
        EventQueue, TerminalEvent, WriteRequest, MAX_PENDING_EVENT_BYTES,
    };
    use serde_json::json;
    use std::sync::atomic::AtomicU64;
    use std::sync::Arc;

    #[cfg(windows)]
    #[test]
    fn bundled_conpty_preserves_synchronized_cursor_commands() {
        use std::time::{Duration, Instant};
        let manager = super::TerminalManager::new("cursor-probe".into());
        manager.spawn("cursor-probe").unwrap();
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(5) {
            if manager
                .snapshot("cursor-probe")
                .unwrap()
                .output
                .contains('>')
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let command = "powershell.exe -NoLogo -NoProfile -Command \"$e=[char]27; [Console]::Write($e+'[?2026h'+$e+'[?25l'+$e+'[4;9H'+'ORC_CURSOR_PROBE'+$e+'[6 q'+$e+'[?25h'+$e+'[?2026l')\"\r";
        manager
            .write_raw("cursor-probe", command.as_bytes())
            .unwrap();
        let expected = "\x1b[?2026h\x1b[?25l\x1b[4;9HORC_CURSOR_PROBE\x1b[6 q\x1b[?25h\x1b[?2026l";
        let started = Instant::now();
        let preserved = loop {
            if manager
                .snapshot("cursor-probe")
                .unwrap()
                .output
                .contains(expected)
            {
                break true;
            }
            if started.elapsed() > Duration::from_secs(10) {
                break false;
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        manager.dispose("cursor-probe").unwrap();
        assert!(preserved, "ConPTY rewrote the synchronized cursor frame");
    }

    #[test]
    fn line_normalization_rejects_space_only_messages() {
        assert!(encode_terminal_input("   ", true).is_err());
        assert_eq!(encode_terminal_input("a\r\nb", true).unwrap(), b"a  b\r");
        assert_eq!(encode_terminal_input("a", false).unwrap(), b"a");
    }

    #[test]
    fn message_input_uses_bracketed_paste_markers_only_where_they_are_understood() {
        assert_eq!(
            encode_terminal_message_input("hello\r\nworld", true).unwrap(),
            b"\x1b[200~hello\nworld\x1b[201~"
        );
        // cmd.exe reads the leading escape as "clear the line", so a plain
        // shell gets the bare text, flattened to the single line it submits.
        assert_eq!(
            encode_terminal_message_input("hello\r\nworld", false).unwrap(),
            b"hello world"
        );
    }

    #[test]
    fn message_input_rejects_bracketed_paste_terminators() {
        assert!(encode_terminal_message_input("safe\x1b[201~echo unsafe", true).is_err());
        assert!(encode_terminal_message_input("safe\x1b[201~echo unsafe", false).is_err());
    }

    #[test]
    fn the_last_paste_mode_toggle_in_a_chunk_wins() {
        assert_eq!(super::bracketed_paste_toggle("no modes here"), None);
        assert_eq!(super::bracketed_paste_toggle("\x1b[?2004h"), Some(true));
        assert_eq!(
            super::bracketed_paste_toggle("\x1b[?2004h out \x1b[?2004l"),
            Some(false)
        );
        assert_eq!(
            super::bracketed_paste_toggle("\x1b[?2004l out \x1b[?2004h"),
            Some(true)
        );
    }

    #[test]
    fn control_tokens_are_compared_without_early_exit() {
        assert!(constant_time_token_eq("secret", "secret"));
        assert!(!constant_time_token_eq("secret", "secrex"));
        assert!(!constant_time_token_eq("", "secret"));
    }

    #[cfg(windows)]
    #[test]
    fn cmd_starts_with_utf8_setup_args() {
        // Both cmd and PowerShell configure UTF-8 code page on startup.
        let cmd = windows_utf8_shell_args(r"C:\Windows\System32\cmd.exe");
        assert_eq!(
            cmd,
            vec!["/K", "chcp 65001 >nul"],
            "cmd.exe must configure UTF-8 code page"
        );

        let ps = windows_utf8_shell_args(r"C:\...\WindowsPowerShell\v1.0\powershell.exe");
        assert!(
            ps.contains(&"-NoExit"),
            "must keep the PowerShell session interactive"
        );
        assert!(ps.iter().any(|arg| arg.contains("65001")));
        // Nothing may end with a carriage return: these are argv entries, not
        // keystrokes typed into a running shell.
        for arg in cmd.iter().chain(ps.iter()) {
            assert!(
                !arg.contains('\r'),
                "argv entry must not carry an Enter: {arg}"
            );
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
            output: "я".repeat(super::MAX_SCROLLBACK / 2),
            alive: true,
            ..Default::default()
        }));
        // Enough to cross the slack so the compaction actually runs: that is
        // the path where the cut lands inside a two-byte char and used to be
        // able to kill the reader.
        let overflow = vec![b'x'; super::SCROLLBACK_SLACK + 1];
        super::read_output(
            Box::new(std::io::Cursor::new(overflow)),
            Arc::clone(&state),
            Arc::clone(&manager.inner),
            "test".to_owned(),
            None,
            Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new())),
        );
        let state = state.lock().unwrap();
        assert!(
            state.output.len() < super::MAX_SCROLLBACK + super::SCROLLBACK_SLACK,
            "the buffer must actually have been compacted"
        );
        assert!(!state.alive);
    }

    #[test]
    fn streaming_keeps_every_output_byte_without_a_second_history() {
        let manager = super::TerminalManager::streaming("test".to_owned());
        let state = Arc::new(std::sync::Mutex::new(super::TerminalState::default()));
        let expected = "hello\r\n".repeat(200_000);
        super::read_output(
            Box::new(std::io::Cursor::new(expected.clone())),
            Arc::clone(&state),
            Arc::clone(&manager.inner),
            "test".to_owned(),
            None,
            Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new())),
        );
        assert_eq!(state.lock().unwrap().output.capacity(), 0);
        let events = manager.drain_events();
        let actual: String = events
            .iter()
            .filter_map(|event| match event {
                TerminalEvent::Output { data, .. } => Some(data.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(actual, expected);
        assert!(matches!(events.last(), Some(TerminalEvent::Exited { .. })));
    }

    #[test]
    fn response_notification_survives_until_the_pump_waits() {
        let manager = super::TerminalManager::streaming("test".to_owned());
        manager.notify_response();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            tx.send(manager.wait_events()).unwrap();
        });
        assert!(rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap()
            .is_empty());
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
    fn output_pressure_waits_for_the_consumer_and_preserves_every_byte() {
        let inner = Arc::new(super::Inner {
            retain_scrollback: true,
            terminals: std::sync::Mutex::new(std::collections::HashMap::new()),
            events: std::sync::Mutex::new(EventQueue::default()),
            events_ready: std::sync::Condvar::new(),
            token: "t".to_owned(),
            control_socket: std::sync::Mutex::new(None),
            names: std::sync::Mutex::new(std::collections::HashMap::new()),
        });

        let first = "a".repeat(MAX_PENDING_EVENT_BYTES / 2);
        let second = "b".repeat(MAX_PENDING_EVENT_BYTES / 2 + 1);
        super::push_event(&inner, output("term-1", &first));

        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let blocked_inner = Arc::clone(&inner);
        let blocked_second = second.clone();
        let writer = std::thread::spawn(move || {
            super::push_event(&blocked_inner, output("term-1", &blocked_second));
            done_tx.send(()).unwrap();
        });
        assert!(
            done_rx.try_recv().is_err(),
            "producer waits while the queue is full"
        );

        let mut queue = inner.events.lock().unwrap();
        let first_events = take_events(&mut queue);
        inner.events_ready.notify_all();
        drop(queue);
        assert_eq!(
            done_rx.recv_timeout(std::time::Duration::from_secs(2)),
            Ok(())
        );
        writer.join().unwrap();

        let mut queue = inner.events.lock().unwrap();
        let second_events = take_events(&mut queue);
        let collected: String = first_events
            .into_iter()
            .chain(second_events)
            .filter_map(|event| match event {
                TerminalEvent::Output { data, .. } => Some(data),
                _ => None,
            })
            .collect();
        assert_eq!(collected, first + &second);
    }

    #[test]
    fn disposing_a_terminal_releases_a_blocked_output_producer() {
        let inner = Arc::new(super::Inner {
            retain_scrollback: true,
            terminals: std::sync::Mutex::new(std::collections::HashMap::new()),
            events: std::sync::Mutex::new(EventQueue::default()),
            events_ready: std::sync::Condvar::new(),
            token: "t".to_owned(),
            control_socket: std::sync::Mutex::new(None),
            names: std::sync::Mutex::new(std::collections::HashMap::new()),
        });
        super::push_event(
            &inner,
            output("term-1", &"x".repeat(MAX_PENDING_EVENT_BYTES)),
        );
        let blocked_inner = Arc::clone(&inner);
        let writer = std::thread::spawn(move || {
            super::push_event(&blocked_inner, output("term-1", "after"))
        });
        super::stop_terminal_events(&inner, "term-1");
        writer.join().unwrap();
        assert!(inner.events.lock().unwrap().items.is_empty());
    }

    #[test]
    fn draining_leaves_output_untouched() {
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
        use std::sync::{atomic::AtomicUsize, mpsc, Arc, Mutex};
        use std::time::{Duration, Instant};
        type RecordedWrites = Arc<Mutex<Vec<(Vec<u8>, Instant)>>>;
        struct RecordingWriter(RecordedWrites);
        impl Write for RecordingWriter {
            fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().push((data.to_vec(), Instant::now()));
                Ok(data.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let writes = Arc::new(Mutex::new(Vec::new()));
        let (tx, rx) = mpsc::channel();
        let (control_tx, _) = mpsc::channel();
        let (ack_tx, ack_rx) = mpsc::channel();
        let pending = Arc::new(AtomicUsize::new(13));
        tx.send(super::TerminalInput {
            data: b"hello".to_vec(),
            press_enter: true,
            acknowledgement: Some(ack_tx),
        })
        .unwrap();
        tx.send(super::TerminalInput {
            data: b"x".to_vec(),
            press_enter: false,
            acknowledgement: None,
        })
        .unwrap();
        tx.send(super::TerminalInput {
            data: b"world".to_vec(),
            press_enter: false,
            acknowledgement: None,
        })
        .unwrap();
        tx.send(super::TerminalInput {
            data: b"\r".to_vec(),
            press_enter: false,
            acknowledgement: None,
        })
        .unwrap();
        drop(tx);
        let output = Arc::clone(&writes);
        let queued = Arc::clone(&pending);
        let worker = std::thread::spawn(move || {
            super::run_writer(
                Box::new(RecordingWriter(output)),
                rx,
                control_tx,
                queued,
                Arc::new(AtomicU64::new(0)),
                "test".to_owned(),
            )
        });
        ack_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        assert!(writes
            .lock()
            .unwrap()
            .iter()
            .any(|(bytes, _)| bytes == b"\r"));
        worker.join().unwrap();
        let writes = writes.lock().unwrap();
        assert_eq!(
            writes
                .iter()
                .map(|(bytes, _)| bytes.as_slice())
                .collect::<Vec<_>>(),
            vec![b"hello".as_slice(), b"\r", b"x", b"world", b"\r"]
        );
        assert!(writes[1].1.duration_since(writes[0].1) >= Duration::from_millis(200));
        assert!(writes[4].1.duration_since(writes[3].1) >= Duration::from_millis(200));
        assert_eq!(pending.load(std::sync::atomic::Ordering::Acquire), 0);
    }

    #[test]
    fn failed_submit_is_not_acknowledged_as_success() {
        struct FailedSubmit;
        impl std::io::Write for FailedSubmit {
            fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
                if data == b"\r" {
                    return Err(std::io::Error::other("submit failed"));
                }
                Ok(data.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let (tx, rx) = std::sync::mpsc::channel();
        let (control_tx, control_rx) = std::sync::mpsc::channel();
        let (ack_tx, ack_rx) = std::sync::mpsc::channel();
        tx.send(super::TerminalInput {
            data: b"hello".to_vec(),
            press_enter: true,
            acknowledgement: Some(ack_tx),
        })
        .unwrap();
        drop(tx);
        super::run_writer(
            Box::new(FailedSubmit),
            rx,
            control_tx,
            std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(6)),
            std::sync::Arc::new(AtomicU64::new(0)),
            "test".to_owned(),
        );
        assert!(ack_rx
            .recv()
            .unwrap()
            .unwrap_err()
            .contains("submit failed"));
        assert!(matches!(
            control_rx.recv().unwrap(),
            super::ControlCommand::WriterFailed
        ));
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
    fn request(
        path_to_socket: &str,
        method: &str,
        target: &str,
        token: &str,
        body: Option<&str>,
    ) -> String {
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
