//! `JSON.stringify`, reproduced exactly.
//!
//! Two things in OrcSpace depend on matching JavaScript byte for byte rather
//! than merely producing valid JSON:
//!
//! * the command journal hashes `JSON.stringify(...)` output, so a different
//!   spelling of the same value is a different hash and a broken chain;
//! * state files are rewritten in place, so a Rust writer that reformats them
//!   would produce a spurious diff on every save and make it impossible to tell
//!   a real state change from a serializer change.
//!
//! serde_json's own writer differs in three places that matter: it prints
//! `1e21` for JavaScript's `1e+21`, `1e20` for `100000000000000000000`, and —
//! with `preserve_order` off — re-sorts object keys. Hence this module.
//!
//! Reading has its own trap, documented on the serde_json dependency: the
//! default float parser is not always correctly rounded, so `float_roundtrip`
//! must stay enabled or values change by one ULP on the way in, before any of
//! this code runs.

use serde_json::{Map, Value};

/// Compact form, as `JSON.stringify(value)` produces it.
pub fn to_js_json(value: &Value) -> String {
    let mut out = String::with_capacity(256);
    write_value(&mut out, value, None, 0);
    out
}

/// Indented form, as `JSON.stringify(value, null, spaces)` produces it.
///
/// JavaScript's indented form differs from the compact one by more than
/// whitespace: it also puts a space after the key's colon, and it leaves empty
/// objects and arrays as `{}` and `[]` rather than opening a block.
pub fn to_js_json_pretty(value: &Value, spaces: usize) -> String {
    let mut out = String::with_capacity(512);
    write_value(&mut out, value, Some(spaces), 0);
    out
}

fn write_value(out: &mut String, value: &Value, indent: Option<usize>, depth: usize) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => write_number(out, number),
        Value::String(text) => write_string(out, text),
        Value::Array(items) => write_array(out, items, indent, depth),
        Value::Object(map) => write_object(out, map, indent, depth),
    }
}

fn write_array(out: &mut String, items: &[Value], indent: Option<usize>, depth: usize) {
    if items.is_empty() {
        out.push_str("[]");
        return;
    }
    out.push('[');
    for (index, item) in items.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        write_newline_indent(out, indent, depth + 1);
        write_value(out, item, indent, depth + 1);
    }
    write_newline_indent(out, indent, depth);
    out.push(']');
}

fn write_object(out: &mut String, map: &Map<String, Value>, indent: Option<usize>, depth: usize) {
    if map.is_empty() {
        out.push_str("{}");
        return;
    }
    out.push('{');
    // Insertion order, which for a parsed document is document order. This is
    // what serde_json's preserve_order feature buys; without it every key here
    // would come back sorted.
    for (index, (key, value)) in map.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        write_newline_indent(out, indent, depth + 1);
        write_string(out, key);
        out.push(':');
        if indent.is_some() {
            out.push(' ');
        }
        write_value(out, value, indent, depth + 1);
    }
    write_newline_indent(out, indent, depth);
    out.push('}');
}

fn write_newline_indent(out: &mut String, indent: Option<usize>, depth: usize) {
    let Some(spaces) = indent else { return };
    out.push('\n');
    for _ in 0..(spaces * depth) {
        out.push(' ');
    }
}

/// `JSON.stringify`'s string form: escape `"`, `\` and the C0 controls, using
/// the short escapes where they exist and `\u00xx` otherwise. `/`, U+2028 and
/// U+2029 are left raw — JavaScript does not escape them either.
pub fn write_string(out: &mut String, text: &str) {
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
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

pub fn write_number(out: &mut String, number: &serde_json::Number) {
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

/// ECMAScript's `Number::toString`, which is what `JSON.stringify` emits for a
/// non-integral number. Rust's float Display agrees on the digits but not on
/// when to switch to exponent form, nor on writing `e+21` rather than `e21`.
///
/// Given the shortest round-tripping digit string `s` of length `k` and the
/// decimal exponent `n` such that the value is `0.s * 10^n`:
///   k <= n <= 21   -> digits then n-k zeros          (1e20 -> 100000000000000000000)
///   0 <  n <= 21   -> decimal point after n digits   (4617.767343849823)
///   -6 < n <= 0    -> "0." then -n zeros then digits (1e-6 -> 0.000001)
///   otherwise      -> exponent form, sign always written (1e-7, 1e+21)
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
        if n > 0 {
            out.push('+');
        }
        out.push_str(&(n - 1).to_string());
    }
    out
}
