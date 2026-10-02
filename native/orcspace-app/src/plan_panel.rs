//! The Plan widget: the workspace task list, editable.
//!
//! Every change is appended to the command journal first and only then folded
//! into the snapshot, which is the order the renderer uses. Writing the
//! snapshot alone would leave a file no replay could reproduce.

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

/// Renders the note's markdown subset (`# heading`, `**bold**`, `- item`)
/// as plain text for the rgpui view. Bold markers are stripped; headings
/// and bullets keep a text prefix so nothing reads as raw markup.
pub fn render_note_text(text: &str) -> String {
    let mut out = String::new();
    for (index, line) in text.lines().enumerate() {
        if index > 0 {
            out.push('\n');
        }
        let (body, lead) = match line.strip_prefix("# ") {
            Some(rest) => (rest, ""),
            None => match line.strip_prefix("- ") {
                Some(rest) => (rest, "\u{2022} "),
                None => (line, ""),
            },
        };
        out.push_str(lead);
        for (_, chunk) in split_bold(body) {
            out.push_str(chunk);
        }
    }
    out
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
    fn an_unclosed_bold_marker_is_left_as_written() {
        assert_eq!(split_bold("a **b"), vec![(false, "a **b")]);
        assert_eq!(
            split_bold("a **b** c"),
            vec![(false, "a "), (true, "b"), (false, " c")]
        );
    }

    #[test]
    fn headings_and_bullets_are_rendered_rather_than_shown_as_markup() {
        let text = render_note_text("# Title\n- item\nplain **bold**");
        assert!(!text.contains('#'));
        assert!(!text.contains("**"));
        assert!(text.contains("\u{2022} item"));
        assert!(text.contains("Title"));
        assert!(text.contains("bold"));
    }
}
