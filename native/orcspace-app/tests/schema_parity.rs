//! Payload validation must return the same message the TypeScript returns, for
//! the same payload — including which rule wins when a payload breaks several.

use indexmap::IndexMap;
use orcspace_app::idempotency::{Entry, IdempotencyCache};
use orcspace_app::schema::{validate_payload, CommandPayloadSchema, FieldSchema, FieldType};
use serde_json::{json, Value};

fn strict_schema() -> CommandPayloadSchema {
    let mut properties = IndexMap::new();
    properties.insert("title".to_owned(), FieldSchema::of(FieldType::String));
    properties.insert("count".to_owned(), FieldSchema::of(FieldType::Number));
    properties.insert("flag".to_owned(), FieldSchema::of(FieldType::Boolean));
    properties.insert("tags".to_owned(), FieldSchema::of(FieldType::Array));
    properties.insert("meta".to_owned(), FieldSchema::of(FieldType::Object));
    properties.insert(
        "mode".to_owned(),
        FieldSchema::of(FieldType::String).with_enum(vec![json!("fast"), json!("slow")]),
    );
    properties.insert("anything".to_owned(), FieldSchema::of(FieldType::Any));
    CommandPayloadSchema {
        properties,
        required: vec!["title".to_owned()],
        additional_properties: Some(false),
    }
}

fn open_schema() -> CommandPayloadSchema {
    let mut properties = IndexMap::new();
    properties.insert("title".to_owned(), FieldSchema::of(FieldType::String));
    CommandPayloadSchema { properties, required: Vec::new(), additional_properties: None }
}

#[test]
fn validation_messages_match_typescript() {
    let data: Value = serde_json::from_str(include_str!("fixtures/schema-validation.json"))
        .expect("fixture parses");
    let strict = strict_schema();
    let open = open_schema();

    for case in data["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let schema = if case["schema"] == json!("strict") { &strict } else { &open };
        let actual = validate_payload(schema, &case["payload"]);
        let expected = case["error"].as_str().map(str::to_owned);
        assert_eq!(actual, expected, "case {name:?}");
    }
}

#[test]
fn a_retry_gets_the_first_answer_back_marked_cached() {
    let mut cache = IdempotencyCache::default();
    let now = 1_000;

    cache.track("k1", now);
    assert_eq!(cache.get("k1", now), Some(Entry::Pending), "a running command is known");

    cache.set("k1", json!({ "ok": true, "version": 3 }), now);
    let Some(Entry::Done(result)) = cache.get("k1", now) else {
        panic!("the answer should be stored")
    };
    assert_eq!(result["ok"], json!(true));
    assert_eq!(result["version"], json!(3));
    assert_eq!(
        result["cached"],
        json!(true),
        "a replayed answer must be distinguishable from a fresh one"
    );
}

#[test]
fn an_entry_past_its_ttl_reads_as_unknown() {
    let mut cache = IdempotencyCache::new(100, 1_000);
    cache.set("k1", json!({ "ok": true }), 0);
    assert!(cache.has("k1", 1_000), "still inside the window");
    assert!(!cache.has("k1", 1_001), "past the window");
    assert_eq!(cache.size(), 0, "reading a lapsed entry drops it");
}

#[test]
fn a_failed_command_leaves_no_record_so_the_retry_retries() {
    let mut cache = IdempotencyCache::default();
    cache.track("k1", 0);
    cache.forget("k1");
    assert!(!cache.has("k1", 0));
}

/// Evicting a pending entry would let the command it stands for run twice,
/// which is the one thing this cache exists to prevent.
#[test]
fn pruning_never_evicts_a_command_that_is_still_running() {
    let mut cache = IdempotencyCache::new(3, 10_000);
    cache.track("running", 0);
    cache.set("done-1", json!({ "ok": true }), 0);
    cache.set("done-2", json!({ "ok": true }), 0);
    // At capacity: inserting evicts completed entries, oldest first.
    cache.set("done-3", json!({ "ok": true }), 0);

    assert_eq!(
        cache.get("running", 0),
        Some(Entry::Pending),
        "the in-flight entry must survive eviction"
    );
}
