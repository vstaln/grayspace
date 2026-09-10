#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod engine;
mod ui;

use anyhow::Result;
use eframe::egui;
use engine::{ControlServer, TerminalEvent, TerminalManager};
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
        return run_engine(manager);
    }
    let control = ControlServer::start(manager.clone(), token).map_err(anyhow::Error::msg)?;
    manager.set_control_url(control.url());
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
        Box::new(move |_cc| Ok(Box::new(OrcSpaceApp::new(manager, control)))),
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
    let (commands_tx, commands_rx) = mpsc::channel::<Option<EngineCommand>>();
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

    let stdout = io::stdout();
    let mut output = BufWriter::new(stdout.lock());
    emit(&mut output, &EngineEvent::Ready)?;

    loop {
        while let Ok(command) = commands_rx.try_recv() {
            let Some(command) = command else {
                manager.dispose_all();
                return Ok(());
            };
            if matches!(command, EngineCommand::Shutdown) {
                manager.dispose_all();
                return Ok(());
            }
            handle_engine_command(&manager, command, &mut output)?;
        }

        for event in manager.drain_events() {
            let event = match event {
                TerminalEvent::Output { id, data } => EngineEvent::Data { id, data },
                TerminalEvent::Exited { id } => EngineEvent::Exit { id },
            };
            emit(&mut output, &event)?;
        }
        thread::sleep(Duration::from_millis(10));
    }
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
    output: &mut BufWriter<impl Write>,
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

fn emit(output: &mut BufWriter<impl Write>, event: &EngineEvent) -> Result<()> {
    serde_json::to_writer(&mut *output, event)?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::parse_engine_command;

    #[test]
    fn malformed_engine_command_is_rejected_without_being_eof() {
        assert!(parse_engine_command("not-json").is_err());
        assert!(parse_engine_command("   ").unwrap().is_none());
    }
}
