//! Per-terminal agent picks — the shell kept three localStorage keys per
//! terminal (`orcspace-agent-select:<id>`, `orcspace-attach:<id>`,
//! `orcspace-launched-agent:<id>`). The attach key gates the orchestration
//! attach mode, which has no native counterpart yet; the other two ride one
//! store file here so a picked agent survives restart and relaunches like
//! the original's mount effect did.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AgentPicks {
    /// `orcspace-agent-select:<id>` — the picker's selected row.
    pub select: HashMap<String, usize>,
    /// `orcspace-launched-agent:<id>` — the agent id whose launch command was
    /// typed; re-typed once per app run when the terminal comes back.
    pub launched: HashMap<String, String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl AgentPicks {
    pub fn path() -> PathBuf {
        crate::ipc::user_data_dir().join("agent-picks.json")
    }

    pub fn load() -> Self {
        Self::load_from(&Self::path())
    }

    pub fn load_from(path: &std::path::Path) -> Self {
        crate::ipc::read_store_recovered(path)
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) -> Result<(), String> {
        let bytes =
            crate::jsjson::to_js_json_pretty(&serde_json::to_value(self).unwrap(), 2).into_bytes();
        crate::ipc::write_file_atomic(&Self::path(), &bytes).map_err(|e| e.to_string())
    }

    /// The menu pick: record the row and mark which agent got launched.
    pub fn pick(&mut self, terminal_id: &str, index: usize, agent_id: &str) {
        self.select.insert(terminal_id.to_owned(), index);
        self.launched
            .insert(terminal_id.to_owned(), agent_id.to_owned());
    }

    /// `vn` — the "Plain shell" row and widget dispose both drop every key.
    pub fn clear(&mut self, terminal_id: &str) {
        self.select.remove(terminal_id);
        self.launched.remove(terminal_id);
    }
}
