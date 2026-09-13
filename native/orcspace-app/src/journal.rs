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

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
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
    write_key_string(&mut out, "prev", prev_hash);
    out.push(',');
    out.push_str("\"seq\":");
    out.push_str(&entry.seq.to_string());
    out.push(',');
    out.push_str("\"at\":");
    out.push_str(&entry.at.to_string());
    out.push(',');
    write_key_string(&mut out, "phase", &entry.phase);
    out.push(',');
    write_key_string(&mut out, "actorId", &entry.actor_id);
    out.push(',');
    write_key_string(&mut out, "type", &entry.entry_type);
    out.push(',');
    write_key_string(&mut out, "target", &entry.target);
    out.push(',');
    out.push_str("\"version\":");
    match entry.version {
        Some(version) => out.push_str(&version.to_string()),
        None => out.push_str("null"),
    }
    out.push(',');
    out.push_str("\"error\":");
    match &entry.error {
        Some(error) => write_json_string(&mut out, error),
        None => out.push_str("null"),
    }
    out.push(',');
    out.push_str("\"payload\":");
    match &entry.payload {
        Some(payload) => write_json_value(&mut out, payload),
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

fn write_key_string(out: &mut String, key: &str, value: &str) {
    out.push('"');
    out.push_str(key);
    out.push_str("\":");
    write_json_string(out, value);
}

fn write_json_value(out: &mut String, value: &Value) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => write_json_number(out, number),
        Value::String(text) => write_json_string(out, text),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_json_value(out, item);
            }
            out.push(']');
        }
        Value::Object(map) => write_json_object(out, map),
    }
}

fn write_json_object(out: &mut String, map: &Map<String, Value>) {
    out.push('{');
    // Relies on serde_json's preserve_order feature: JavaScript writes keys in
    // insertion order, which for a parsed document is document order. Without
    // that feature this map is a BTreeMap and every multi-key payload would
    // hash differently.
    for (index, (key, value)) in map.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        write_json_string(out, key);
        out.push(':');
        write_json_value(out, value);
    }
    out.push('}');
}

/// JSON.stringify's string form: escape `"`, `\` and the C0 controls, using the
/// short forms where they exist and `\u00xx` otherwise. `/`, U+2028 and U+2029
/// are left raw, which is what JavaScript does and what the fixtures pin.
fn write_json_string(out: &mut String, text: &str) {
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{09}' => out.push_str("\\t"),
            '\u{0a}' => out.push_str("\\n"),
            '\u{0c}' => out.push_str("\\f"),
            '\u{0d}' => out.push_str("\\r"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn write_json_number(out: &mut String, number: &serde_json::Number) {
    if let Some(value) = number.as_u64() {
        out.push_str(&value.to_string());
    } else if let Some(value) = number.as_i64() {
        out.push_str(&value.to_string());
    } else if let Some(value) = number.as_f64() {
        out.push_str(&format_js_number(value));
    } else {
        out.push_str("null");
    }
}

/// ECMAScript's Number::toString, which is what JSON.stringify emits for a
/// non-integral number. Rust's own float Display agrees on the digits but not
/// on when to use exponent form, nor on writing `e+21` rather than `e21`.
///
/// Given the shortest round-tripping digit string `s` of length `k` and the
/// decimal exponent `n` such that the value is `0.s * 10^n`:
///   k <= n <= 21   -> digits then n-k zeros          (1e20 -> 100000000000000000000)
///   0 <  n <= 21   -> decimal point after n digits   (4617.767343849823)
///   -6 < n <= 0    -> "0." then -n zeros then digits (1e-6 -> 0.000001)
///   otherwise      -> exponent form with an explicit sign (1e-7, 1e+21)
pub fn format_js_number(value: f64) -> String {
    if value.is_nan() || value.is_infinite() {
        // JSON.stringify turns both into null.
        return "null".to_owned();
    }
    // Covers -0.0, which JavaScript writes as "0".
    if value == 0.0 {
        return "0".to_owned();
    }

    let negative = value < 0.0;
    let magnitude = value.abs();

    // Rust's {:e} gives the shortest round-tripping mantissa, e.g. "4.617e3".
    let scientific = format!("{:e}", magnitude);
    let (mantissa, exponent) = scientific
        .split_once('e')
        .expect("Rust's {:e} always writes an exponent");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let digits = digits.trim_end_matches('0');
    let digits = if digits.is_empty() { "0" } else { digits };
    let k = digits.len() as i64;
    // {:e} normalises to one digit before the point, so its exponent is n-1.
    let n = exponent.parse::<i64>().expect("exponent is an integer") + 1;

    let mut out = String::new();
    if negative {
        out.push('-');
    }

    if k <= n && n <= 21 {
        out.push_str(digits);
        for _ in 0..(n - k) {
            out.push('0');
        }
    } else if 0 < n && n <= 21 {
        out.push_str(&digits[..n as usize]);
        out.push('.');
        out.push_str(&digits[n as usize..]);
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        for _ in 0..(-n) {
            out.push('0');
        }
        out.push_str(digits);
    } else {
        out.push_str(&digits[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        if n - 1 >= 0 {
            out.push('+');
        }
        out.push_str(&(n - 1).to_string());
    }
    out
}
