use napi::bindgen_prelude::{AsyncTask, Result};
use napi::{Env, Error, Task};
use napi_derive::napi;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::process;
use std::time::{SystemTime, UNIX_EPOCH};

/// Same crash-safety contract as `storage.ts`'s `writeAtomic`: write to a
/// sibling temp file, fsync, copy the previous good file to `.bak`, then
/// atomically rename the temp file over the target. Runs on napi's worker
/// thread pool (via `Task::compute`), never on the JS thread.
fn write_atomic_sync(path: &str, text: &str, keep_backup: bool) -> std::result::Result<(), String> {
    let path = Path::new(path);
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let temp = dir.join(format!(".{nanos}-{}.tmp", process::id()));

    {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        file.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }

    if keep_backup && path.exists() {
        let backup = format!("{}.bak", path.display());
        if let Err(e) = fs::copy(path, &backup) {
            let _ = fs::remove_file(&temp);
            return Err(e.to_string());
        }
    }

    if let Err(e) = fs::rename(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(e.to_string());
    }
    Ok(())
}

pub struct WriteTextAtomicTask {
    path: String,
    text: String,
    keep_backup: bool,
}

impl Task for WriteTextAtomicTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<Self::Output> {
        write_atomic_sync(&self.path, &self.text, self.keep_backup).map_err(Error::from_reason)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// JS-facing entry point: looks synchronous but returns a `Promise` backed by
/// `AsyncTask`, so the file write + fsync + rename run off the Node/Electron
/// main thread and never block IPC, PTY output, or the renderer's canvas.save
/// round-trip.
///
/// It takes the **already-serialized text**, not the object. The previous
/// signature was `write_json_atomic(path, value: serde_json::Value)`, and that
/// `Value` was materialized by napi on the JS thread *before* the AsyncTask
/// was ever queued: converting one full canvas (200k stroke points) into a
/// `serde_json::Value` tree blocked the main process for ~176 ms, against
/// ~40 ms for V8's own `JSON.stringify` of the same object and ~10 ms for the
/// write itself. The "off-thread" writer was the single largest main-thread
/// stall on the autosave path. Handing Rust a `String` costs one UTF-16 → UTF-8
/// copy and moves everything that actually touches the disk off-thread, which
/// is what the crate was for.
#[napi]
pub fn write_text_atomic(path: String, text: String, keep_backup: bool) -> AsyncTask<WriteTextAtomicTask> {
    AsyncTask::new(WriteTextAtomicTask {
        path,
        text,
        keep_backup,
    })
}

/// Strips ANSI escape sequences from terminal output, keeping visible text
/// only. Covers CSI (`ESC [ … final`), OSC (`ESC ] … BEL|ST`), the charset
/// selectors (`ESC ( X`) and DCS/SOS/PM/APC (`ESC P/X/^/_ … ST`) — the same
/// set the TypeScript fallback in `terminalSnapshots.ts` handles, so a saved
/// scrollback replayed into xterm can never re-run side effects such as an
/// OSC 52 clipboard write. Char-based like the JS version: a U+009B codepoint
/// inside the text is treated as C1-CSI, but its UTF-8 continuation bytes in
/// other characters are left alone.
fn strip_ansi(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    let mut out = String::with_capacity(text.len());
    let mut i = 0usize;
    let is_final = |c: char| ('@'..='~').contains(&c);

    while i < n {
        let c = chars[i];
        if c == '\u{1b}' && i + 1 < n {
            match chars[i + 1] {
                '[' => {
                    i += 2;
                    while i < n && !is_final(chars[i]) {
                        i += 1;
                    }
                    if i < n {
                        i += 1; // consume the final byte
                    }
                    continue;
                }
                ']' => {
                    i += 2;
                    while i < n && chars[i] != '\u{7}' && !(chars[i] == '\u{1b}' && i + 1 < n && chars[i + 1] == '\\') {
                        i += 1;
                    }
                    // Unterminated OSC swallows what was seen so far — same as
                    // the TypeScript fallback's behaviour for a torn tail.
                    if i < n {
                        i += if chars[i] == '\u{7}' { 1 } else { 2 };
                    }
                    continue;
                }
                '(' | ')' | '*' | '+' => {
                    i += 3.min(n - i);
                    continue;
                }
                'P' | 'X' | '^' | '_' => {
                    i += 2;
                    while i < n && !(chars[i] == '\u{1b}' && i + 1 < n && chars[i + 1] == '\\') {
                        i += 1;
                    }
                    if i < n {
                        i += 2; // consume the ST
                    }
                    continue;
                }
                _ => {}
            }
        }
        if matches!(c, '\u{9b}' | '\u{9d}' | '\u{90}' | '\u{9e}' | '\u{9f}') {
            i += 1;
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

/// Public, chat-facing twin of the internal stripper: one string in, one
/// string out. The napi bridge for a single `String` is one UTF-16 → UTF-8
/// copy — the cheap kind of bridge (see the note on `write_text_atomic`) —
/// while the per-character scan itself runs in Rust. The chat pane routes
/// every streamed chunk of every CLI reply through here, which used to be a
/// regex-heavy JavaScript pass per chunk on the renderer's main thread.
#[napi]
pub fn strip_ansi_text(text: String) -> String {
    strip_ansi(&text)
}

/// Keeps at most the last `limit` UTF-8 bytes, cut at a line boundary so the
/// top is not half a line — byte-sliced, because `chars().count()` semantics
/// would let Cyrillic or box-drawing output blow past its budget.
fn tail_bytes(text: &str, limit: usize) -> String {
    let buf = text.as_bytes();
    if buf.len() <= limit {
        return text.to_string();
    }
    let slice = &buf[buf.len() - limit..];
    // Starting mid-character decodes to U+FFFD; the newline cut normally
    // removes it along with the rest of the partial first line.
    let cut = String::from_utf8_lossy(slice);
    match cut.find('\n') {
        Some(idx) => cut[idx + 1..].to_string(),
        None => cut.trim_start_matches('\u{FFFD}').to_string(),
    }
}

/// Combined hot path for persisting one terminal's screen: sanitize, then cap.
/// Synchronous and cheap enough to run on the JS thread (a capped 64 KiB walk),
/// but it replaces two full-string passes with zero-copy slicing in Rust, so a
/// multi-megabyte build log costs a scan instead of tens of thousands of
/// per-character string operations before every scrollback save.
#[napi]
pub fn sanitize_scrollback(text: String, limit: u32) -> String {
    let clean = strip_ansi(&text);
    tail_bytes(&clean, limit as usize)
}
