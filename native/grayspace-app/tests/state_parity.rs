//! Block 1 parity: state files Electron wrote must survive a Rust round trip
//! byte for byte.
//!
//! The synthetic cases below pin the shape of the pretty writer. The real
//! evidence is `round_trips_a_real_profile`, driven by GRAYSPACE_PROFILE — step 0
//! taught that synthetic fixtures find format bugs while real data finds
//! precision bugs, and both classes are fatal here.

use grayspace_app::jsjson::{to_js_json, to_js_json_pretty};
use grayspace_app::state::{classify, list_state_files, StateFile, StateKind, STATE_INDENT};
use serde_json::json;

#[test]
fn pretty_form_matches_json_stringify_with_two_spaces() {
    // Exactly what `JSON.stringify(value, null, 2)` produces, including the
    // space after each colon and the collapsed empty containers.
    let value = json!({
        "snapshotSeq": 0,
        "schemaVersion": 3,
        "widgets": [],
        "camera": { "x": -4617.767343849823, "y": -758.4946652788749, "zoom": 1.2047768476488074 },
        "strokes": [],
        "version": 107
    });
    let expected = concat!(
        "{\n",
        "  \"snapshotSeq\": 0,\n",
        "  \"schemaVersion\": 3,\n",
        "  \"widgets\": [],\n",
        "  \"camera\": {\n",
        "    \"x\": -4617.767343849823,\n",
        "    \"y\": -758.4946652788749,\n",
        "    \"zoom\": 1.2047768476488074\n",
        "  },\n",
        "  \"strokes\": [],\n",
        "  \"version\": 107\n",
        "}"
    );
    assert_eq!(to_js_json_pretty(&value, STATE_INDENT), expected);
}

#[test]
fn empty_containers_stay_collapsed_like_javascript() {
    assert_eq!(to_js_json_pretty(&json!({}), 2), "{}");
    assert_eq!(to_js_json_pretty(&json!([]), 2), "[]");
    assert_eq!(
        to_js_json_pretty(&json!({ "a": {}, "b": [] }), 2),
        "{\n  \"a\": {},\n  \"b\": []\n}"
    );
}

#[test]
fn nested_arrays_indent_one_level_per_depth() {
    let value = json!({ "widgets": [{ "id": "w1", "tags": ["a", "b"] }] });
    let expected = concat!(
        "{\n",
        "  \"widgets\": [\n",
        "    {\n",
        "      \"id\": \"w1\",\n",
        "      \"tags\": [\n",
        "        \"a\",\n",
        "        \"b\"\n",
        "      ]\n",
        "    }\n",
        "  ]\n",
        "}"
    );
    assert_eq!(to_js_json_pretty(&value, 2), expected);
}

#[test]
fn compact_form_has_no_space_after_the_colon() {
    assert_eq!(
        to_js_json(&json!({ "a": 1, "b": [1, 2] })),
        r#"{"a":1,"b":[1,2]}"#
    );
}

#[test]
fn key_order_is_document_order_not_sorted() {
    let parsed: serde_json::Value = serde_json::from_str(r#"{"z":1,"a":2,"m":3}"#).unwrap();
    assert_eq!(to_js_json(&parsed), r#"{"z":1,"a":2,"m":3}"#);
}

#[test]
fn state_file_names_are_classified() {
    assert_eq!(
        classify("workspace-canvas-0630010f33fdb64d.json"),
        StateKind::Canvas
    );
    assert_eq!(
        classify("workspace-code-03ab2b00117dac4d.json"),
        StateKind::Code
    );
    assert_eq!(classify("workspace-board.json"), StateKind::Board);
    assert_eq!(classify("orchestration.json"), StateKind::Orchestration);
    assert_eq!(classify("workspace-state.json"), StateKind::WorkspaceState);
    assert_eq!(classify("control-token"), StateKind::Other);
}

/// The real check. Point it at a profile directory:
///   GRAYSPACE_PROFILE=<dir> cargo test --test state_parity -- --ignored --nocapture
///
/// Not in CI: a profile holds the user's workspace paths and terminal history.
#[test]
#[ignore = "needs a real profile: set GRAYSPACE_PROFILE"]
fn round_trips_a_real_profile() {
    let dir =
        std::env::var("GRAYSPACE_PROFILE").expect("set GRAYSPACE_PROFILE to a userData directory");
    let files = list_state_files(&dir).expect("profile directory is readable");
    assert!(!files.is_empty(), "no JSON state files found in {dir}");

    let mut checked = 0usize;
    let mut failures = Vec::new();
    for path in &files {
        let file = match StateFile::read(path) {
            Ok(file) => file,
            Err(error) => {
                failures.push(format!("{}: {error}", path.display()));
                continue;
            }
        };
        if file.round_trips() {
            checked += 1;
        } else {
            let original = file.raw.trim_start_matches('\u{feff}');
            let rendered = file.serialize();
            let at = original
                .char_indices()
                .zip(rendered.char_indices())
                .find(|((_, a), (_, b))| a != b)
                .map(|((i, _), _)| i)
                .unwrap_or_else(|| original.len().min(rendered.len()));
            let from = at.saturating_sub(50);
            failures.push(format!(
                "{}\n  original: {:?}\n  rendered: {:?}",
                path.display(),
                &original[from..(at + 50).min(original.len())],
                &rendered[from..(at + 50).min(rendered.len())]
            ));
        }
    }

    println!(
        "round-tripped {checked}/{} state files in {dir}",
        files.len()
    );
    assert!(
        failures.is_empty(),
        "state files did not round trip:\n{}",
        failures.join("\n")
    );
}
