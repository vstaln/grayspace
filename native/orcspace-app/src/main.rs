#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod engine;
mod process_job;
mod ui;

use anyhow::Result;
use eframe::egui;
use engine::{ControlServer, TerminalEvent, TerminalManager};
use orcspace_app::ipc::persist_control_token;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{self, BufRead, BufWriter, Write};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use ui::OrcSpaceApp;

fn main() -> Result<()> {
    let token = std::env::var("ORCSPACE_TOKEN")
        .ok()
        .filter(|value| value.len() >= 32)
        .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());

    let manager = TerminalManager::new(token.clone());
    if std::env::args().any(|arg| arg == "--engine") {
        if let Err(error) = process_job::contain_engine_process() {
            eprintln!("engine process containment unavailable: {error}");
        }
        return run_engine(manager);
    }
    persist_control_token(&token)
        .map_err(|error| anyhow::anyhow!("cannot publish control token: {error}"))?;
    let control = ControlServer::start(manager.clone(), token).map_err(anyhow::Error::msg)?;
    manager.set_control_socket(control.socket_path());
    manager.spawn("terminal-1").map_err(anyhow::Error::msg)?;

    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1440.0, 920.0])
            .with_min_inner_size([960.0, 640.0])
            .with_title("OrcSpace"),
        ..Default::default()
    };

    eframe::run_native(
        "OrcSpace",
        options,
        Box::new(move |cc| {
            // Applied before the first frame so nothing flashes in egui's
            // default palette on the way to OrcSpace's.
            orcspace_app::theme::apply(&cc.egui_ctx);
            Ok(Box::new(OrcSpaceApp::new(manager, control)))
        }),
    )?;

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
    Data { id: String, data: String },
    Exit { id: String },
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
        .name("orcspace-engine-stdin".to_owned())
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
    emit(&output, &EngineEvent::Ready)?;

    let pump_manager = manager.clone();
    thread::Builder::new()
        .name("orcspace-engine-output".to_owned())
        .spawn(move || {
            let mut writer = BufWriter::new(io::stdout());
            loop {
                if flush_responses(&mut writer, &responses).is_err() {
                    pump_manager.dispose_all();
                    return;
                }
                // Wakes as soon as a PTY produces output; the timeout only
                // bounds how long the thread sleeps when everything is idle.
                let batch: Vec<EngineEvent> = pump_manager
                    .wait_events(Duration::from_millis(10))
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
                        .and_then(|_| write_event(&mut writer, &event)).is_err() {
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

type EngineOutput = mpsc::SyncSender<Vec<u8>>;

fn emit(output: &EngineOutput, event: &EngineEvent) -> Result<()> {
    let mut encoded = serde_json::to_vec(event)?;
    encoded.push(b'\n');
    output.try_send(encoded).map_err(|error| anyhow::anyhow!("engine response queue unavailable: {error}"))
}

fn flush_responses(writer: &mut impl Write, responses: &mpsc::Receiver<Vec<u8>>) -> Result<()> {
    // Bound each pass so continuous input cannot starve terminal output.
    for _ in 0..4096 {
        let Ok(encoded) = responses.try_recv() else { break };
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
        // No output consumer: handling a command must still finish.
        for _ in 0..2 {
            handle_engine_command(&manager, EngineCommand::Write {
                id: "missing".to_owned(), data: "\u{3}".to_owned(),
                request_id: Some("w1".to_owned()),
            }, &output).unwrap();
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
