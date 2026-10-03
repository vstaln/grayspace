#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![recursion_limit = "256"]

pub mod engine;
pub mod files_panel;
pub mod plan_panel;
pub mod shell;
pub mod views_files;
pub mod views_orchestration;
pub mod views_planner;
pub mod views_terminal;
pub mod views_browser;
pub mod cli_run;

use anyhow::Result;
use crate::engine::{ControlServer, TerminalEvent, TerminalManager};
use grayspace_app::ipc::persist_control_token;
use rgpui::AppContext as _;

/// Browser-tab shims over the vendored wry element (`grayspace_app::webview`,
/// feature `webview`). They live on the bin crate because `views_browser`
/// does: `webview.rs` is a lib module only when the feature is on, and the
/// bin must compile with it off too.
#[allow(dead_code)]
pub fn next_webview_id() -> usize {
    #[cfg(feature = "webview")]
    {
        grayspace_app::webview::WebView::next_id()
    }
    #[cfg(not(feature = "webview"))]
    {
        static NEXT_WV_ID: std::sync::atomic::AtomicUsize =
            std::sync::atomic::AtomicUsize::new(1);
        NEXT_WV_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }
}

#[allow(dead_code)]
pub fn drain_closed_webviews() -> Vec<usize> {
    #[cfg(feature = "webview")]
    {
        grayspace_app::webview::WebView::drain_closed()
    }
    #[cfg(not(feature = "webview"))]
    {
        Vec::new()
    }
}

/// The Browser tab's element: the real wry child when the `webview` feature
/// is on, a same-size placeholder div when it is off (default `cargo check`
/// / `cargo test` builds).
#[allow(dead_code)]
pub fn webview_element(id: usize, url: String) -> rgpui::Div {
    use rgpui::ParentElement as _;
    use rgpui::Styled as _;
    let _ = url;
    // Real wry child when the `webview` feature is on (Task 5 wires the
    // element here); same-size placeholder div when off so default
    // `cargo check` / `cargo test` builds keep compiling.
    #[cfg(feature = "webview")]
    {
        let _ = id;
        todo!("webview feature element")
    }
    #[cfg(not(feature = "webview"))]
    {
        let _ = id;
        rgpui::div().child("Browser - wry child renders here (Task 5)".to_string())
    }
}
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{self, BufRead, BufWriter, Write};
use std::sync::mpsc;
use std::thread;

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if !args.is_empty() && args[0] != "--gui" {
        if args[0] == "--engine" {
            let token = std::env::var("GRAYSPACE_TOKEN")
                .ok()
                .filter(|value| value.len() >= 32)
                .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
            if let Err(error) = grayspace_app::platform::contain_engine_process() {
                eprintln!("engine process containment unavailable: {error}");
            }
            return run_engine(TerminalManager::streaming(token));
        }

        // Run CLI command (whoami, workers, tell, plan, browser, status, help, etc.)
        if let Err(error) = cli_run::run() {
            let prog = std::env::args()
                .next()
                .and_then(|p| std::path::Path::new(&p).file_stem().map(|s| s.to_string_lossy().into_owned()))
                .unwrap_or_else(|| "grayspace".to_string());
            eprintln!("{prog}: {error}");
            std::process::exit(1);
        }
        return Ok(());
    }

    let token = std::env::var("GRAYSPACE_TOKEN")
        .ok()
        .filter(|value| value.len() >= 32)
        .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
    let manager = TerminalManager::new(token.clone());
    let _manager_keepalive = manager.clone();
    let control =
        ControlServer::start(manager.clone(), token.clone()).map_err(anyhow::Error::msg)?;
    // A second instance must not replace the active instance's token before
    // discovering that its control socket is already occupied.
    persist_control_token(&token)
        .map_err(|error| anyhow::anyhow!("cannot publish control token: {error}"))?;
    manager.set_control_socket(control.socket_path());
    // One terminal on launch; a QA capture asks for more so a layout has
    // something to arrange.
    let terminals = std::env::var("GRAYSPACE_CAPTURE_TERMINALS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(1)
        .clamp(1, 8);
    for index in 1..=terminals {
        manager
            .spawn(format!("terminal-{index}"))
            .map_err(anyhow::Error::msg)?;
    }

    // The control server outlives the window on its own thread; the manager
    // moves into the RootView, which polls snapshots()/drain_events() on a
    // 250ms refresh timer (same non-blocking drain the egui loop used).
    let _ = &control;
    let root_manager = manager.clone();
    rgpui_platform::application().run(|cx: &mut rgpui::App| {
        cx.open_window(rgpui::WindowOptions::default(), move |_window, cx| {
            cx.new(|cx| crate::shell::RootView::new(root_manager.clone(), cx))
        })
        .expect("open GraySpace window");
        cx.activate(true);
    });

    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum EngineCommand {
    Spawn {
        id: String,
        #[serde(default = "default_cols")]
        cols: u16,
        #[serde(default = "default_rows")]
        rows: u16,
        cwd: Option<String>,
        shell: String,
        #[serde(default)]
        env: HashMap<String, String>,
        request_id: Option<String>,
    },
    Write {
        id: String,
        data: String,
        request_id: Option<String>,
    },
    Resize {
        id: String,
        cols: u16,
        rows: u16,
        request_id: Option<String>,
    },
    PauseOutput {
        id: String,
        paused: bool,
        request_id: Option<String>,
    },
    Dispose {
        id: String,
        request_id: Option<String>,
    },
    Shutdown,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum EngineEvent {
    Ready,
    Data {
        id: String,
        data: String,
    },
    Exit {
        id: String,
    },
    Response {
        request_id: Option<String>,
        ok: bool,
        id: Option<String>,
        error: Option<String>,
    },
}

fn default_cols() -> u16 {
    80
}

fn default_rows() -> u16 {
    24
}

fn run_engine(manager: TerminalManager) -> Result<()> {
    let (commands_tx, commands_rx) = mpsc::sync_channel::<Option<EngineCommand>>(1024);
    thread::Builder::new()
        .name("grayspace-engine-stdin".to_owned())
        .spawn(move || {
            let stdin = io::stdin();
            for line in stdin.lock().lines() {
                let line = match line {
                    Ok(line) => line,
                    Err(error) => {
                        eprintln!("engine stdin read failed: {error}");
                        break;
                    }
                };
                if line.trim().is_empty() {
                    continue;
                }
                match parse_engine_command(&line) {
                    Ok(None) => continue,
                    Ok(command) => {
                        if commands_tx.send(command).is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        // A malformed command must not be confused with EOF:
                        // dropping one bad packet should not kill every PTY.
                        eprintln!("ignored malformed engine command: {error}");
                    }
                }
            }
            let _ = commands_tx.send(None);
        })?;

    // Only the output thread touches stdout. A full OS pipe must never hold
    // the command loop hostage while it is trying to interrupt or dispose.
    let (output, responses) = mpsc::sync_channel::<Vec<u8>>(4096);
    let output = EngineOutput {
        sender: output,
        manager: manager.clone(),
    };
    emit(&output, &EngineEvent::Ready)?;

    let pump_manager = manager.clone();
    thread::Builder::new()
        .name("grayspace-engine-output".to_owned())
        .spawn(move || {
            let mut writer = BufWriter::new(io::stdout());
            loop {
                if flush_responses(&mut writer, &responses).is_err() {
                    pump_manager.dispose_all();
                    return;
                }
                let batch: Vec<EngineEvent> = pump_manager
                    .wait_events()
                    .into_iter()
                    .map(|event| match event {
                        TerminalEvent::Output { id, data } => EngineEvent::Data { id, data },
                        TerminalEvent::Exited { id } => EngineEvent::Exit { id },
                    })
                    .collect();
                // stdout is gone (the app closed the pipe): nothing left to
                // forward to, so stop pumping.
                for event in batch {
                    // Give ACKs priority between output chunks, preserving
                    // the PTY stream's own data/exit order.
                    if flush_responses(&mut writer, &responses)
                        .and_then(|_| write_event(&mut writer, &event))
                        .is_err()
                    {
                        pump_manager.dispose_all();
                        return;
                    }
                }
            }
        })?;

    // Blocking receive: no polling tick between a keystroke arriving and the
    // shell being told about it.
    let result = (|| -> Result<()> {
        while let Ok(command) = commands_rx.recv() {
            let Some(command) = command else { break };
            if matches!(command, EngineCommand::Shutdown) {
                break;
            }
            handle_engine_command(&manager, command, &output)?;
        }
        Ok(())
    })();
    manager.dispose_all();
    result
}

fn parse_engine_command(line: &str) -> Result<Option<EngineCommand>, serde_json::Error> {
    if line.trim().is_empty() {
        return Ok(None);
    }
    serde_json::from_str(line).map(Some)
}

fn handle_engine_command(
    manager: &TerminalManager,
    command: EngineCommand,
    output: &EngineOutput,
) -> Result<()> {
    match command {
        EngineCommand::Spawn {
            id,
            cols,
            rows,
            cwd,
            shell,
            env,
            request_id,
        } => {
            let result = manager.spawn_with_options(id.clone(), cols, rows, cwd, shell, env);
            emit(
                output,
                &EngineEvent::Response {
                    request_id,
                    ok: result.is_ok(),
                    id: Some(id),
                    error: result.err(),
                },
            )?;
        }
        EngineCommand::Write {
            id,
            data,
            request_id,
        } => {
            let result = manager.write_raw(&id, data.as_bytes());
            emit(
                output,
                &EngineEvent::Response {
                    request_id,
                    ok: result.is_ok(),
                    id: Some(id),
                    error: result.err(),
                },
            )?;
        }
        EngineCommand::Resize {
            id,
            cols,
            rows,
            request_id,
        } => {
            let result = manager.resize(&id, cols, rows);
            emit(
                output,
                &EngineEvent::Response {
                    request_id,
                    ok: result.is_ok(),
                    id: Some(id),
                    error: result.err(),
                },
            )?;
        }
        EngineCommand::PauseOutput {
            id,
            paused,
            request_id,
        } => {
            let result = manager.set_output_paused(&id, paused);
            emit(
                output,
                &EngineEvent::Response {
                    request_id,
                    ok: result.is_ok(),
                    id: Some(id),
                    error: result.err(),
                },
            )?;
        }
        EngineCommand::Dispose { id, request_id } => {
            let result = manager.dispose(&id);
            emit(
                output,
                &EngineEvent::Response {
                    request_id,
                    ok: result.is_ok(),
                    id: Some(id),
                    error: result.err(),
                },
            )?;
        }
        EngineCommand::Shutdown => {}
    }
    Ok(())
}

struct EngineOutput {
    sender: mpsc::SyncSender<Vec<u8>>,
    manager: TerminalManager,
}

fn emit(output: &EngineOutput, event: &EngineEvent) -> Result<()> {
    let mut encoded = serde_json::to_vec(event)?;
    encoded.push(b'\n');
    output
        .sender
        .try_send(encoded)
        .map_err(|error| anyhow::anyhow!("engine response queue unavailable: {error}"))?;
    output.manager.notify_response();
    Ok(())
}

fn flush_responses(writer: &mut impl Write, responses: &mpsc::Receiver<Vec<u8>>) -> Result<()> {
    // Bound each pass so continuous input cannot starve terminal output.
    for _ in 0..4096 {
        let Ok(encoded) = responses.try_recv() else {
            break;
        };
        writer.write_all(&encoded)?;
    }
    writer.flush()?;
    Ok(())
}

fn write_event(writer: &mut impl Write, event: &EngineEvent) -> Result<()> {
    serde_json::to_writer(&mut *writer, event)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_finish_while_stdout_is_not_being_drained() {
        let manager = TerminalManager::new("test".to_owned());
        let (output, responses) = mpsc::sync_channel(2);
        let output = EngineOutput {
            sender: output,
            manager: manager.clone(),
        };
        // No output consumer: handling a command must still finish.
        for _ in 0..2 {
            handle_engine_command(
                &manager,
                EngineCommand::Write {
                    id: "missing".to_owned(),
                    data: "\u{3}".to_owned(),
                    request_id: Some("w1".to_owned()),
                },
                &output,
            )
            .unwrap();
        }
        // Bounded overload is explicit, never an unbounded blocking send.
        assert!(emit(&output, &EngineEvent::Ready).is_err());
        let mut received = Vec::new();
        flush_responses(&mut received, &responses).unwrap();
        let lines = String::from_utf8(received).unwrap();
        assert_eq!(lines.lines().count(), 2);
        for line in lines.lines() {
            let event: serde_json::Value = serde_json::from_str(line).unwrap();
            assert_eq!(event["type"], "response");
            assert_eq!(event["ok"], false);
        }
    }

    #[test]
    fn malformed_engine_command_is_rejected_without_being_eof() {
        assert!(parse_engine_command("not-json").is_err());
        assert!(parse_engine_command("   ").unwrap().is_none());
    }
}
