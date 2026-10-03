//! Reading the state files Electron writes.
//!
//! Block 1 of the migration (see docs/RUST-MIGRATION.md). The criterion is
//! round-trip fidelity: parsing a file this app already wrote and serializing
//! it again must reproduce the original bytes. Until that holds, a Rust process
//! cannot share a profile with the Electron one — every save would rewrite
//! files it did not mean to change, and a diff would no longer distinguish a
//! real state change from a serializer change.
//!
//! The files are written by src/main/storage.ts as
//! `JSON.stringify(data, null, 2)`, so the pretty writer in `jsjson` is the one
//! that has to match, indentation and all.
//!
//! Deliberately typed loosely. The point of this block is byte fidelity across
//! every historical shape on disk — including files written by older schema
//! versions — and mapping those onto structs would quietly normalise away the
//! differences this is meant to detect. Typed views come in block 2, on top of
//! a reader already proven lossless.

use crate::jsjson::to_js_json_pretty;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// How `storage.ts` indents. Not a style choice — it is what is on disk.
pub const STATE_INDENT: usize = 2;

#[derive(Debug)]
pub enum StateError {
    Io(std::io::Error),
    Parse {
        file: PathBuf,
        error: serde_json::Error,
    },
}

impl std::fmt::Display for StateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StateError::Io(error) => write!(f, "{error}"),
            StateError::Parse { file, error } => {
                write!(f, "{} is not valid JSON: {error}", file.display())
            }
        }
    }
}

impl std::error::Error for StateError {}

/// One state document, kept as parsed JSON plus the bytes it came from so the
/// round trip can be checked without re-reading the file.
#[derive(Debug, Clone)]
pub struct StateFile {
    pub path: PathBuf,
    pub value: Value,
    pub raw: String,
}

impl StateFile {
    pub fn read(path: impl AsRef<Path>) -> Result<Self, StateError> {
        let path = path.as_ref().to_path_buf();
        let raw = std::fs::read_to_string(&path).map_err(StateError::Io)?;
        // Electron's writer emits a BOM on some paths and the JS reader strips
        // one before parsing (storage.ts does the same), so accept it here too.
        let trimmed = raw.trim_start_matches('\u{feff}');
        let value = serde_json::from_str(trimmed).map_err(|error| StateError::Parse {
            file: path.clone(),
            error,
        })?;
        Ok(Self { path, value, raw })
    }

    /// The bytes this document would be written back as.
    pub fn serialize(&self) -> String {
        to_js_json_pretty(&self.value, STATE_INDENT)
    }

    /// Whether re-serializing reproduces the file exactly.
    ///
    /// A trailing newline is tolerated on the original: it is invisible to the
    /// JSON reader, some editors add one, and it is not evidence of a
    /// serializer disagreement.
    pub fn round_trips(&self) -> bool {
        let original = self.raw.trim_start_matches('\u{feff}');
        let rendered = self.serialize();
        original == rendered || original.trim_end_matches(['\n', '\r']) == rendered
    }
}

/// Which state documents a profile directory holds.
///
/// The canvas, code and terminal documents are per workspace and their names
/// carry a hash of the workspace path, so they are matched by prefix rather
/// than listed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StateKind {
    Canvas,
    Code,
    Board,
    Orchestration,
    WorkspaceState,
    Other,
}

pub fn classify(file_name: &str) -> StateKind {
    if file_name.starts_with("workspace-canvas-") {
        StateKind::Canvas
    } else if file_name.starts_with("workspace-code-") {
        StateKind::Code
    } else if file_name == "workspace-board.json" {
        StateKind::Board
    } else if file_name == "orchestration.json" {
        StateKind::Orchestration
    } else if file_name == "workspace-state.json" {
        StateKind::WorkspaceState
    } else {
        StateKind::Other
    }
}

/// Every JSON state document in a profile directory.
///
/// `.bak` files are included on purpose: they are what a recovery path reads,
/// so a reader that cannot handle them has not actually proven it can take over
/// a profile. Non-JSON files and subdirectories are skipped.
pub fn list_state_files(profile_dir: impl AsRef<Path>) -> Result<Vec<PathBuf>, StateError> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir(profile_dir).map_err(StateError::Io)? {
        let entry = entry.map_err(StateError::Io)?;
        if !entry.file_type().map_err(StateError::Io)?.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".json") || name.ends_with(".json.bak") {
            found.push(entry.path());
        }
    }
    found.sort();
    Ok(found)
}
