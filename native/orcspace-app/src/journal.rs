//! The command journal's hash chain, byte-compatible with the TypeScript one.
//!
//! Every entry carries `sha256(JSON.stringify({...}))` over the previous hash
//! and its own fields (see src/main/core/journal.ts). The chain is therefore
//! only reproducible here if this code serializes exactly as JavaScript does —
//! same key order, same number formatting, same string escaping. serde_json's
//! own writer does not: it prints `1e21` where JavaScript prints `1e+21`, and
//! `1e20` where JavaScript prints `100000000000000000000`. So the canonical
//! form is written by hand below and pinned by tests against fixtures the
//! TypeScript implementation generated.
//!
//! This is the first migration step on purpose: if Rust cannot reproduce these
//! hashes, nothing downstream that replays or verifies the journal can be
//! trusted, and it is far cheaper to learn that here than after a UI exists.

use crate::jsjson::{to_js_json, write_string};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const GENESIS_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct JournalEntry {
    pub seq: u64,
    pub at: u64,
    pub phase: String,
    #[serde(rename = "actorId")]
    pub actor_id: String,
    #[serde(rename = "type")]
    pub entry_type: String,
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, rename = "prevHash", skip_serializing_if = "Option::is_none")]
    pub prev_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
}

/// The exact input JavaScript hashes: ten keys, in this order, with absent
/// `version`/`error`/`payload` written as `null` rather than omitted.
fn canonical_hash_input(prev_hash: &str, entry: &JournalEntry) -> String {
    let mut out = String::with_capacity(256);
    out.push('{');
    write_key(&mut out, "prev", prev_hash);
    out.push(',');
    out.push_str("\"seq\":");
    out.push_str(&entry.seq.to_string());
    out.push(',');
    out.push_str("\"at\":");
    out.push_str(&entry.at.to_string());
    out.push(',');
    write_key(&mut out, "phase", &entry.phase);
    out.push(',');
    write_key(&mut out, "actorId", &entry.actor_id);
    out.push(',');
    write_key(&mut out, "type", &entry.entry_type);
    out.push(',');
    write_key(&mut out, "target", &entry.target);
    out.push(',');
    out.push_str("\"version\":");
    match entry.version {
        Some(version) => out.push_str(&version.to_string()),
        None => out.push_str("null"),
    }
    out.push(',');
    out.push_str("\"error\":");
    match &entry.error {
        Some(error) => write_string(&mut out, error),
        None => out.push_str("null"),
    }
    out.push(',');
    out.push_str("\"payload\":");
    match &entry.payload {
        Some(payload) => out.push_str(&to_js_json(payload)),
        None => out.push_str("null"),
    }
    out.push('}');
    out
}

/// Exposed for the parity tests so a mismatch can be diffed rather than guessed.
pub fn canonical_hash_input_for_debug(prev_hash: &str, entry: &JournalEntry) -> String {
    canonical_hash_input(prev_hash, entry)
}

pub fn compute_entry_hash(prev_hash: &str, entry: &JournalEntry) -> String {
    let mut hasher = Sha256::new();
    hasher.update(canonical_hash_input(prev_hash, entry).as_bytes());
    format!("{:x}", hasher.finalize())
}

#[derive(Debug, PartialEq)]
pub enum ChainError {
    /// The entry's recorded prevHash does not match the previous entry's hash.
    BrokenLink { seq: u64, expected: String, found: String },
    /// The entry's own hash is not what its content hashes to — tampering or a
    /// serialization mismatch.
    BadHash { seq: u64, expected: String, found: String },
    MissingHash { seq: u64 },
}

/// Walks the chain from genesis, recomputing every hash.
pub fn verify_chain(entries: &[JournalEntry]) -> Result<(), ChainError> {
    let mut prev = GENESIS_HASH.to_owned();
    for entry in entries {
        if let Some(recorded_prev) = &entry.prev_hash {
            if recorded_prev != &prev {
                return Err(ChainError::BrokenLink {
                    seq: entry.seq,
                    expected: prev,
                    found: recorded_prev.clone(),
                });
            }
        }
        let computed = compute_entry_hash(&prev, entry);
        match &entry.hash {
            None => return Err(ChainError::MissingHash { seq: entry.seq }),
            Some(recorded) if recorded != &computed => {
                return Err(ChainError::BadHash {
                    seq: entry.seq,
                    expected: recorded.clone(),
                    found: computed,
                })
            }
            Some(_) => {}
        }
        prev = computed;
    }
    Ok(())
}

fn write_key(out: &mut String, key: &str, value: &str) {
    out.push('"');
    out.push_str(key);
    out.push_str("\":");
    write_string(out, value);
}

/// Re-exported so the parity tests can pin the number rules in one place.
pub use crate::jsjson::format_js_number;
