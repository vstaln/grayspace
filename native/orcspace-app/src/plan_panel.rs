//! The Plan widget: the workspace task list, editable.
//!
//! Every change is appended to the command journal first and only then folded
//! into the snapshot, which is the order the renderer uses. Writing the
//! snapshot alone would leave a file no replay could reproduce.

use eframe::egui::{self, Color32, Sense, Vec2};
use orcspace_app::{
    journal_log::JournalLog,
    planner::{self, Today},
    planner_document::PlannerDocument,
};

const ACTOR: &str = "user";

#[derive(Default)]
pub struct PlanPanel {
    store: Option<Store>,
    error: Option<String>,
    draft: String,
    selected: Option<String>,
    note: String,
    note_dirty: bool,
    pending: Option<orcspace_app::journal::JournalEntry>,
}

struct Store {
    document: PlannerDocument,
    log: JournalLog,
    today: Today,
}

impl Store {
    fn open(directory: &std::path::Path) -> Result<Self, String> {
        let log = JournalLog::open(directory.join("command-journal.ndjson"))?;
        let today = planner::today_utc();
        let document =
            PlannerDocument::recover(directory.join("workspace-planner.json"), &log, &today)?;
        Ok(Self {
            document,
            log,
            today,
        })
    }
}

impl PlanPanel {
    pub fn refresh(&mut self) {
        let directory = orcspace_app::ipc::user_data_dir();
        self.store = None;
        match Store::open(&directory) {
            Ok(store) => {
                self.store = Some(store);
                self.error = None;
            }
            Err(error) => self.error = Some(error),
        }
        if !self.note_dirty
            && self
                .selected
                .as_ref()
                .is_some_and(|id| !self.items().iter().any(|(item, _)| item == id))
        {
            self.clear_selection();
        }
    }

    fn items(&self) -> Vec<(String, planner::PlanItem)> {
        self.store.as_ref().map_or_else(Vec::new, |store| {
            store
                .document
                .items
                .iter()
                .map(|(id, item)| (id.clone(), item.clone()))
                .collect()
        })
    }

    fn clear_selection(&mut self) {
        self.selected = None;
        self.note.clear();
        self.note_dirty = false;
    }

    /// Appends one planner command and folds it into the snapshot. A snapshot
    /// that has moved under us is reopened once rather than overwritten.
    fn commit(&mut self, kind: &str, target: &str, payload: serde_json::Value) -> bool {
        self.commit_at(&orcspace_app::ipc::user_data_dir(), kind, target, payload)
    }

    fn commit_at(
        &mut self,
        directory: &std::path::Path,
        kind: &str,
        target: &str,
        payload: serde_json::Value,
    ) -> bool {
        let result = (|| -> Result<Store, String> {
            let mut store = Store::open(directory)?;
            // A previous append may have succeeded while its snapshot failed.
            // Recovery has now applied it; retrying must not duplicate a task
            // or toggle it back to its previous state.
            if let Some(pending) = self.pending.take() {
                if pending.entry_type == kind
                    && pending.payload.as_ref() == Some(&payload)
                    && (pending.target == target || kind == "plan.create")
                {
                    return Ok(store);
                }
            }
            if kind != "plan.create"
                && !store
                    .document
                    .items
                    .contains_key(target.strip_prefix("plan:").unwrap_or(target))
            {
                return Err("Task no longer exists; your unsaved text is retained".into());
            }
            let entry = store.log.commit(ACTOR, kind, target, payload)?;
            self.pending = Some(entry.clone());
            store.document.apply(&entry, &store.today)?;
            self.pending = None;
            Ok(store)
        })();
        match result {
            Ok(store) => {
                self.store = Some(store);
                self.error = None;
                true
            }
            Err(error) => {
                self.error = Some(error);
                false
            }
        }
    }

    fn save_note(&mut self) {
        self.save_note_at(&orcspace_app::ipc::user_data_dir());
    }

    fn save_note_at(&mut self, directory: &std::path::Path) {
        let Some(id) = self.selected.clone() else {
            return;
        };
        if self.commit_at(
            directory,
            "plan.update",
            &format!("plan:{id}"),
            serde_json::json!({"note": self.note}),
        ) {
            self.note_dirty = false;
        }
    }

    pub fn show(&mut self, ui: &mut egui::Ui) {
        if self.store.is_none() && self.error.is_none() {
            self.refresh();
        }
        // The editor is a bottom panel, so it has to claim its space before
        // the list fills what is left.
        self.show_editor(ui);
        egui::Frame::NONE.inner_margin(12).show(ui, |ui| {
            ui.spacing_mut().item_spacing = Vec2::new(8.0, 10.0);
            self.show_composer(ui);
            self.show_items(ui);
            if let Some(error) = self.error.clone() {
                ui.colored_label(orcspace_app::theme::status::DANGER, error);
            }
        });
    }

    fn show_composer(&mut self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            let width = (ui.available_width() - 56.0).max(80.0);
            let field = ui.add_sized(
                [width, 32.0],
                egui::TextEdit::singleline(&mut self.draft).hint_text("New task"),
            );
            let submit =
                field.lost_focus() && ui.input(|input| input.key_pressed(egui::Key::Enter));
            let add = ui
                .add_enabled(!self.draft.trim().is_empty(), egui::Button::new("Add"))
                .clicked();
            if (submit || add) && !self.draft.trim().is_empty() {
                let title = self.draft.trim().to_owned();
                let id = format!("plan-{}", uuid::Uuid::new_v4());
                if self.commit(
                    "plan.create",
                    &format!("plan:{id}"),
                    serde_json::json!({"title": title}),
                ) {
                    self.draft.clear();
                }
            }
        });
    }

    fn show_items(&mut self, ui: &mut egui::Ui) {
        let items = self.items();
        if items.is_empty() {
            ui.label(
                egui::RichText::new("No tasks yet")
                    .size(11.0)
                    .color(orcspace_app::theme::text::FAINT),
            );
            return;
        }
        let mut command = None;
        egui::ScrollArea::vertical()
            .id_salt("plan-items")
            .max_height(260.0)
            .show(ui, |ui| {
                ui.spacing_mut().item_spacing.y = 2.0;
                for (id, item) in &items {
                    let selected = self.selected.as_deref() == Some(id.as_str());
                    match task_row(ui, item, selected) {
                        Some(RowAction::Toggle) => command = Some((id.clone(), RowAction::Toggle)),
                        Some(RowAction::Delete) => command = Some((id.clone(), RowAction::Delete)),
                        Some(RowAction::Select) => command = Some((id.clone(), RowAction::Select)),
                        None => {}
                    }
                }
            });
        let Some((id, action)) = command else { return };
        match action {
            RowAction::Toggle => {
                self.commit("plan.toggle", &format!("plan:{id}"), serde_json::json!({}));
            }
            RowAction::Delete => {
                if self.commit("plan.delete", &format!("plan:{id}"), serde_json::json!({}))
                    && self.selected.as_deref() == Some(id.as_str())
                {
                    self.clear_selection();
                }
            }
            RowAction::Select => {
                self.note = items
                    .iter()
                    .find(|(key, _)| *key == id)
                    .map(|(_, item)| item.note.clone())
                    .unwrap_or_default();
                self.selected = Some(id);
                self.note_dirty = false;
            }
        }
    }

    /// The note editor, pinned to the bottom of the widget with its formatting
    /// bar — the only place in Plan where text is more than one line.
    fn show_editor(&mut self, ui: &mut egui::Ui) {
        if self.selected.is_none() {
            return;
        }
        egui::containers::Panel::bottom("plan-editor")
            .exact_size(184.0)
            .resizable(false)
            .frame(
                egui::Frame::NONE
                    .fill(orcspace_app::theme::monochrome::SURFACE)
                    .inner_margin(12),
            )
            .show(ui, |ui| {
                ui.painter().hline(
                    ui.max_rect().x_range(),
                    ui.max_rect().top(),
                    egui::Stroke::new(1.0, orcspace_app::theme::hairline::FAINT),
                );
                let half = (ui.available_width() - 12.0) / 2.0;
                let mut selection = None;
                ui.horizontal_top(|ui| {
                    ui.vertical(|ui| {
                        ui.set_width(half);
                        let output = egui::TextEdit::multiline(&mut self.note)
                            .desired_width(f32::INFINITY)
                            .desired_rows(5)
                            .hint_text("Notes — **bold**, # large, - list")
                            .show(ui);
                        if output.response.changed() {
                            self.note_dirty = true;
                        }
                        selection = output.cursor_range.map(|range| {
                            let (primary, secondary) = (range.primary.index, range.secondary.index);
                            (
                                usize::from(primary.min(secondary)),
                                usize::from(primary.max(secondary)),
                            )
                        });
                    });
                    ui.vertical(|ui| {
                        ui.set_width(half);
                        ui.add(egui::Label::new(note_job(&self.note, half)));
                    });
                });
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = 6.0;
                    for (label, mark) in [("B", Mark::Bold), ("A+", Mark::Large), ("•", Mark::List)]
                    {
                        if ui
                            .add(egui::Button::new(label).min_size(Vec2::new(30.0, 26.0)))
                            .on_hover_text(mark.hint())
                            .clicked()
                        {
                            apply_mark(&mut self.note, mark, selection);
                            self.note_dirty = true;
                        }
                    }
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if ui
                            .add_enabled(self.note_dirty, egui::Button::new("Save"))
                            .clicked()
                        {
                            self.save_note();
                        }
                        if ui.button("Close").clicked() {
                            self.clear_selection();
                        }
                    });
                });
            });
    }
}

enum RowAction {
    Toggle,
    Delete,
    Select,
}

#[derive(Clone, Copy)]
enum Mark {
    Bold,
    Large,
    List,
}

impl Mark {
    fn hint(self) -> &'static str {
        match self {
            Self::Bold => "Bold",
            Self::Large => "Large heading",
            Self::List => "List item",
        }
    }
}

/// Wraps the selection in `**`, or turns the line it starts on into a heading
/// or a list item. Without a selection the marks act on the whole note, which
/// is what an empty click should do rather than nothing.
fn apply_mark(note: &mut String, mark: Mark, selection: Option<(usize, usize)>) {
    let characters: Vec<char> = note.chars().collect();
    let (start, end) = selection
        .filter(|(start, end)| start != end)
        .unwrap_or((0, characters.len()));
    let (start, end) = (start.min(characters.len()), end.min(characters.len()));
    let before: String = characters[..start].iter().collect();
    let middle: String = characters[start..end].iter().collect();
    let after: String = characters[end..].iter().collect();
    *note = match mark {
        Mark::Bold => format!("{before}**{middle}**{after}"),
        Mark::Large => format!("{}# {middle}{after}", line_start(&before)),
        Mark::List => format!("{}- {middle}{after}", line_start(&before)),
    };
}

/// A heading or bullet marker only means anything at the start of a line.
fn line_start(before: &str) -> String {
    if before.is_empty() || before.ends_with('\n') {
        before.to_owned()
    } else {
        format!("{before}\n")
    }
}

/// Renders the note's markdown subset: `# heading`, `**bold**`, `- item`.
pub fn note_job(text: &str, wrap_width: f32) -> egui::text::LayoutJob {
    let mut job = egui::text::LayoutJob {
        wrap: egui::text::TextWrapping {
            max_width: wrap_width,
            ..Default::default()
        },
        ..Default::default()
    };
    for (index, line) in text.lines().enumerate() {
        if index > 0 {
            job.append("\n", 0.0, plain(11.0, false));
        }
        let (body, size, lead) = match line.strip_prefix("# ") {
            Some(rest) => (rest, 16.0, ""),
            None => match line.strip_prefix("- ") {
                Some(rest) => (rest, 11.0, "• "),
                None => (line, 11.0, ""),
            },
        };
        if !lead.is_empty() {
            job.append(lead, 0.0, plain(size, false));
        }
        let heading = size > 11.0;
        for (bold, chunk) in split_bold(body) {
            job.append(chunk, 0.0, plain(size, bold || heading));
        }
    }
    job
}

fn plain(size: f32, bold: bool) -> egui::TextFormat {
    egui::TextFormat {
        font_id: if bold {
            orcspace_app::theme::semibold(size)
        } else {
            egui::FontId::proportional(size)
        },
        color: orcspace_app::theme::text::NORMAL,
        ..Default::default()
    }
}

/// Splits a line on `**` pairs. An unclosed `**` is left as written rather
/// than turning the rest of the note bold.
fn split_bold(line: &str) -> Vec<(bool, &str)> {
    let mut out = Vec::new();
    let mut rest = line;
    while let Some(open) = rest.find("**") {
        let Some(close) = rest[open + 2..].find("**") else {
            break;
        };
        if open > 0 {
            out.push((false, &rest[..open]));
        }
        out.push((true, &rest[open + 2..open + 2 + close]));
        rest = &rest[open + 2 + close + 2..];
    }
    if !rest.is_empty() {
        out.push((false, rest));
    }
    out
}

fn task_row(ui: &mut egui::Ui, item: &planner::PlanItem, selected: bool) -> Option<RowAction> {
    use orcspace_app::theme::{monochrome, text};
    let (rect, response) =
        ui.allocate_exact_size(Vec2::new(ui.available_width(), 32.0), Sense::click());
    let painter = ui.painter().with_clip_rect(rect);
    if selected || response.hovered() {
        painter.rect_filled(rect, 12.0, monochrome::RAISED);
    }
    let box_rect = egui::Rect::from_center_size(
        egui::pos2(rect.left() + 18.0, rect.center().y),
        Vec2::splat(14.0),
    );
    painter.rect_stroke(
        box_rect,
        4.0,
        egui::Stroke::new(1.0, text::FAINT),
        egui::StrokeKind::Inside,
    );
    if item.done {
        let stroke = egui::Stroke::new(1.6, text::NORMAL);
        painter.line_segment(
            [
                box_rect.left_center() + Vec2::new(3.0, 0.0),
                box_rect.center_bottom() - Vec2::new(1.0, 3.0),
            ],
            stroke,
        );
        painter.line_segment(
            [
                box_rect.center_bottom() - Vec2::new(1.0, 3.0),
                box_rect.right_top() + Vec2::new(-3.0, 3.0),
            ],
            stroke,
        );
    }
    painter.text(
        egui::pos2(rect.left() + 34.0, rect.center().y),
        egui::Align2::LEFT_CENTER,
        &item.title,
        egui::FontId::proportional(11.0),
        if item.done { text::FAINT } else { text::NORMAL },
    );
    let remove = egui::Rect::from_center_size(
        egui::pos2(rect.right() - 16.0, rect.center().y),
        Vec2::splat(20.0),
    );
    let removing = response.hovered() && ui.rect_contains_pointer(remove);
    if removing {
        painter.circle_filled(remove.center(), 10.0, Color32::from_rgb(0xE0, 0x43, 0x43));
    }
    if response.hovered() {
        let stroke = egui::Stroke::new(1.2, if removing { text::NORMAL } else { text::FAINT });
        let cross = remove.shrink(6.0);
        painter.line_segment([cross.left_top(), cross.right_bottom()], stroke);
        painter.line_segment([cross.right_top(), cross.left_bottom()], stroke);
    }
    if !response.clicked() {
        return None;
    }
    if removing {
        return Some(RowAction::Delete);
    }
    if ui.rect_contains_pointer(box_rect.expand(6.0)) {
        return Some(RowAction::Toggle);
    }
    Some(RowAction::Select)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_note_save_keeps_text_and_can_be_retried() {
        let root = std::env::temp_dir().join(format!("orc-note-test-{}", uuid::Uuid::new_v4()));
        let mut panel = PlanPanel::default();
        assert!(panel.commit_at(
            &root,
            "plan.create",
            "plan:one",
            serde_json::json!({"title":"Task"})
        ));
        panel.selected = Some("one".into());
        panel.note = "unsaved note".into();
        panel.note_dirty = true;
        let journal = root.join("command-journal.ndjson");
        let valid = std::fs::read(&journal).unwrap();
        std::fs::write(&journal, b"broken").unwrap();
        panel.save_note_at(&root);
        assert!(panel.note_dirty);
        assert_eq!(panel.note, "unsaved note");
        assert!(panel.error.is_some());
        std::fs::write(&journal, valid).unwrap();
        panel.save_note_at(&root);
        assert!(!panel.note_dirty);
        assert_eq!(
            Store::open(&root).unwrap().document.items["one"].note,
            "unsaved note"
        );
        std::fs::remove_file(journal).unwrap();
        std::fs::remove_file(root.join("workspace-planner.json")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn retry_after_a_durable_commit_does_not_toggle_twice() {
        let root = std::env::temp_dir().join(format!("orc-plan-retry-{}", uuid::Uuid::new_v4()));
        let mut panel = PlanPanel::default();
        assert!(panel.commit_at(
            &root,
            "plan.create",
            "plan:one",
            serde_json::json!({"title":"Task"})
        ));
        let mut store = Store::open(&root).unwrap();
        panel.pending = Some(
            store
                .log
                .commit(ACTOR, "plan.toggle", "plan:one", serde_json::json!({}))
                .unwrap(),
        );
        assert!(panel.commit_at(&root, "plan.toggle", "plan:one", serde_json::json!({})));
        let recovered = Store::open(&root).unwrap();
        assert!(recovered.document.items["one"].done);
        assert_eq!(recovered.log.sequence(), 2);
        std::fs::remove_file(root.join("command-journal.ndjson")).unwrap();
        std::fs::remove_file(root.join("workspace-planner.json")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn bold_wraps_the_selection_and_leaves_the_rest_alone() {
        let mut note = "alpha beta".to_owned();
        apply_mark(&mut note, Mark::Bold, Some((6, 10)));
        assert_eq!(note, "alpha **beta**");
    }

    #[test]
    fn a_heading_starts_its_own_line() {
        let mut note = "first\nsecond".to_owned();
        apply_mark(&mut note, Mark::Large, Some((6, 12)));
        assert_eq!(note, "first\n# second");
        let mut inline = "abc".to_owned();
        apply_mark(&mut inline, Mark::List, Some((1, 3)));
        assert_eq!(inline, "a\n- bc");
    }

    #[test]
    fn an_empty_selection_marks_the_whole_note() {
        let mut note = "text".to_owned();
        apply_mark(&mut note, Mark::Bold, Some((2, 2)));
        assert_eq!(note, "**text**");
    }

    #[test]
    fn an_unclosed_bold_marker_is_left_as_written() {
        assert_eq!(split_bold("a **b"), vec![(false, "a **b")]);
        assert_eq!(
            split_bold("a **b** c"),
            vec![(false, "a "), (true, "b"), (false, " c")]
        );
    }

    #[test]
    fn headings_and_bullets_are_rendered_rather_than_shown_as_markup() {
        let job = note_job("# Title\n- item\nplain", 200.0);
        assert!(!job.text.contains('#'));
        assert!(job.text.contains("• item"));
        assert!(job.text.contains("Title"));
    }
}
