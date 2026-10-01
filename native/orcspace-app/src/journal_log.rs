//! Append-only access to `command-journal.ndjson`, the log the renderer writes.
//!
//! The renderer's sink rotates by rewriting the file with only its tail, so
//! what is on disk does not start at genesis and cannot be replayed from it.
//! The head of the chain is therefore read from the last line.

use crate::journal::{compute_entry_hash, JournalEntry, GENESIS_HASH};
use serde_json::Value;
use std::{
    io::Write,
    path::{Path, PathBuf},
};

pub struct JournalLog {
    path: PathBuf,
    seq: u64,
    head: String,
    entries: Vec<JournalEntry>,
    needs_newline: bool,
}

impl JournalLog {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        let path = path.as_ref().to_owned();
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(error) => return Err(error.to_string()),
        };
        let mut entries: Vec<JournalEntry> = Vec::new();
        for line in text.lines().filter(|line| !line.trim().is_empty()) {
            let entry: JournalEntry = serde_json::from_str(line)
                .map_err(|error| format!("Unreadable journal: {error}"))?;
            let previous = entries.last();
            let head = previous
                .and_then(|entry| entry.hash.as_deref())
                .or(entry.prev_hash.as_deref())
                .unwrap_or(GENESIS_HASH);
            if previous.is_some_and(|previous| previous.seq.checked_add(1) != Some(entry.seq))
                || entry.prev_hash.as_deref() != Some(head)
                || entry.hash.as_deref() != Some(compute_entry_hash(head, &entry).as_str())
            {
                return Err(format!("Invalid journal chain at sequence {}", entry.seq));
            }
            entries.push(entry);
        }
        let seq = entries.last().map_or(0, |entry| entry.seq);
        let head = entries
            .last()
            .and_then(|entry| entry.hash.clone())
            .unwrap_or_else(|| GENESIS_HASH.into());
        let needs_newline = !text.is_empty() && !text.ends_with('\n');
        Ok(Self {
            path,
            seq,
            head,
            entries,
            needs_newline,
        })
    }

    pub fn entries(&self) -> &[JournalEntry] {
        &self.entries
    }

    pub fn sequence(&self) -> u64 {
        self.seq
    }

    /// Appends one committed entry and hands it back, so the caller can fold it
    /// into whatever snapshot it keeps.
    pub fn commit(
        &mut self,
        actor: &str,
        entry_type: &str,
        target: &str,
        payload: Value,
    ) -> Result<JournalEntry, String> {
        let current = Self::open(&self.path)?;
        if current.seq != self.seq || current.head != self.head {
            return Err("Journal changed on disk; reopen before saving".into());
        }
        let mut entry = JournalEntry {
            seq: self
                .seq
                .checked_add(1)
                .ok_or("Journal sequence exhausted")?,
            at: now_ms(),
            phase: "commit".into(),
            actor_id: actor.into(),
            command_id: None,
            entry_type: entry_type.into(),
            target: target.into(),
            payload: Some(payload),
            version: None,
            error: None,
            prev_hash: Some(self.head.clone()),
            hash: None,
        };
        let hash = compute_entry_hash(&self.head, &entry);
        entry.hash = Some(hash.clone());
        let value = serde_json::to_value(&entry).map_err(|error| error.to_string())?;
        let mut line = crate::jsjson::to_js_json(&value);
        if current.needs_newline {
            line.insert(0, '\n');
        }
        line.push('\n');
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|error| error.to_string())?;
        file.write_all(line.as_bytes())
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        self.seq = entry.seq;
        self.head = hash;
        self.entries.push(entry.clone());
        self.needs_newline = false;
        Ok(entry)
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::journal::verify_chain;
    use serde_json::json;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("orc-journal-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn read(path: &Path) -> Vec<JournalEntry> {
        std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    #[test]
    fn a_new_log_starts_at_genesis_and_stays_verifiable() {
        let dir = TempDir::new();
        let path = dir.0.join("command-journal.ndjson");
        let mut log = JournalLog::open(&path).unwrap();
        log.commit("user", "plan.create", "plan:new", json!({"title": "Task"}))
            .unwrap();
        log.commit("user", "plan.toggle", "plan:one", json!({"done": true}))
            .unwrap();
        let entries = read(&path);
        assert_eq!(
            entries.iter().map(|entry| entry.seq).collect::<Vec<_>>(),
            [1, 2]
        );
        assert_eq!(entries[0].prev_hash.as_deref(), Some(GENESIS_HASH));
        verify_chain(&entries).unwrap();
    }

    #[test]
    fn reopening_continues_the_chain_rather_than_restarting_it() {
        let dir = TempDir::new();
        let path = dir.0.join("command-journal.ndjson");
        let mut log = JournalLog::open(&path).unwrap();
        let first = log
            .commit("user", "plan.create", "plan:new", json!({"title": "Task"}))
            .unwrap();
        let mut reopened = JournalLog::open(&path).unwrap();
        let second = reopened
            .commit("user", "plan.delete", "plan:one", json!({}))
            .unwrap();
        assert_eq!(second.seq, 2);
        assert_eq!(second.prev_hash, first.hash);
        verify_chain(&read(&path)).unwrap();
    }

    /// The renderer's sink keeps only the tail when it rotates, so the chain on
    /// disk starts mid-way. Appending must continue from that line, not genesis.
    #[test]
    fn a_rotated_log_is_extended_from_its_surviving_tail() {
        let dir = TempDir::new();
        let path = dir.0.join("command-journal.ndjson");
        let mut log = JournalLog::open(&path).unwrap();
        for index in 0..3 {
            log.commit(
                "user",
                "plan.create",
                "plan:new",
                json!({"title": index.to_string()}),
            )
            .unwrap();
        }
        let tail = read(&path).pop().unwrap();
        std::fs::write(
            &path,
            format!("{}\n", serde_json::to_string(&tail).unwrap()),
        )
        .unwrap();
        let mut rotated = JournalLog::open(&path).unwrap();
        let next = rotated
            .commit("user", "plan.delete", "plan:one", json!({}))
            .unwrap();
        assert_eq!(next.seq, 4);
        assert_eq!(next.prev_hash, tail.hash);
    }

    /// The path Plan writes on: append the command, then fold it into the
    /// snapshot. Both files have to end up agreeing.
    #[test]
    fn a_committed_plan_command_lands_in_the_planner_snapshot() {
        use crate::{planner::Today, planner_document::PlannerDocument};
        let dir = TempDir::new();
        let today = Today("2026-09-19".into());
        let mut log = JournalLog::open(dir.0.join("command-journal.ndjson")).unwrap();
        let mut document = PlannerDocument::open(dir.0.join("workspace-planner.json")).unwrap();

        let created = log
            .commit(
                "user",
                "plan.create",
                "plan:task-1",
                json!({"title": "Ship it"}),
            )
            .unwrap();
        document.apply(&created, &today).unwrap();
        assert_eq!(document.items["task-1"].title, "Ship it");
        assert!(!document.items["task-1"].done);

        let toggled = log
            .commit("user", "plan.toggle", "plan:task-1", json!({}))
            .unwrap();
        document.apply(&toggled, &today).unwrap();
        assert!(document.items["task-1"].done);

        let deleted = log
            .commit("user", "plan.delete", "plan:task-1", json!({}))
            .unwrap();
        document.apply(&deleted, &today).unwrap();
        assert!(document.items.is_empty());

        // Reopening reads the snapshot, not a replay, and the chain still verifies.
        assert!(PlannerDocument::open(dir.0.join("workspace-planner.json"))
            .unwrap()
            .items
            .is_empty());
        verify_chain(&read(&dir.0.join("command-journal.ndjson"))).unwrap();
    }

    #[test]
    fn an_unhashed_tail_is_refused_instead_of_silently_rechained() {
        let dir = TempDir::new();
        let path = dir.0.join("command-journal.ndjson");
        std::fs::write(&path, "{\"seq\":7,\"at\":1,\"phase\":\"commit\",\"actorId\":\"user\",\"type\":\"plan.create\",\"target\":\"plan:new\"}\n").unwrap();
        assert!(JournalLog::open(&path).is_err());
    }

    #[test]
    fn stale_writer_and_tampered_history_are_refused() {
        let dir = TempDir::new();
        let path = dir.0.join("journal.ndjson");
        let mut first = JournalLog::open(&path).unwrap();
        let mut stale = JournalLog::open(&path).unwrap();
        first
            .commit(
                "user",
                "plan.create",
                "plan:one",
                json!({"title":"original"}),
            )
            .unwrap();
        assert!(stale
            .commit("user", "plan.delete", "plan:one", json!({}))
            .is_err());
        first
            .commit("user", "plan.toggle", "plan:one", json!({}))
            .unwrap();
        let tampered = std::fs::read_to_string(&path)
            .unwrap()
            .replace("original", "tampered");
        std::fs::write(&path, tampered).unwrap();
        assert!(JournalLog::open(&path).is_err());
    }

    #[test]
    fn a_complete_tail_without_newline_can_be_extended() {
        let dir = TempDir::new();
        let path = dir.0.join("journal.ndjson");
        let mut log = JournalLog::open(&path).unwrap();
        log.commit("user", "plan.create", "plan:one", json!({"title":"first"}))
            .unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        std::fs::write(&path, text.trim_end()).unwrap();
        let mut reopened = JournalLog::open(&path).unwrap();
        reopened
            .commit("user", "plan.toggle", "plan:one", json!({}))
            .unwrap();
        assert_eq!(JournalLog::open(&path).unwrap().entries().len(), 2);
        verify_chain(&read(&path)).unwrap();
    }

    #[test]
    fn recovery_replays_commits_missing_from_the_snapshot_before_new_saves() {
        use crate::{planner::Today, planner_document::PlannerDocument};
        let dir = TempDir::new();
        let path = dir.0.join("planner.json");
        let today = Today("2026-09-22".into());
        let mut log = JournalLog::open(dir.0.join("journal.ndjson")).unwrap();
        log.commit(
            "user",
            "plan.create",
            "plan:one",
            json!({"title":"recover me"}),
        )
        .unwrap();
        let mut document = PlannerDocument::recover(&path, &log, &today).unwrap();
        assert_eq!(document.items["one"].title, "recover me");
        let toggle = log
            .commit("user", "plan.toggle", "plan:one", json!({}))
            .unwrap();
        document.apply(&toggle, &today).unwrap();
        let reopened = PlannerDocument::recover(&path, &log, &today).unwrap();
        assert!(
            reopened.items["one"].done,
            "recovery must not toggle an applied event twice"
        );
    }

    #[test]
    fn recovery_refuses_a_rotated_away_gap_without_overwriting_the_snapshot() {
        use crate::{planner::Today, planner_document::PlannerDocument};
        let dir = TempDir::new();
        let path = dir.0.join("planner.json");
        let journal = dir.0.join("journal.ndjson");
        let mut log = JournalLog::open(&journal).unwrap();
        log.commit("user", "plan.create", "plan:one", json!({"title":"lost"}))
            .unwrap();
        let last = log
            .commit(
                "user",
                "plan.create",
                "plan:two",
                json!({"title":"retained"}),
            )
            .unwrap();
        std::fs::write(&journal, serde_json::to_string(&last).unwrap()).unwrap();
        let rotated = JournalLog::open(&journal).unwrap();
        assert!(PlannerDocument::recover(&path, &rotated, &Today("2026-09-22".into())).is_err());
        assert!(!path.exists());
    }
}
