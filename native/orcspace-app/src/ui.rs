use crate::engine::{ControlServer, TerminalEvent, TerminalManager};
use eframe::egui::{self, Color32, FontId, Pos2, Rect, Sense, Stroke, TextStyle, Vec2};
use egui::containers::{CentralPanel, Panel};
use rodio::{Decoder, DeviceSinkBuilder, MixerDeviceSink, Player};
use std::{fs::File, io::BufReader, time::Duration};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Tab {
    Canvas,
    Code,
}

pub struct OrcSpaceApp {
    manager: TerminalManager,
    _control: ControlServer,
    tab: Tab,
    selected_terminal: Option<String>,
    new_terminal_id: String,
    input: String,
    canvas_offset: Vec2,
    canvas_zoom: f32,
    music: MusicPlayer,
    last_error: Option<String>,
}

impl OrcSpaceApp {
    pub fn new(manager: TerminalManager, control: ControlServer) -> Self {
        let selected_terminal = manager
            .snapshots()
            .first()
            .map(|snapshot| snapshot.id.clone());
        Self {
            manager,
            _control: control,
            tab: Tab::Canvas,
            selected_terminal,
            new_terminal_id: "terminal-1".to_owned(),
            input: String::new(),
            canvas_offset: Vec2::ZERO,
            canvas_zoom: 1.0,
            music: MusicPlayer::default(),
            last_error: None,
        }
    }

    fn show_tabs(&mut self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            ui.selectable_value(&mut self.tab, Tab::Canvas, "Canvas");
            ui.selectable_value(&mut self.tab, Tab::Code, "Code");
            ui.separator();
            ui.label("Rust native runtime");
            if let Some(url) = self.manager.control_socket() {
                ui.small(url);
            }
        });
    }

    fn show_canvas(&mut self, ui: &mut egui::Ui) {
        let available = ui.available_rect_before_wrap();
        let response = ui.allocate_rect(available, Sense::drag());
        if response.dragged() {
            self.canvas_offset += response.drag_delta();
        }
        let zoom_delta = ui.input(|input| input.zoom_delta());
        if zoom_delta != 1.0 {
            self.canvas_zoom = (self.canvas_zoom * zoom_delta).clamp(0.35, 3.0);
        }

        let painter = ui.painter_at(available);
        painter.rect_filled(available, 0.0, Color32::from_rgb(18, 21, 27));
        let spacing = 48.0 * self.canvas_zoom;
        let origin = available.center() + self.canvas_offset;
        let mut x = origin.x.rem_euclid(spacing);
        while x < available.right() {
            painter.line_segment(
                [
                    Pos2::new(x, available.top()),
                    Pos2::new(x, available.bottom()),
                ],
                Stroke::new(1.0, Color32::from_rgb(31, 36, 45)),
            );
            x += spacing;
        }
        let mut y = origin.y.rem_euclid(spacing);
        while y < available.bottom() {
            painter.line_segment(
                [
                    Pos2::new(available.left(), y),
                    Pos2::new(available.right(), y),
                ],
                Stroke::new(1.0, Color32::from_rgb(31, 36, 45)),
            );
            y += spacing;
        }

        let card = Rect::from_center_size(
            origin + Vec2::new(-170.0 * self.canvas_zoom, -90.0 * self.canvas_zoom),
            Vec2::new(320.0 * self.canvas_zoom, 150.0 * self.canvas_zoom),
        );
        painter.rect_filled(card, 10.0, Color32::from_rgb(35, 41, 52));
        painter.rect_stroke(
            card,
            10.0,
            Stroke::new(1.0, Color32::from_rgb(72, 91, 119)),
            egui::StrokeKind::Outside,
        );
        painter.text(
            card.left_top() + Vec2::new(18.0, 18.0),
            egui::Align2::LEFT_TOP,
            "Canvas",
            FontId::proportional(18.0 * self.canvas_zoom),
            Color32::WHITE,
        );
        painter.text(
            card.left_top() + Vec2::new(18.0, 53.0),
            egui::Align2::LEFT_TOP,
            "Rust-owned scene state",
            FontId::proportional(14.0 * self.canvas_zoom),
            Color32::from_rgb(173, 184, 201),
        );
        painter.text(
            available.right_bottom() - Vec2::new(18.0, 18.0),
            egui::Align2::RIGHT_BOTTOM,
            format!("zoom {:.0}% · drag to pan", self.canvas_zoom * 100.0),
            FontId::proportional(12.0),
            Color32::from_rgb(145, 154, 170),
        );
    }

    fn show_code(&mut self, ui: &mut egui::Ui) {
        Panel::left("terminals")
            .resizable(true)
            .default_size(220.0)
            .show(ui, |ui| {
                ui.heading("Terminals");
                ui.horizontal(|ui| {
                    ui.text_edit_singleline(&mut self.new_terminal_id);
                    if ui.button("+").clicked() {
                        let id = self.new_terminal_id.trim().to_owned();
                        if !id.is_empty() {
                            match self.manager.spawn(id.clone()) {
                                Ok(()) => self.selected_terminal = Some(id),
                                Err(error) => self.last_error = Some(error),
                            }
                        }
                    }
                });
                ui.separator();
                for snapshot in self.manager.snapshots() {
                    let label = if snapshot.alive {
                        format!("● {}", snapshot.id)
                    } else {
                        format!("○ {}", snapshot.id)
                    };
                    if ui
                        .selectable_label(
                            self.selected_terminal.as_deref() == Some(snapshot.id.as_str()),
                            label,
                        )
                        .clicked()
                    {
                        self.selected_terminal = Some(snapshot.id);
                    }
                }
                ui.separator();
                ui.label("Music");
                ui.horizontal(|ui| {
                    ui.text_edit_singleline(&mut self.music.path);
                    if ui.button("Play").clicked() {
                        if let Err(error) = self.music.play() {
                            self.last_error = Some(error);
                        }
                    }
                });
                if ui.button("Stop").clicked() {
                    self.music.stop();
                }
                if let Some(error) = &self.music.error {
                    ui.colored_label(Color32::LIGHT_RED, error);
                }
            });

        CentralPanel::default().show(ui, |ui| {
            let Some(id) = self.selected_terminal.clone() else {
                ui.centered_and_justified(|ui| {
                    ui.label("Create or select a terminal");
                });
                return;
            };
            let Ok(snapshot) = self.manager.snapshot(&id) else {
                ui.label("Terminal is unavailable");
                return;
            };
            ui.horizontal(|ui| {
                ui.heading(&id);
                ui.small(if snapshot.alive { "running" } else { "exited" });
                if ui.button("Dispose").clicked() {
                    if let Err(error) = self.manager.dispose(&id) {
                        self.last_error = Some(error);
                    } else {
                        self.selected_terminal = None;
                    }
                }
            });
            let mut output = snapshot.output;
            egui::ScrollArea::vertical()
                .stick_to_bottom(true)
                .max_height(ui.available_height() - 72.0)
                .show(ui, |ui| {
                    ui.add(
                        egui::TextEdit::multiline(&mut output)
                            .font(TextStyle::Monospace)
                            .desired_width(f32::INFINITY)
                            .interactive(false),
                    );
                });
            ui.horizontal(|ui| {
                let response = ui.add_sized(
                    [ui.available_width() - 78.0, 30.0],
                    egui::TextEdit::singleline(&mut self.input)
                        .font(TextStyle::Monospace)
                        .hint_text("Send to terminal…"),
                );
                let send = ui.button("Send").clicked()
                    || (response.lost_focus()
                        && ui.input(|input| input.key_pressed(egui::Key::Enter)));
                if send && !self.input.trim().is_empty() {
                    let text = std::mem::take(&mut self.input);
                    if let Err(error) = self.manager.write_line(&id, &text) {
                        self.last_error = Some(error);
                    }
                }
            });
        });
    }
}

impl Drop for OrcSpaceApp {
    fn drop(&mut self) {
        for snapshot in self.manager.snapshots() {
            let _ = self.manager.dispose(&snapshot.id);
        }
    }
}

impl eframe::App for OrcSpaceApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        for event in self.manager.drain_events() {
            match event {
                TerminalEvent::Output { id, data } => {
                    let _ = (id, data);
                }
                TerminalEvent::Exited { id } => {
                    if self.selected_terminal.as_deref() == Some(id.as_str()) {
                        self.last_error = Some(format!("terminal {id} exited"));
                    }
                }
            }
        }

        Panel::top("tabs").show(ui, |ui| self.show_tabs(ui));
        CentralPanel::default().show(ui, |ui| match self.tab {
            Tab::Canvas => self.show_canvas(ui),
            Tab::Code => self.show_code(ui),
        });
        if let Some(error) = self.last_error.take() {
            Panel::bottom("error").show(ui, |ui| {
                ui.colored_label(Color32::LIGHT_RED, error);
            });
        }
        ui.ctx().request_repaint_after(Duration::from_millis(33));
    }
}

#[derive(Default)]
struct MusicPlayer {
    path: String,
    stream: Option<MixerDeviceSink>,
    sink: Option<Player>,
    error: Option<String>,
}

impl MusicPlayer {
    fn play(&mut self) -> Result<(), String> {
        self.error = None;
        let file = File::open(self.path.trim()).map_err(|error| error.to_string())?;
        let decoder = Decoder::try_from(BufReader::new(file)).map_err(|error| error.to_string())?;
        let stream = DeviceSinkBuilder::open_default_sink().map_err(|error| error.to_string())?;
        let sink = Player::connect_new(stream.mixer());
        sink.append(decoder);
        sink.play();
        self.stream = Some(stream);
        self.sink = Some(sink);
        Ok(())
    }

    fn stop(&mut self) {
        if let Some(sink) = self.sink.take() {
            sink.stop();
        }
        self.stream = None;
    }
}
