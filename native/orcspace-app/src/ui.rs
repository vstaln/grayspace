use crate::engine::{ControlServer, TerminalEvent, TerminalManager};
use eframe::egui::{self, Color32, Sense, Vec2};
use egui::containers::{CentralPanel, Panel};
use std::time::Duration;

/// What the toolbar's "+" can add beside a terminal.
const WIDGETS: [&str; 4] = ["Music Player", "Files", "Plan", "Browser"];

/// The renderer runs xterm at 13px; the cell grid is derived from the font.
const TERMINAL_FONT: f32 = 13.0;

pub struct OrcSpaceApp {
    manager: TerminalManager,
    _control: ControlServer,
    sidebar_open: bool,
    active_tool: Option<String>,
    tools: Vec<String>,
    tool_output: String,
    tool_job: Option<std::sync::mpsc::Receiver<String>>,
    browser_url: String,
    files_panel: crate::files_panel::FilesPanel,
    plan_panel: crate::plan_panel::PlanPanel,
    selected_terminal: Option<String>,
    /// The terminal last told it has the keyboard, so the report is only sent
    /// when that actually changes.
    focused_terminal: Option<String>,
    layout: orcspace_app::code_layout::CodeLayout,
    three_way_split: [f32; 2],
    auto_names: bool,
    settings_open: bool,
    terminal_screens:
        std::collections::HashMap<String, orcspace_app::terminal_screen::TerminalScreen>,
    music_players: std::collections::HashMap<String, MusicPlayer>,
    last_error: Option<String>,
    capture_path: Option<std::path::PathBuf>,
    capture_started: std::time::Instant,
    capture_requested: bool,
    saved_preferences: Option<orcspace_app::ui_preferences::UiPreferences>,
    preferences_retry_at: Option<std::time::Instant>,
}

impl OrcSpaceApp {
    pub fn new(manager: TerminalManager, control: ControlServer) -> Self {
        let preferences = orcspace_app::ui_preferences::UiPreferences::load(
            &orcspace_app::ipc::user_data_dir().join("native-ui.json"),
        );
        let preferences_error = preferences
            .as_ref()
            .err()
            .map(|error| format!("Cannot read UI preferences: {error}"));
        let saved_preferences = preferences.ok();
        let preferences = saved_preferences.clone().unwrap_or_default();
        let selected_terminal = manager
            .snapshots()
            .first()
            .map(|snapshot| snapshot.id.clone());
        let mut app = Self {
            manager,
            _control: control,
            sidebar_open: preferences.sidebar_open,
            active_tool: None,
            tools: Vec::new(),
            tool_output: String::new(),
            tool_job: None,
            browser_url: "https://".into(),
            files_panel: crate::files_panel::FilesPanel::default(),
            plan_panel: crate::plan_panel::PlanPanel::default(),
            selected_terminal,
            focused_terminal: None,
            layout: preferences.layout,
            three_way_split: preferences.three_way_split,
            auto_names: preferences.auto_names,
            settings_open: false,
            terminal_screens: std::collections::HashMap::new(),
            music_players: std::collections::HashMap::new(),
            last_error: preferences_error,
            capture_path: std::env::var_os("ORCSPACE_CAPTURE_PATH").map(Into::into),
            capture_started: std::time::Instant::now(),
            capture_requested: false,
            saved_preferences,
            preferences_retry_at: None,
        };
        // A QA capture can open one widget before the shot; the value is a
        // prefix of its name, so "music" and "plan" both land.
        if let (true, Ok(view)) = (
            app.capture_path.is_some(),
            std::env::var("ORCSPACE_CAPTURE_VIEW"),
        ) {
            let wanted = view.to_lowercase();
            app.settings_open = wanted == "settings";
            if let Some(name) = WIDGETS
                .iter()
                .find(|name| name.to_lowercase().starts_with(&wanted))
            {
                app.open_tool(name);
            }
        }
        app
    }

    fn open_tool(&mut self, name: &str) {
        if self.active_tool.as_deref() == Some(name) {
            return;
        }
        // A read still in flight belongs to the tool being left behind.
        self.tool_job = None;
        if !self.tools.iter().any(|tool| tool == name) {
            self.tools.push(name.into());
        }
        self.active_tool = Some(name.into());
        if name == "Files" && !self.files_panel.initialized() {
            self.files_panel
                .open(std::env::current_dir().unwrap_or_default());
        }
        if name == "Music Player" {
            self.music_players.entry(name.into()).or_default();
        }
        self.refresh_tool();
    }

    fn save_preferences(&mut self) {
        if self
            .preferences_retry_at
            .is_some_and(|retry| std::time::Instant::now() < retry)
        {
            return;
        }
        let Some(saved) = &self.saved_preferences else {
            return;
        };
        let next = orcspace_app::ui_preferences::UiPreferences {
            sidebar_open: self.sidebar_open,
            auto_names: self.auto_names,
            layout: self.layout,
            three_way_split: self.three_way_split,
            extra: saved.extra.clone(),
        };
        if &next == saved {
            return;
        }
        match next.save(&orcspace_app::ipc::user_data_dir().join("native-ui.json")) {
            Ok(()) => {
                self.saved_preferences = Some(next);
                self.preferences_retry_at = None;
            }
            Err(error) => {
                self.preferences_retry_at =
                    Some(std::time::Instant::now() + Duration::from_secs(2));
                self.last_error = Some(format!("Cannot save UI preferences: {error}"));
            }
        }
    }

    fn close_tool(&mut self, name: &str) {
        self.active_tool = None;
        self.tool_job = None;
        self.tool_output.clear();
        self.tools.retain(|tool| tool != name);
        self.music_players.remove(name);
    }

    fn new_terminal(&mut self) {
        // Reader threads can publish final output after dispose returns.
        // Never let those events address a newly opened terminal.
        let id = format!("terminal-{}", uuid::Uuid::new_v4());
        match self.manager.spawn(id.clone()) {
            Ok(()) => {
                self.name_terminal(&id);
                self.selected_terminal = Some(id);
                self.active_tool = None;
            }
            Err(error) => self.last_error = Some(error),
        }
    }

    /// Gives a terminal a name from the shared pool. The name lives on the
    /// manager because `orc tell <name>` has to resolve the same one.
    fn name_terminal(&self, id: &str) {
        let taken = self.manager.names().into_values().collect();
        if let Some(name) = orcspace_app::terminal_names::pick(&taken) {
            self.manager.set_name(id, name);
        }
    }

    /// What a terminal is called on screen. Empty when automatic naming is
    /// off: the renderer shows no badge at all rather than falling back to an id.
    fn display_name(&self, id: &str) -> String {
        if self.auto_names {
            self.manager.name(id).unwrap_or_default()
        } else {
            String::new()
        }
    }

    fn refresh_tool(&mut self) {
        let Some(tool) = self.active_tool.clone() else {
            return;
        };
        if tool == "Files" {
            self.files_panel.refresh();
            return;
        }
        if tool == "Plan" {
            self.plan_panel.refresh();
            return;
        }
        if tool != "Git" {
            return;
        }
        if self.tool_job.is_some() {
            return;
        }
        self.tool_output.clear();
        let cwd = self
            .selected_terminal
            .as_ref()
            .and_then(|id| self.manager.snapshot(id).ok())
            .map(|s| std::path::PathBuf::from(s.cwd))
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
        let (sender, receiver) = std::sync::mpsc::channel();
        self.tool_job = Some(receiver);
        std::thread::spawn(move || {
            let result: Result<String, String> = (|| {
                let mut command = std::process::Command::new("git");
                command
                    .args(["--no-optional-locks", "status", "--short", "--branch"])
                    .current_dir(cwd);
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    command.creation_flags(0x08000000);
                }
                let output = command.output().map_err(|error| error.to_string())?;
                if !output.status.success() {
                    return Err(String::from_utf8_lossy(&output.stderr).into_owned());
                }
                Ok(String::from_utf8_lossy(&output.stdout).into_owned())
            })();
            let _ = sender.send(result.unwrap_or_else(|error| format!("Error: {error}")));
        });
    }

    fn show_toolbar(&mut self, ui: &mut egui::Ui) {
        let title_rect = ui.max_rect();
        let drag = ui.interact(
            title_rect,
            ui.id().with("window-drag"),
            Sense::click_and_drag(),
        );
        if drag.double_clicked() {
            let maximized = ui.input(|input| input.viewport().maximized.unwrap_or(false));
            ui.ctx()
                .send_viewport_cmd(egui::ViewportCommand::Maximized(!maximized));
        } else if drag.drag_started() {
            ui.ctx().send_viewport_cmd(egui::ViewportCommand::StartDrag);
        }
        // The sidebar's surface runs up behind the title bar, as it does in the
        // renderer, so the two do not read as stacked panels.
        if self.sidebar_open {
            let rect = ui.max_rect();
            let under =
                rect.with_max_x(rect.left() + orcspace_app::theme::geometry::SIDEBAR_EXPANDED);
            ui.painter()
                .rect_filled(under, 0.0, orcspace_app::theme::monochrome::SURFACE);
            ui.painter()
                .vline(under.right() - 0.5, under.y_range(), hairline());
        }
        ui.horizontal_centered(|ui| {
            ui.spacing_mut().item_spacing.x = 4.0;
            ui.add_space(if self.sidebar_open {
                orcspace_app::theme::geometry::SIDEBAR_EXPANDED
            } else {
                4.0
            });
            let toggle = pill(ui, self.sidebar_open, Some(icon::panel_left), "").on_hover_text(
                if self.sidebar_open {
                    "Collapse sidebar"
                } else {
                    "Expand sidebar"
                },
            );
            if toggle.clicked() {
                self.sidebar_open = !self.sidebar_open;
            }
            let add = pill(ui, false, Some(icon::plus), "").on_hover_text("Add to workspace");
            egui::Popup::menu(&add).show(|ui| {
                if ui.button("Terminal").clicked() {
                    self.new_terminal();
                    ui.close();
                }
                for name in WIDGETS {
                    if ui.button(name).clicked() {
                        self.open_tool(name);
                        ui.close();
                    }
                }
            });
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                ui.add_space(4.0);
                if !cfg!(target_os = "macos") {
                    window_controls(ui);
                }
                if pill(
                    ui,
                    self.active_tool.as_deref() == Some("Git"),
                    Some(icon::git_branch),
                    "Git",
                )
                .clicked()
                {
                    self.open_tool("Git");
                }
                let arrange =
                    pill(ui, false, Some(icon::layout_grid), "").on_hover_text("Arrange terminals");
                egui::Popup::menu(&arrange).show(|ui| {
                    for mode in orcspace_app::code_layout::CodeLayout::ALL {
                        let picked = self.layout == mode;
                        if ui
                            .selectable_label(picked, mode.label())
                            .on_hover_text(mode.hint())
                            .clicked()
                        {
                            self.layout = mode;
                            ui.close();
                        }
                    }
                });
            });
        });
    }

    fn show_sidebar(&mut self, ui: &mut egui::Ui) {
        Panel::left("sidebar")
            .resizable(false)
            .exact_size(orcspace_app::theme::geometry::SIDEBAR_EXPANDED)
            .frame(egui::Frame::NONE.fill(orcspace_app::theme::monochrome::SURFACE))
            .show(ui, |ui| {
                let full = ui.max_rect();
                ui.painter()
                    .vline(full.right() - 0.5, full.y_range(), hairline());
                let header = full.with_max_y(full.top() + 44.0);
                ui.painter().text(
                    egui::pos2(header.left() + 12.0, header.center().y),
                    egui::Align2::LEFT_CENTER,
                    "CODE",
                    orcspace_app::theme::semibold(11.0),
                    orcspace_app::theme::text::FAINT,
                );
                ui.painter()
                    .hline(full.x_range(), header.bottom() - 0.5, hairline());
                ui.advance_cursor_after_rect(header);
                // The list scrolls rather than running underneath Settings,
                // which is drawn at a fixed place on the bottom edge.
                let list = egui::Rect::from_min_max(
                    egui::pos2(full.left(), header.bottom()),
                    egui::pos2(full.right(), full.bottom() - 52.0),
                );
                ui.scope_builder(egui::UiBuilder::new().max_rect(list), |ui| {
                    ui.spacing_mut().item_spacing.y = 2.0;
                    egui::Frame::NONE.inner_margin(8).show(ui, |ui| {
                        egui::ScrollArea::vertical()
                            .id_salt("sidebar-list")
                            .show(ui, |ui| {
                                for snapshot in self.manager.snapshots() {
                                    let selected = self.active_tool.is_none()
                                        && self.selected_terminal.as_deref()
                                            == Some(snapshot.id.as_str());
                                    // The row has to stay identifiable, so it falls back to
                                    // the id where the card header shows nothing.
                                    let name = self.display_name(&snapshot.id);
                                    let label = if name.is_empty() { &snapshot.id } else { &name };
                                    if list_row(ui, selected, Some(snapshot.alive), label).clicked()
                                    {
                                        self.selected_terminal = Some(snapshot.id);
                                        self.active_tool = None;
                                    }
                                }
                                for name in self.tools.clone() {
                                    if list_row(
                                        ui,
                                        self.active_tool.as_deref() == Some(&name),
                                        None,
                                        &name,
                                    )
                                    .clicked()
                                    {
                                        self.open_tool(&name);
                                    }
                                }
                            });
                    });
                });
                self.show_sidebar_settings(ui);
            });
    }

    fn show_sidebar_settings(&mut self, ui: &mut egui::Ui) {
        let full = ui.max_rect();
        let row = egui::Rect::from_min_max(
            egui::pos2(full.left() + 8.0, full.bottom() - 44.0),
            egui::pos2(full.right() - 8.0, full.bottom() - 8.0),
        );
        ui.painter()
            .hline(full.x_range(), row.top() - 8.0, hairline());
        let settings = ui
            .scope_builder(egui::UiBuilder::new().max_rect(row), |ui| {
                list_row(ui, self.settings_open, None, "Settings")
            })
            .inner;
        if settings.clicked() {
            self.settings_open = !self.settings_open;
        }
    }

    fn show_code(&mut self, ui: &mut egui::Ui) {
        if self.sidebar_open {
            self.show_sidebar(ui);
        }

        CentralPanel::default()
            .frame(egui::Frame::NONE.fill(orcspace_app::theme::monochrome::BASE))
            .show(ui, |ui| {
                if let Some(tool) = self.active_tool.clone() {
                    let actions = widget_header(
                        ui,
                        &tool,
                        None,
                        matches!(tool.as_str(), "Git" | "Plan" | "Files"),
                    );
                    if actions.close {
                        self.close_tool(&tool);
                        return;
                    }
                    if actions.refresh {
                        self.refresh_tool();
                    }
                    if tool == "Music Player" {
                        self.music_players.entry(tool).or_default().show(ui);
                    } else if tool == "Files" {
                        self.files_panel.show(ui);
                    } else if tool == "Browser" {
                        ui.horizontal(|ui| {
                            ui.add(
                                egui::TextEdit::singleline(&mut self.browser_url)
                                    .desired_width(420.0)
                                    .hint_text("https://"),
                            );
                            if ui.button("Open externally").clicked() {
                                if self.browser_url.starts_with("https://")
                                    || self.browser_url.starts_with("http://")
                                {
                                    ui.ctx().open_url(egui::OpenUrl::new_tab(&self.browser_url));
                                } else {
                                    self.last_error =
                                        Some("Use an http:// or https:// address".into());
                                }
                            }
                        });
                        ui.weak("Embedded browser is not connected yet.");
                    } else if tool == "Plan" {
                        self.plan_panel.show(ui);
                    } else {
                        egui::ScrollArea::both().show(ui, |ui| {
                            ui.monospace(&self.tool_output);
                        });
                    }
                    return;
                }

                let snapshots = self.manager.snapshots();
                if snapshots.is_empty() {
                    ui.centered_and_justified(|ui| ui.label("Create a terminal to start"));
                    return;
                }
                let focus = snapshots
                    .iter()
                    .position(|snapshot| {
                        Some(snapshot.id.as_str()) == self.selected_terminal.as_deref()
                    })
                    .unwrap_or(0);
                let area = ui.max_rect();
                let cards = if self.layout == orcspace_app::code_layout::CodeLayout::Auto
                    && snapshots.len() == 3
                {
                    self.resize_three_way(ui, area);
                    orcspace_app::code_layout::three_way(area, self.three_way_split)
                } else {
                    orcspace_app::code_layout::arrange(self.layout, area, snapshots.len(), focus)
                };
                for (index, (snapshot, card)) in snapshots.into_iter().zip(cards).enumerate() {
                    self.show_terminal_card(ui, card, &snapshot, index == focus);
                }
            });
    }

    fn show_settings(&mut self, ctx: &egui::Context) {
        if !self.settings_open {
            return;
        }
        use orcspace_app::theme::{hairline, monochrome, text};
        let width = (ctx.content_rect().width() - 56.0).clamp(300.0, 820.0);
        let mut close = false;
        let response = egui::Modal::new(egui::Id::new("settings-modal"))
            .backdrop_color(Color32::from_rgba_unmultiplied(8, 8, 8, 204))
            .frame(
                egui::Frame::NONE
                    .fill(monochrome::ELEVATED)
                    .stroke(egui::Stroke::new(1.0, hairline::FAINT))
                    .corner_radius(0),
            )
            .show(ctx, |ui| {
                ui.set_width(width);
                ui.spacing_mut().item_spacing = Vec2::ZERO;
                ui.horizontal_top(|ui| {
                    egui::Frame::NONE
                        .fill(monochrome::SURFACE)
                        .inner_margin(12)
                        .show(ui, |ui| {
                            ui.with_layout(egui::Layout::top_down(egui::Align::Min), |ui| {
                                ui.set_width(136.0);
                                ui.set_min_height(340.0);
                                ui.label(
                                    egui::RichText::new("SETTINGS")
                                        .size(11.0)
                                        .color(text::FAINT),
                                );
                                ui.add_space(18.0);
                                list_row(ui, true, None, "Appearance");
                            });
                        });
                    egui::Frame::NONE.inner_margin(24).show(ui, |ui| {
                        ui.with_layout(egui::Layout::top_down(egui::Align::Min), |ui| {
                            ui.set_width((width - 208.0).max(100.0));
                            ui.spacing_mut().item_spacing = Vec2::new(8.0, 12.0);
                            ui.horizontal(|ui| {
                                ui.label(
                                    egui::RichText::new("Appearance")
                                        .font(orcspace_app::theme::semibold(18.0)),
                                );
                                ui.with_layout(
                                    egui::Layout::right_to_left(egui::Align::Center),
                                    |ui| {
                                        close = header_button(ui, icon::close, false)
                                            .on_hover_text("Close settings")
                                            .clicked();
                                    },
                                );
                            });
                            ui.label(
                                egui::RichText::new("Theme, shell and workspace appearance.")
                                    .size(11.0)
                                    .color(text::DIM),
                            );
                            ui.add_space(16.0);
                            ui.label(egui::RichText::new("THEME").size(11.0).color(text::FAINT));
                            egui::Frame::NONE
                                .fill(monochrome::SURFACE)
                                .stroke(egui::Stroke::new(1.0, hairline::FAINT))
                                .corner_radius(0)
                                .inner_margin(12)
                                .show(ui, |ui| {
                                    ui.label("Dark");
                                    ui.label(
                                        egui::RichText::new("Opaque canvas")
                                            .size(11.0)
                                            .color(text::DIM),
                                    );
                                });
                            ui.add_space(12.0);
                            ui.label(
                                egui::RichText::new("TERMINALS")
                                    .size(11.0)
                                    .color(text::FAINT),
                            );
                            ui.checkbox(&mut self.auto_names, "Automatic names");
                            ui.checkbox(&mut self.sidebar_open, "Show sidebar");
                            egui::ComboBox::from_label("Layout")
                                .selected_text(self.layout.label())
                                .show_ui(ui, |ui| {
                                    for mode in orcspace_app::code_layout::CodeLayout::ALL {
                                        ui.selectable_value(&mut self.layout, mode, mode.label());
                                    }
                                });
                        });
                    });
                });
            });
        if close || response.should_close() {
            self.settings_open = false;
        }
    }

    fn resize_three_way(&mut self, ui: &mut egui::Ui, area: egui::Rect) {
        let cards = orcspace_app::code_layout::three_way(area, self.three_way_split);
        let vertical = egui::Rect::from_min_max(
            egui::pos2(cards[0].right(), area.top()),
            egui::pos2(cards[0].right() + 2.0, area.bottom()),
        );
        let horizontal = egui::Rect::from_min_max(
            egui::pos2(cards[1].left(), cards[1].bottom()),
            egui::pos2(area.right(), cards[1].bottom() + 2.0),
        );
        for (axis, rect) in [vertical, horizontal].into_iter().enumerate() {
            let response = ui
                .interact(
                    rect.expand(4.0),
                    ui.id().with(("code-split", axis)),
                    Sense::click_and_drag(),
                )
                .on_hover_cursor(if axis == 0 {
                    egui::CursorIcon::ResizeHorizontal
                } else {
                    egui::CursorIcon::ResizeVertical
                });
            if response.double_clicked() {
                self.three_way_split[axis] = 0.5;
            }
            if response.dragged() {
                if let Some(pointer) = response.interact_pointer_pos() {
                    let (position, origin, size) = if axis == 0 {
                        (pointer.x, area.left(), area.width())
                    } else {
                        (pointer.y, area.top(), area.height())
                    };
                    self.three_way_split[axis] =
                        ((position - origin - 1.0) / (size - 2.0).max(1.0)).clamp(0.2, 0.8);
                }
            }
            if response.has_focus() {
                ui.input(|input| {
                    if input.key_pressed(egui::Key::Home) || input.key_pressed(egui::Key::Enter) {
                        self.three_way_split[axis] = 0.5;
                    }
                    if input.key_pressed(if axis == 0 {
                        egui::Key::ArrowLeft
                    } else {
                        egui::Key::ArrowUp
                    }) {
                        self.three_way_split[axis] = (self.three_way_split[axis] - 0.05).max(0.2);
                    }
                    if input.key_pressed(if axis == 0 {
                        egui::Key::ArrowRight
                    } else {
                        egui::Key::ArrowDown
                    }) {
                        self.three_way_split[axis] = (self.three_way_split[axis] + 0.05).min(0.8);
                    }
                });
            }
            ui.painter().rect_filled(
                rect,
                0.0,
                if response.dragged() {
                    orcspace_app::theme::text::DIM
                } else {
                    orcspace_app::theme::hairline::FAINT
                },
            );
        }
    }

    fn show_terminal_card(
        &mut self,
        ui: &mut egui::Ui,
        card: egui::Rect,
        snapshot: &crate::engine::TerminalSnapshot,
        active: bool,
    ) {
        use orcspace_app::theme::monochrome;
        let id = snapshot.id.clone();
        // Card edges land on whole pixels: a hairline across a fractional
        // boundary is antialiased into two half-lit rows and reads as a
        // brighter border on whichever sides happened to fall that way.
        let card = egui::Rect::from_min_max(
            egui::pos2(card.left().round(), card.top().round()),
            egui::pos2(card.right().round(), card.bottom().round()),
        );
        let border = monochrome::SURFACE;
        // Centred on a half-pixel offset, so the hairline lands on one row of
        // pixels instead of being split across two at different brightnesses.
        ui.painter().rect(
            card.shrink(0.5),
            0.0,
            monochrome::BASE,
            egui::Stroke::new(1.0, border),
            egui::StrokeKind::Middle,
        );
        let header = card.with_max_y(card.top() + 24.0);
        ui.painter().rect_filled(
            header,
            egui::CornerRadius::ZERO,
            monochrome::TERMINAL_HEADER,
        );
        ui.painter()
            .hline(header.x_range(), header.bottom(), hairline());

        let name = self.display_name(&id);
        let mut close = false;
        ui.scope_builder(
            egui::UiBuilder::new().max_rect(header.shrink2(Vec2::new(6.0, 0.0))),
            |ui| {
                ui.horizontal_centered(|ui| {
                    if !name.is_empty() {
                        ui.label(egui::RichText::new(&name).size(11.0));
                    }
                    // Running is the normal state and says nothing; only a dead
                    // terminal needs the header to explain itself.
                    if !snapshot.alive {
                        ui.label(
                            egui::RichText::new("exited")
                                .size(10.0)
                                .color(orcspace_app::theme::status::DANGER),
                        );
                    }
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        close = header_button_sized(ui, icon::close, false, 18.0)
                            .on_hover_text("Close terminal")
                            .clicked();
                    });
                });
            },
        );
        if close {
            match self.manager.dispose(&id) {
                // Only the closed card loses the selection; closing a
                // background card must not move focus off the active one.
                Ok(()) if self.selected_terminal.as_deref() == Some(id.as_str()) => {
                    self.selected_terminal = None;
                }
                Ok(()) => {}
                Err(error) => self.last_error = Some(error),
            }
            return;
        }

        let body = egui::Rect::from_min_max(
            egui::pos2(card.left() + 8.0, header.bottom() + 6.0),
            egui::pos2(card.right() - 8.0, card.bottom() - 6.0),
        );
        use orcspace_app::terminal_screen::TerminalScreen;
        let response = ui.interact(
            body,
            egui::Id::new(("terminal", &id)),
            Sense::click_and_drag(),
        );
        let cell = TerminalScreen::cell_size(ui.painter(), TERMINAL_FONT);
        let mouse = self
            .terminal_screens
            .get(&id)
            .is_some_and(TerminalScreen::mouse_reporting);
        if mouse && !self.settings_open {
            // A program tracking the mouse does its own scrolling and
            // selection; the wheel reaches it as a button, not as scrollback.
            let notches = if response.hovered() {
                (ui.input(|input| input.smooth_scroll_delta.y) / cell.y).trunc() as i32
            } else {
                0
            };
            for _ in 0..notches.abs().min(8) {
                self.report_mouse(ui, &id, body, cell, if notches > 0 { 64 } else { 65 }, true);
            }
            let (events, modifiers) = ui.input(|input| (input.events.clone(), input.modifiers));
            for event in events {
                let bytes = self
                    .terminal_screens
                    .get_mut(&id)
                    .and_then(|screen| screen.mouse_event(&event, body, cell, modifiers));
                if let Some(bytes) = bytes {
                    if let Err(error) = self.manager.write_raw(&id, &bytes) {
                        self.last_error = Some(error);
                    }
                }
            }
        }
        let screen = self.terminal_screens.entry(id.clone()).or_default();
        if response.hovered() && !mouse {
            let (delta, modifiers) =
                ui.input(|input| (input.smooth_scroll_delta.y, input.modifiers));
            if !modifiers.ctrl && !modifiers.mac_cmd {
                screen.scroll_pixels(delta * if modifiers.alt { 4.0 } else { 1.0 }, cell.y);
            }
        }
        let (rows, cols) = TerminalScreen::size_for_rect(ui.painter(), body, TERMINAL_FONT);
        if snapshot.alive && screen.screen().size() != (rows, cols) {
            match self.manager.resize(&id, cols, rows) {
                Ok(()) => screen.resize(rows, cols),
                Err(error) => self.last_error = Some(error),
            }
        }
        let window_focused = ui.input(|input| input.focused);
        let elsewhere = ui
            .memory(|memory| memory.focused())
            .is_some_and(|focused| focused != response.id);
        screen.paint(
            &ui.painter().with_clip_rect(body),
            body,
            TERMINAL_FONT,
            active && window_focused && !elsewhere,
        );
        if response.clicked() {
            response.request_focus();
            self.selected_terminal = Some(id.clone());
        }
        // Programs that asked for DECSET 1004 dim their own cursor and pause
        // animations when they are told the focus left.
        if self.focused_terminal.as_deref() != Some(&id) && active {
            let previous = self.focused_terminal.replace(id.clone());
            for (target, focused) in [(previous, false), (Some(id.clone()), true)] {
                let Some(target) = target else { continue };
                let Some(screen) = self.terminal_screens.get(&target) else {
                    continue;
                };
                if let Some(bytes) = screen.focus_report(focused) {
                    let _ = self.manager.write_raw(&target, &bytes);
                }
            }
        }
        // The active card owns the keyboard outright. Routing keystrokes
        // through egui's focus ring made typing depend on having clicked the
        // card first, and a terminal is the primary surface here, not a form
        // field — so it only stands aside when a real text field has the focus.
        let elsewhere = ui
            .memory(|memory| memory.focused())
            .is_some_and(|focused| focused != response.id);
        if active && window_focused && !elsewhere && snapshot.alive && !self.settings_open {
            for event in ui.input(|input| input.events.clone()) {
                if let Some(bytes) = self
                    .terminal_screens
                    .entry(id.clone())
                    .or_default()
                    .input(&event)
                {
                    if let Err(error) = self.manager.write_raw(&id, &bytes) {
                        self.last_error = Some(error);
                        break;
                    }
                }
            }
        }
        if let Some(path) = response.dnd_release_payload::<std::path::PathBuf>() {
            let result = path
                .to_str()
                .ok_or_else(|| "Attachment path is not UTF-8".to_owned())
                .and_then(orcspace_app::attachments::path_token)
                .and_then(|text| self.manager.write_text(&id, &text, false));
            if let Err(error) = result {
                self.last_error = Some(error);
            }
        }
        if response.contains_pointer() {
            self.drop_files(ui, &id);
        }
    }

    /// Sends one mouse report for whatever cell the pointer is over.
    fn report_mouse(
        &mut self,
        ui: &egui::Ui,
        id: &str,
        body: egui::Rect,
        cell: Vec2,
        button: u8,
        pressed: bool,
    ) {
        let Some(pointer) = ui.input(|input| input.pointer.latest_pos()) else {
            return;
        };
        let column = ((pointer.x - body.left()) / cell.x).floor().max(0.0) as u16;
        let row = ((pointer.y - body.top()) / cell.y).floor().max(0.0) as u16;
        let modifiers = ui.input(|input| input.modifiers);
        let Some(screen) = self.terminal_screens.get(id) else {
            return;
        };
        if let Some(bytes) = screen.mouse_report(button, pressed, column, row, modifiers) {
            if let Err(error) = self.manager.write_raw(id, &bytes) {
                self.last_error = Some(error);
            }
        }
    }

    fn drop_files(&mut self, ui: &egui::Ui, terminal_id: &str) {
        let files = ui.input(|input| input.raw.dropped_files.clone());
        if files.is_empty() {
            return;
        }
        let result = (|| -> Result<(), String> {
            let mut text = String::new();
            for file in files {
                let path = file.path();
                if !path.is_absolute() || !path.exists() {
                    return Err("Dropped attachment must be an existing file or folder".into());
                }
                text.push_str(&orcspace_app::attachments::path_token(
                    path.to_str().ok_or("Attachment path is not UTF-8")?,
                )?);
            }
            self.manager.write_text(terminal_id, &text, false)?;
            Ok(())
        })();
        if let Err(error) = result {
            self.last_error = Some(error);
        }
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
        if let Some(path) = &self.capture_path {
            for event in ui.input(|input| input.events.clone()) {
                self.last_error = Some("screenshots disabled in GraySpace 0.0.1".into());
            }
            // Long enough for the shell to draw its prompt; a QA run that has
            // to drive the terminal first asks for more.
            let delay = std::env::var("ORCSPACE_CAPTURE_DELAY_MS")
                .ok()
                .and_then(|value| value.parse().ok())
                .map_or(Duration::from_secs(3), Duration::from_millis);
            if !self.capture_requested && self.capture_started.elapsed() >= delay {
                ui.ctx()
                    .send_viewport_cmd(egui::ViewportCommand::Screenshot(Default::default()));
                self.capture_requested = true;
            }
        }
        for event in self.manager.drain_events() {
            match event {
                TerminalEvent::Output { id, data } => {
                    self.terminal_screens
                        .entry(id)
                        .or_default()
                        .process(data.as_bytes());
                }
                TerminalEvent::Exited { id } => {
                    if self.selected_terminal.as_deref() == Some(id.as_str()) {
                        self.last_error = Some(format!("terminal {id} exited"));
                    }
                }
            }
        }

        let live: std::collections::HashSet<_> = self.manager.terminal_ids().into_iter().collect();
        self.terminal_screens.retain(|id, _| live.contains(id));
        for (id, screen) in &mut self.terminal_screens {
            screen.flush_expired();
            let replies = screen.take_replies();
            if !replies.is_empty() {
                if let Err(error) = self.manager.write_raw(id, &replies) {
                    self.last_error = Some(error);
                }
            }
        }
        // Terminals the app did not open itself — the first one, and anything
        // `orc` spawns — still need a name to be addressable by.
        for id in &live {
            if self.manager.name(id).is_none() {
                self.name_terminal(id);
            }
        }
        for player in self.music_players.values_mut() {
            player.update();
        }

        if let Some(receiver) = &self.tool_job {
            match receiver.try_recv() {
                Ok(output) => {
                    self.tool_output = output;
                    self.tool_job = None;
                }
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    self.tool_output = "Loading stopped. Use Refresh to retry.".into();
                    self.tool_job = None;
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
            }
        }
        Panel::top("toolbar")
            .exact_size(40.0)
            .resizable(false)
            .frame(egui::Frame::NONE.fill(orcspace_app::theme::monochrome::BASE))
            .show(ui, |ui| self.show_toolbar(ui));
        if let Some(error) = self.last_error.clone() {
            Panel::bottom("error").show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.colored_label(Color32::LIGHT_RED, error);
                    if ui.button("Dismiss").clicked() {
                        self.last_error = None;
                    }
                });
            });
        }
        self.show_code(ui);
        self.show_settings(ui.ctx());
        if !ui.input(|input| input.pointer.any_down()) {
            self.save_preferences();
        }
        ui.ctx().request_repaint_after(Duration::from_millis(33));
    }
}

struct MusicPlayer {
    path: String,
    playing: bool,
    error: Option<String>,
    queue: Vec<String>,
    current: Option<usize>,
    duration: Option<Duration>,
    volume: f32,
    repeat: bool,
    active: bool,
}

impl Default for MusicPlayer {
    fn default() -> Self {
        Self {
            path: String::new(),
            playing: false,
            error: None,
            queue: Vec::new(),
            current: None,
            duration: None,
            volume: 0.7,
            repeat: false,
            active: false,
        }
    }
}

impl MusicPlayer {
    fn play_index(&mut self, _index: usize) -> Result<(), String> {
        Err("audio disabled in GraySpace 0.0.1".into())
    }

    fn update(&mut self) {}

    fn show(&mut self, ui: &mut egui::Ui) {
        egui::ScrollArea::vertical().id_salt("music-body").show(ui, |ui| {
        egui::Frame::NONE.inner_margin(12).show(ui, |ui| {
        ui.set_max_width(460.0);
        let card_width = ui.available_width().min(460.0);
        ui.spacing_mut().item_spacing = Vec2::new(8.0, 12.0);
        ui.horizontal(|ui| {
            let (rect, _) = ui.allocate_exact_size(Vec2::splat(32.0), Sense::hover());
            ui.painter().rect_filled(rect, 0.0, orcspace_app::theme::monochrome::RAISED);
            music_note(ui.painter(), rect.shrink(8.0));
            ui.vertical(|ui| {
                ui.label(egui::RichText::new("MUSIC PLAYER").font(orcspace_app::theme::semibold(10.0)).color(orcspace_app::theme::text::FAINT));
                ui.label(egui::RichText::new("Local playlist").size(11.0));
            });
        });
        music_card(orcspace_app::theme::monochrome::BASE, 8).show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.label(egui::RichText::new("Local playlist").size(11.0));
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.label(egui::RichText::new(format!("{} tracks", self.queue.len())).size(9.0).color(orcspace_app::theme::text::FAINT));
                });
            });
        });
        music_card(orcspace_app::theme::monochrome::RAISED, 12).show(ui, |ui| {
        ui.set_min_width((card_width - 26.0).max(100.0));
        let title = self.current.and_then(|i| self.queue.get(i)).and_then(|p| std::path::Path::new(p).file_name())
            .map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| "Nothing queued".into());
        ui.horizontal(|ui| {
            let (rect, _) = ui.allocate_exact_size(Vec2::splat(64.0), Sense::hover());
            ui.painter().rect_filled(rect, 0.0, orcspace_app::theme::monochrome::BASE);
            ui.painter().rect_stroke(rect, 0.0, egui::Stroke::new(1.0, orcspace_app::theme::hairline::FAINT), egui::StrokeKind::Inside);
            music_note(ui.painter(), egui::Rect::from_center_size(rect.center(), Vec2::splat(25.0)));
            ui.vertical(|ui| {
                ui.label(egui::RichText::new("NOW PLAYING").size(9.0).color(orcspace_app::theme::text::FAINT));
                ui.add(egui::Label::new(egui::RichText::new(title).size(14.0)).truncate());
                ui.label(egui::RichText::new(if self.current.is_none() { "Add an audio file below to begin" } else if self.playing { "Audio file · Playing" } else { "Audio file · Paused" }).size(10.0).color(orcspace_app::theme::text::FAINT));
            });
        });
        ui.add_space(12.0);
        ui.horizontal(|ui| {
            ui.add_space(((ui.available_width() - 160.0) / 2.0).max(0.0));
            if playback_button(ui, "Previous", self.queue.len() > 1).clicked() {
                if let Err(error) = self.play_index(self.current.unwrap_or(0).saturating_sub(1)) { self.error = Some(error); }
            }
            let paused = true;
            if playback_button(ui, "Play", !self.queue.is_empty()).clicked() {
                if let Err(error) = self.play_index(self.current.unwrap_or(0)) { self.error = Some(error); }
            }
            let next = next_track(self.current, self.queue.len(), self.repeat);
            if playback_button(ui, "Stop", true).clicked() { self.stop(); }
            if playback_button(ui, "Next", next.is_some()).clicked() {
                if let Err(error) = self.play_index(next.unwrap()) { self.error = Some(error); }
            }
        });
        let position: f64 = 0.0;
        let total = self.duration.unwrap_or_default().as_secs_f64();
        let mut seek = position.min(total);
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 8.0;
            ui.label(egui::RichText::new(audio_time(position)).size(10.0).color(orcspace_app::theme::text::FAINT));
            let width = (ui.available_width() - 44.0).max(40.0);
            if track_slider(ui, width, &mut seek, total, total > 0.0).changed() {
                self.error = Some("audio disabled in GraySpace 0.0.1".into());
            }
            ui.label(egui::RichText::new(audio_time(total)).size(10.0).color(orcspace_app::theme::text::FAINT));
        });
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 6.0;
            ui.checkbox(&mut self.repeat, egui::RichText::new("Repeat").size(10.0));
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                ui.label(egui::RichText::new(format!("{}%", (self.volume * 100.0).round() as u32))
                    .size(10.0).color(orcspace_app::theme::text::FAINT));
                let mut level = f64::from(self.volume);
                if track_slider(ui, 96.0, &mut level, 1.0, true).changed() {
                    self.volume = level as f32;
                }
            });
        });
        });
        ui.horizontal(|ui| {
            ui.add_sized([(ui.available_width() - 52.0).max(20.0), 32.0], egui::TextEdit::singleline(&mut self.path).hint_text("Local audio file path"));
            if ui.add_enabled(!self.path.trim().is_empty(), egui::Button::new("Add")).clicked() {
                let path = self.path.trim().trim_matches('"');
                if std::path::Path::new(path).is_file() {
                    self.queue.push(path.into());
                    self.path.clear();
                    self.error = None;
                } else { self.error = Some("Choose a local audio file. Web services are not connected yet.".into()); }
            }
        });
        music_card(orcspace_app::theme::monochrome::BASE, 12).show(ui, |ui| {
        ui.set_min_width((card_width - 26.0).max(100.0));
        ui.set_min_height(72.0);
        ui.label(egui::RichText::new("QUEUE").font(orcspace_app::theme::semibold(9.0)).color(orcspace_app::theme::text::FAINT));
        let mut chosen = None;
        egui::ScrollArea::vertical().max_height((ui.available_height() - 42.0).max(32.0)).show(ui, |ui| {
            ui.spacing_mut().item_spacing.y = 2.0;
            if self.queue.is_empty() {
                ui.label(egui::RichText::new("Your queue is empty.").size(11.0).color(orcspace_app::theme::text::FAINT));
            }
            for (index, path) in self.queue.iter().enumerate() {
                let title = std::path::Path::new(path).file_name().unwrap_or_default().to_string_lossy();
                if list_row(ui, self.current == Some(index), None, &title).clicked() { chosen = Some(index); }
            }
        });
        if let Some(index) = chosen {
            if let Err(error) = self.play_index(index) { self.error = Some(error); }
        }
        });
        if let Some(error) = &self.error { ui.colored_label(orcspace_app::theme::status::DANGER, error); }
        });
        });
    }

    fn stop(&mut self) {
        self.playing = false;
    }
}

fn window_controls(ui: &mut egui::Ui) {
    use orcspace_app::theme::{monochrome, text};
    let maximized = ui.input(|input| input.viewport().maximized.unwrap_or(false));
    for (action, label) in [
        (0, "Close"),
        (1, if maximized { "Restore" } else { "Maximize" }),
        (2, "Minimize"),
    ] {
        let (rect, response) = ui.allocate_exact_size(Vec2::splat(30.0), Sense::click());
        let response = response.on_hover_text(label);
        response.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Button, true, label));
        let color = if response.hovered() {
            text::NORMAL
        } else {
            text::DIM
        };
        if response.hovered() {
            ui.painter().rect_filled(
                rect,
                0.0,
                if action == 0 {
                    Color32::from_rgb(0xe0, 0x43, 0x43)
                } else {
                    monochrome::RAISED
                },
            );
        }
        let glyph = egui::Rect::from_center_size(rect.center(), Vec2::splat(13.0));
        let stroke = egui::Stroke::new(1.3, color);
        match action {
            0 => icon::close(ui.painter(), glyph, color),
            1 => {
                let front = if maximized {
                    glyph.translate(Vec2::new(-1.5, 1.5)).shrink(1.5)
                } else {
                    glyph.shrink(1.0)
                };
                if maximized {
                    ui.painter().rect_stroke(
                        front.translate(Vec2::new(3.0, -3.0)),
                        0.0,
                        stroke,
                        egui::StrokeKind::Inside,
                    );
                    ui.painter().rect_filled(
                        front,
                        0.0,
                        if response.hovered() {
                            monochrome::RAISED
                        } else {
                            monochrome::BASE
                        },
                    );
                }
                ui.painter()
                    .rect_stroke(front, 0.0, stroke, egui::StrokeKind::Inside);
            }
            _ => {
                ui.painter()
                    .hline(glyph.x_range(), glyph.center().y, stroke);
            }
        }
        if response.clicked() {
            ui.ctx().send_viewport_cmd(match action {
                0 => egui::ViewportCommand::Close,
                1 => egui::ViewportCommand::Maximized(!maximized),
                _ => egui::ViewportCommand::Minimized(true),
            });
        }
    }
    let (divider, _) = ui.allocate_exact_size(Vec2::new(5.0, 16.0), Sense::hover());
    ui.painter()
        .vline(divider.center().x, divider.y_range(), hairline());
}

fn hairline() -> egui::Stroke {
    egui::Stroke::new(1.0, orcspace_app::theme::hairline::FAINT)
}

/// Lucide draws on a 24×24 grid with a stroke of 2; these place that grid — and
/// that weight — inside whatever box the icon was given.
mod icon {
    use super::{egui, Color32, Vec2};

    pub type Draw = fn(&egui::Painter, egui::Rect, Color32);

    fn grid(rect: egui::Rect) -> impl Fn(f32, f32) -> egui::Pos2 {
        move |x, y| rect.min + Vec2::new(x / 24.0 * rect.width(), y / 24.0 * rect.height())
    }

    fn pen(rect: egui::Rect, color: Color32) -> egui::Stroke {
        egui::Stroke::new(rect.width() / 12.0, color)
    }

    pub fn panel_left(painter: &egui::Painter, rect: egui::Rect, color: Color32) {
        let (at, stroke) = (grid(rect), pen(rect, color));
        painter.rect_stroke(
            egui::Rect::from_min_max(at(3.0, 3.0), at(21.0, 21.0)),
            rect.width() / 12.0,
            stroke,
            egui::StrokeKind::Inside,
        );
        painter.line_segment([at(9.0, 3.0), at(9.0, 21.0)], stroke);
    }

    pub fn layout_grid(painter: &egui::Painter, rect: egui::Rect, color: Color32) {
        let (at, stroke) = (grid(rect), pen(rect, color));
        for (x, y) in [(3.0, 3.0), (14.0, 3.0), (3.0, 14.0), (14.0, 14.0)] {
            painter.rect_stroke(
                egui::Rect::from_min_max(at(x, y), at(x + 7.0, y + 7.0)),
                rect.width() / 16.0,
                stroke,
                egui::StrokeKind::Inside,
            );
        }
    }

    pub fn plus(painter: &egui::Painter, rect: egui::Rect, color: Color32) {
        let (at, stroke) = (grid(rect), pen(rect, color));
        painter.line_segment([at(5.0, 12.0), at(19.0, 12.0)], stroke);
        painter.line_segment([at(12.0, 5.0), at(12.0, 19.0)], stroke);
    }

    pub fn git_branch(painter: &egui::Painter, rect: egui::Rect, color: Color32) {
        let (at, stroke) = (grid(rect), pen(rect, color));
        painter.line_segment([at(6.0, 3.0), at(6.0, 15.0)], stroke);
        painter.circle_stroke(at(18.0, 6.0), rect.width() / 8.0, stroke);
        painter.circle_stroke(at(6.0, 18.0), rect.width() / 8.0, stroke);
        let quarter: Vec<_> = (0..=8)
            .map(|step| {
                let angle = step as f32 / 8.0 * std::f32::consts::FRAC_PI_2;
                at(9.0 + 9.0 * angle.cos(), 9.0 + 9.0 * angle.sin())
            })
            .collect();
        painter.add(egui::Shape::line(quarter, stroke));
    }

    pub fn close(painter: &egui::Painter, rect: egui::Rect, color: Color32) {
        let (at, stroke) = (grid(rect), pen(rect, color));
        painter.line_segment([at(6.0, 6.0), at(18.0, 18.0)], stroke);
        painter.line_segment([at(18.0, 6.0), at(6.0, 18.0)], stroke);
    }

    pub fn refresh(painter: &egui::Painter, rect: egui::Rect, color: Color32) {
        let (at, stroke) = (grid(rect), pen(rect, color));
        let arc: Vec<_> = (0..=18)
            .map(|step| {
                let angle = (-60.0 + step as f32 * 15.0).to_radians();
                at(12.0 + 8.0 * angle.cos(), 12.0 + 8.0 * angle.sin())
            })
            .collect();
        painter.add(egui::Shape::line(arc, stroke));
        let tip = at(16.0, 5.07);
        painter.add(egui::Shape::convex_polygon(
            vec![tip, at(10.5, 5.5), at(15.0, 10.5)],
            color,
            egui::Stroke::NONE,
        ));
    }
}

/// A title-bar control: the renderer's 30px `VIEW_SWITCH` rail wrapped around a
/// single 24px `VIEW_TAB`.
fn pill(ui: &mut egui::Ui, active: bool, glyph: Option<icon::Draw>, label: &str) -> egui::Response {
    use orcspace_app::theme::{hairline, monochrome, text};
    let font = if active {
        orcspace_app::theme::semibold(12.0)
    } else {
        egui::FontId::proportional(12.0)
    };
    let galley = (!label.is_empty()).then(|| {
        ui.painter()
            .layout_no_wrap(label.to_owned(), font, Color32::PLACEHOLDER)
    });
    let padding = match (glyph.is_some(), galley.is_some()) {
        (true, true) => 9.0,
        (false, true) => 11.0,
        _ => 8.0,
    };
    let glyph_width = if glyph.is_some() { 14.0 } else { 0.0 };
    let gap = if glyph.is_some() && galley.is_some() {
        6.0
    } else {
        0.0
    };
    let text_width = galley.as_ref().map_or(0.0, |galley| galley.rect.width());
    let (rect, response) = ui.allocate_exact_size(
        Vec2::new(padding * 2.0 + glyph_width + gap + text_width + 6.0, 30.0),
        Sense::click(),
    );
    let painter = ui.painter();
    painter.rect(
        rect,
        0.0,
        monochrome::BASE,
        egui::Stroke::new(1.0, monochrome::SURFACE),
        egui::StrokeKind::Inside,
    );
    let tab = rect.shrink(3.0);
    let (fill, color) = if active {
        (monochrome::RAISED, text::NORMAL)
    } else if response.hovered() {
        (hairline::FAINT, text::NORMAL)
    } else {
        (monochrome::BASE, Color32::from_white_alpha(153))
    };
    painter.rect_filled(tab, 0.0, fill);
    let mut x = tab.left() + padding;
    if let Some(glyph) = glyph {
        glyph(
            painter,
            egui::Rect::from_center_size(egui::pos2(x + 7.0, tab.center().y), Vec2::splat(14.0)),
            color,
        );
        x += glyph_width + gap;
    }
    if let Some(galley) = galley {
        painter.galley(
            egui::pos2(x, tab.center().y - galley.rect.height() / 2.0),
            galley,
            color,
        );
    }
    response.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Button, true, label));
    response
}

/// One row of a list — the Code sidebar, the play queue: `h-8 rounded-panel
/// px-2 text-[11px]`. `alive` is `None` where nothing has a process to report.
fn list_row(ui: &mut egui::Ui, selected: bool, alive: Option<bool>, label: &str) -> egui::Response {
    use orcspace_app::theme::{monochrome, status, text};
    let (rect, response) =
        ui.allocate_exact_size(Vec2::new(ui.available_width(), 32.0), Sense::click());
    let painter = ui.painter().with_clip_rect(rect);
    if selected || response.hovered() {
        painter.rect_filled(rect, 0.0, monochrome::RAISED);
    }
    let mut x = rect.left() + 8.0;
    if let Some(alive) = alive {
        painter.circle_filled(
            egui::pos2(x + 2.5, rect.center().y),
            2.5,
            if alive { status::OK } else { text::FAINT },
        );
        x += 11.0;
    }
    painter.text(
        egui::pos2(x, rect.center().y),
        egui::Align2::LEFT_CENTER,
        label,
        egui::FontId::proportional(11.0),
        if selected { text::NORMAL } else { text::DIM },
    );
    response.widget_info(|| {
        egui::WidgetInfo::selected(egui::WidgetType::SelectableLabel, true, selected, label)
    });
    response
}

#[derive(Default)]
struct HeaderActions {
    close: bool,
    refresh: bool,
}

/// A widget's `h-[34px]` header: title on the left, icon buttons on the right,
/// and the hairline that divides it from the body.
fn widget_header(
    ui: &mut egui::Ui,
    title: &str,
    status: Option<&str>,
    refreshable: bool,
) -> HeaderActions {
    let mut actions = HeaderActions::default();
    let header = ui
        .horizontal(|ui| {
            ui.set_height(orcspace_app::theme::geometry::HEADER_HEIGHT);
            ui.add_space(10.0);
            ui.label(egui::RichText::new(title).size(12.0));
            if let Some(status) = status {
                ui.label(
                    egui::RichText::new(status)
                        .size(10.0)
                        .color(orcspace_app::theme::text::FAINT),
                );
            }
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                ui.add_space(6.0);
                actions.close = header_button(ui, icon::close, true)
                    .on_hover_text("Close")
                    .clicked();
                if refreshable {
                    actions.refresh = header_button(ui, icon::refresh, false)
                        .on_hover_text("Refresh")
                        .clicked();
                }
            });
        })
        .response
        .rect;
    ui.painter()
        .hline(ui.max_rect().x_range(), header.bottom(), hairline());
    actions
}

/// A 24px round icon button in a widget header. `danger` is the close button,
/// which takes the renderer's red on hover.
fn header_button(ui: &mut egui::Ui, glyph: icon::Draw, danger: bool) -> egui::Response {
    header_button_sized(ui, glyph, danger, 24.0)
}

fn header_button_sized(
    ui: &mut egui::Ui,
    glyph: icon::Draw,
    danger: bool,
    size: f32,
) -> egui::Response {
    use orcspace_app::theme::{monochrome, text};
    let (rect, response) = ui.allocate_exact_size(Vec2::splat(size), Sense::click());
    let painter = ui.painter();
    let mut color = text::FAINT;
    if response.hovered() {
        color = text::NORMAL;
        let fill = if danger {
            Color32::from_rgb(0xE0, 0x43, 0x43)
        } else {
            monochrome::RAISED
        };
        painter.rect_filled(rect, 0.0, fill);
    }
    glyph(
        painter,
        egui::Rect::from_center_size(rect.center(), Vec2::splat((size - 6.0).min(14.0))),
        color,
    );
    response
}

/// The renderer's seek and volume control: a rail that thickens on hover, a
/// white fill up to the value and a 12px thumb.
fn track_slider(
    ui: &mut egui::Ui,
    width: f32,
    value: &mut f64,
    max: f64,
    enabled: bool,
) -> egui::Response {
    let sense = if enabled {
        Sense::click_and_drag()
    } else {
        Sense::hover()
    };
    let (rect, mut response) = ui.allocate_exact_size(Vec2::new(width, 16.0), sense);
    if let Some(pointer) = response.interact_pointer_pos() {
        *value = f64::from(((pointer.x - rect.left()) / rect.width()).clamp(0.0, 1.0)) * max;
        response.mark_changed();
    }
    let thickness = if response.hovered() { 6.0 } else { 4.0 };
    let rail = egui::Rect::from_center_size(rect.center(), Vec2::new(rect.width(), thickness));
    let filled = if max > 0.0 {
        (*value / max).clamp(0.0, 1.0) as f32
    } else {
        0.0
    };
    let painter = ui.painter();
    painter.rect_filled(rail, thickness / 2.0, orcspace_app::theme::hairline::FAINT);
    painter.rect_filled(
        rail.with_max_x(rail.left() + rail.width() * filled),
        thickness / 2.0,
        Color32::WHITE,
    );
    if enabled {
        painter.circle_filled(
            egui::pos2(rail.left() + rail.width() * filled, rect.center().y),
            6.0,
            Color32::WHITE,
        );
    }
    response
}

fn music_card(fill: Color32, margin: i8) -> egui::Frame {
    egui::Frame::NONE
        .fill(fill)
        .stroke(egui::Stroke::new(1.0, orcspace_app::theme::hairline::FAINT))
        .corner_radius(0)
        .inner_margin(margin)
}

fn music_note(painter: &egui::Painter, rect: egui::Rect) {
    let stroke = egui::Stroke::new(1.5, orcspace_app::theme::text::NORMAL);
    let point = |x: f32, y: f32| rect.min + Vec2::new(x * rect.width(), y * rect.height());
    painter.line_segment([point(0.4, 0.8), point(0.4, 0.1)], stroke);
    painter.line_segment([point(0.4, 0.1), point(0.85, 0.3)], stroke);
    painter.circle_stroke(point(0.24, 0.8), rect.width() * 0.16, stroke);
}

fn playback_button(ui: &mut egui::Ui, label: &str, enabled: bool) -> egui::Response {
    let primary = matches!(label, "Play" | "Pause");
    let size = if primary { 36.0 } else { 32.0 };
    let response = ui
        .add_enabled_ui(enabled, |ui| {
            let (rect, response) = ui.allocate_exact_size(Vec2::splat(size), Sense::click());
            let color = if primary {
                orcspace_app::theme::monochrome::BASE
            } else {
                orcspace_app::theme::text::DIM
            };
            if primary {
                ui.painter()
                    .circle_filled(rect.center(), size / 2.0, Color32::WHITE);
            } else if response.hovered() {
                ui.painter().circle_filled(
                    rect.center(),
                    size / 2.0,
                    orcspace_app::theme::monochrome::BASE,
                );
            }
            let center = rect.center();
            let stroke = egui::Stroke::new(1.5, color);
            if label == "Stop" {
                ui.painter().rect_stroke(
                    egui::Rect::from_center_size(center, Vec2::splat(11.0)),
                    1.0,
                    stroke,
                    egui::StrokeKind::Inside,
                );
            } else if label == "Pause" {
                for x in [-3.0, 3.0] {
                    ui.painter().line_segment(
                        [center + Vec2::new(x, -6.0), center + Vec2::new(x, 6.0)],
                        stroke,
                    );
                }
            } else {
                let direction = if label == "Previous" { -1.0 } else { 1.0 };
                ui.painter().add(egui::Shape::convex_polygon(
                    vec![
                        center + Vec2::new(-4.0 * direction, -6.0),
                        center + Vec2::new(6.0 * direction, 0.0),
                        center + Vec2::new(-4.0 * direction, 6.0),
                    ],
                    color,
                    egui::Stroke::NONE,
                ));
                if !primary {
                    ui.painter().line_segment(
                        [
                            center + Vec2::new(8.0 * direction, -6.0),
                            center + Vec2::new(8.0 * direction, 6.0),
                        ],
                        stroke,
                    );
                }
            }
            response.widget_info(|| {
                egui::WidgetInfo::labeled(egui::WidgetType::Button, enabled, label)
            });
            response
        })
        .inner;
    response.on_hover_text(label)
}

fn next_track(current: Option<usize>, count: usize, repeat: bool) -> Option<usize> {
    if count == 0 {
        None
    } else if let Some(current) = current {
        if current + 1 < count {
            Some(current + 1)
        } else if repeat {
            Some(0)
        } else {
            None
        }
    } else {
        Some(0)
    }
}

fn audio_time(seconds: f64) -> String {
    let seconds = if seconds.is_finite() && seconds > 0.0 {
        seconds as u64
    } else {
        0
    };
    format!("{}:{:02}", seconds / 60, seconds % 60)
}

#[cfg(test)]
mod music_tests {
    use super::*;
    #[test]
    fn queue_wraps_only_when_repeat_is_enabled() {
        assert_eq!(next_track(None, 0, true), None);
        assert_eq!(next_track(None, 2, false), Some(0));
        assert_eq!(next_track(Some(0), 2, false), Some(1));
        assert_eq!(next_track(Some(1), 2, false), None);
        assert_eq!(next_track(Some(1), 2, true), Some(0));
    }
    #[test]
    fn audio_time_handles_unknown_duration() {
        assert_eq!(audio_time(f64::NAN), "0:00");
        assert_eq!(audio_time(125.9), "2:05");
    }
}
