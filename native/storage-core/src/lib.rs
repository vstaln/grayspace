use napi::bindgen_prelude::{AsyncTask, Result};
use napi::{Env, Error, Task};
use napi_derive::napi;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::process;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);
fn rand_suffix() -> u64 {
    COUNTER.fetch_add(1, Ordering::Relaxed) ^ (process::id() as u64).wrapping_mul(0x9E3779B97F4A7C15)
}

fn write_atomic_sync(path: &str, text: &str, keep_backup: bool) -> std::result::Result<(), String> {
    let path = Path::new(path);
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let temp = dir.join(format!(".{nanos}-{}-{}.tmp", process::id(), rand_suffix()));

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

#[napi]
pub fn write_text_atomic(path: String, text: String, keep_backup: bool) -> AsyncTask<WriteTextAtomicTask> {
    AsyncTask::new(WriteTextAtomicTask {
        path,
        text,
        keep_backup,
    })
}

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
                        i += 1;
                    }
                    continue;
                }
                ']' => {
                    i += 2;
                    while i < n
                        && chars[i] != '\u{7}'
                        && chars[i] != '\u{9c}'
                        && !(chars[i] == '\u{1b}' && i + 1 < n && chars[i + 1] == '\\')
                    {
                        i += 1;
                    }
                    if i < n {
                        i += if chars[i] == '\u{7}' || chars[i] == '\u{9c}' { 1 } else { 2 };
                    }
                    continue;
                }
                '(' | ')' | '*' | '+' => {
                    i += 3.min(n - i);
                    continue;
                }
                'P' | 'X' | '^' | '_' => {
                    i += 2;
                    while i < n
                        && chars[i] != '\u{9c}'
                        && !(chars[i] == '\u{1b}' && i + 1 < n && chars[i + 1] == '\\')
                    {
                        i += 1;
                    }
                    if i < n {
                        i += if chars[i] == '\u{9c}' { 1 } else { 2 };
                    }
                    continue;
                }
                _ => {}
            }
        }
        if c == '\u{9b}' {
            i += 1;
            while i < n && !is_final(chars[i]) {
                i += 1;
            }
            if i < n {
                i += 1;
            }
            continue;
        }
        if matches!(c, '\u{9d}' | '\u{90}' | '\u{98}' | '\u{9e}' | '\u{9f}') {
            i += 1;
            while i < n
                && chars[i] != '\u{9c}'
                && !(chars[i] == '\u{1b}' && i + 1 < n && chars[i + 1] == '\\')
            {
                i += 1;
            }
            if i < n {
                i += if chars[i] == '\u{9c}' { 1 } else { 2 };
            }
            continue;
        }
        if c == '\u{9c}' {
            i += 1;
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

#[napi]
pub fn strip_ansi_text(text: String) -> String {
    strip_ansi(&text)
}

fn tail_bytes(text: &str, limit: usize) -> String {
    let buf = text.as_bytes();
    if buf.len() <= limit {
        return text.to_string();
    }
    let slice = &buf[buf.len() - limit..];
    let cut = String::from_utf8_lossy(slice);
    match cut.find('\n') {
        Some(idx) => cut[idx + 1..].to_string(),
        None => cut.trim_start_matches('\u{FFFD}').to_string(),
    }
}

#[napi]
pub fn sanitize_scrollback(text: String, limit: u32) -> String {
    let clean = strip_ansi(&text);
    tail_bytes(&clean, limit as usize)
}
