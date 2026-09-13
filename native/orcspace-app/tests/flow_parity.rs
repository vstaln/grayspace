//! Block 3 parity, core: locks, versions and resource ids answer exactly as the
//! TypeScript implementations do.
//!
//! The fixture in flow-core.json is recorded from the real `LockManager`,
//! `VersionRegistry` and `resources.ts` by scripts/gen-flow-fixture.ts, walking
//! an explicitly stepped clock so expiry is deterministic. This test replays the
//! same timeline and compares step by step.

use orcspace_app::command::ErrorCode;
use orcspace_app::locks::{AcquireInput, LockManager};
use orcspace_app::resources::{file_resource, is_resource_id, parse_resource};
use orcspace_app::versioned::VersionRegistry;
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/flow-core.json")).expect("fixture parses")
}

/// Asserts one recorded step succeeded and hands back its result.
fn expect_ok<'a>(steps: &'a [Value], index: usize, call: &str) -> &'a Value {
    let step = &steps[index];
    assert_eq!(step["call"].as_str().unwrap(), call, "step {index} is a different call");
    assert!(step["ok"].as_bool().unwrap(), "step {index} ({call}) was recorded as failing");
    &step["result"]
}

fn expect_err<'a>(steps: &'a [Value], index: usize, call: &str) -> &'a str {
    let step = &steps[index];
    assert_eq!(step["call"].as_str().unwrap(), call, "step {index} is a different call");
    assert!(!step["ok"].as_bool().unwrap(), "step {index} ({call}) was recorded as succeeding");
    step["code"].as_str().unwrap()
}

fn assert_lock(actual: &orcspace_app::locks::ResourceLock, expected: &Value, at: &str) {
    assert_eq!(actual.actor_id, expected["actorId"].as_str().unwrap(), "{at}: actorId");
    assert_eq!(actual.acquired_at, expected["acquiredAt"].as_i64().unwrap(), "{at}: acquiredAt");
    assert_eq!(actual.expires_at, expected["expiresAt"].as_i64().unwrap(), "{at}: expiresAt");
    assert_eq!(actual.implicit, expected["implicit"].as_bool().unwrap(), "{at}: implicit");
}

fn acquire<'a>(
    resource: &'a str,
    actor_id: &'a str,
    ttl_ms: Option<i64>,
    implicit: bool,
) -> AcquireInput<'a> {
    AcquireInput { resource, actor_id, ttl_ms, reason: None, implicit }
}

#[test]
fn the_lock_timeline_matches_typescript() {
    let data = fixture();
    let steps = data["lockSteps"].as_array().unwrap();
    let mut locks = LockManager::new(None);
    let mut clock: i64 = 1_000_000;
    let mut i = 0;

    let lock = locks
        .acquire(acquire("widget:w1", "alice", Some(5_000), false), clock)
        .expect("first acquire succeeds");
    assert_lock(&lock, expect_ok(steps, i, "acquire widget:w1 by alice"), "w1 by alice");
    i += 1;

    let error = locks
        .acquire(acquire("widget:w1", "bob", Some(5_000), false), clock)
        .expect_err("a second actor is refused");
    assert_eq!(error.code.as_str(), expect_err(steps, i, "acquire widget:w1 by bob"));
    assert_eq!(error.code, ErrorCode::Locked);
    i += 1;

    // Re-acquiring by the holder extends the lease and keeps acquiredAt.
    clock += 1_000;
    let lock = locks
        .acquire(acquire("widget:w1", "alice", Some(5_000), false), clock)
        .expect("the holder may re-acquire");
    assert_lock(&lock, expect_ok(steps, i, "re-acquire widget:w1 by alice"), "w1 re-acquired");
    i += 1;

    let error = locks
        .acquire(acquire("not-a-resource", "alice", None, false), clock)
        .expect_err("a malformed resource id is refused");
    assert_eq!(error.code.as_str(), expect_err(steps, i, "acquire nonsense"));
    i += 1;

    let error = locks
        .acquire(acquire("widget:w2", "   ", None, false), clock)
        .expect_err("a blank actor is refused");
    assert_eq!(error.code.as_str(), expect_err(steps, i, "acquire empty actor"));
    i += 1;

    // TTL clamps up to the 1s minimum ...
    let lock = locks
        .acquire(acquire("widget:w3", "alice", Some(10), false), clock)
        .unwrap();
    assert_lock(&lock, expect_ok(steps, i, "acquire widget:w3 ttl 10ms"), "w3 short ttl");
    i += 1;

    // ... and down to the 10m maximum.
    let lock = locks
        .acquire(acquire("widget:w4", "alice", Some(60 * 60_000), false), clock)
        .unwrap();
    assert_lock(&lock, expect_ok(steps, i, "acquire widget:w4 ttl 1h"), "w4 long ttl");
    i += 1;

    let lock = locks
        .acquire(acquire("terminal:t1", "alice", Some(5_000), true), clock)
        .unwrap();
    assert_lock(
        &lock,
        expect_ok(steps, i, "acquire terminal:t1 implicitly by alice"),
        "t1 implicit",
    );
    i += 1;

    // An implicit lock is skipped: three explicit ones are renewed, not four.
    let renewed = locks.heartbeat("alice", Some(9_000), clock);
    assert_eq!(
        renewed as u64,
        expect_ok(steps, i, "heartbeat alice").as_u64().unwrap(),
        "heartbeat must skip the implicit lock"
    );
    i += 1;

    // Re-acquiring explicitly promotes it.
    let lock = locks
        .acquire(acquire("terminal:t1", "alice", Some(5_000), false), clock)
        .unwrap();
    assert_lock(
        &lock,
        expect_ok(steps, i, "acquire terminal:t1 explicitly by alice"),
        "t1 promoted",
    );
    assert!(!lock.implicit, "an explicit re-acquire promotes an implicit lock");
    i += 1;

    let renewed = locks.heartbeat("alice", Some(9_000), clock);
    assert_eq!(
        renewed as u64,
        expect_ok(steps, i, "heartbeat alice again").as_u64().unwrap(),
        "the promoted lock now counts"
    );
    i += 1;

    let error = locks.release("widget:w1", "bob", clock).expect_err("not the holder");
    assert_eq!(error.code.as_str(), expect_err(steps, i, "release widget:w1 by bob"));
    i += 1;

    locks.release("widget:w1", "alice", clock).expect("the holder may release");
    expect_ok(steps, i, "release widget:w1 by alice");
    i += 1;

    // Releasing what is not held is not an error: it is the desired state.
    locks.release("widget:w1", "alice", clock).expect("releasing twice is quiet");
    expect_ok(steps, i, "release widget:w1 again");
    i += 1;

    let error = locks.renew("widget:w3", "bob", Some(5_000), clock).expect_err("not the holder");
    assert_eq!(error.code.as_str(), expect_err(steps, i, "renew widget:w3 by bob"));
    i += 1;

    let error = locks.renew("widget:nope", "alice", Some(5_000), clock).expect_err("not locked");
    assert_eq!(error.code.as_str(), expect_err(steps, i, "renew missing"));
    assert_eq!(error.code, ErrorCode::NotFound);
    i += 1;

    let lock = locks
        .acquire(acquire("note:short", "alice", Some(10), false), clock)
        .unwrap();
    assert_lock(
        &lock,
        expect_ok(steps, i, "acquire note:short by alice ttl 10ms"),
        "note:short",
    );
    i += 1;

    // Past its lease: an expired lock reads as absent everywhere.
    clock += 2_000;
    assert!(locks.holder("note:short", clock).is_none());
    assert_eq!(expect_ok(steps, i, "holder note:short after expiry"), &Value::Null);
    i += 1;

    // And so a different actor may release it without a `forbidden`.
    locks
        .release("note:short", "bob", clock)
        .expect("an expired lock is not held by anyone");
    expect_ok(steps, i, "release expired note:short by bob");
    i += 1;

    let listed = locks.list(clock);
    let expected = expect_ok(steps, i, "list after expiry").as_array().unwrap();
    assert_eq!(listed.len(), expected.len(), "listing after expiry");
    i += 1;

    let dropped = locks.release_all_for("alice");
    let expected = expect_ok(steps, i, "releaseAllFor alice").as_array().unwrap();
    assert_eq!(dropped.len(), expected.len(), "releaseAllFor");
    i += 1;

    let listed = locks.list(clock);
    assert_eq!(
        listed.len(),
        expect_ok(steps, i, "list after releaseAllFor").as_array().unwrap().len()
    );
    i += 1;

    assert_eq!(i, steps.len(), "every recorded step must be replayed");
}

#[test]
fn the_version_registry_matches_typescript() {
    let data = fixture();
    let steps = data["versionSteps"].as_array().unwrap();
    let mut index = 0;
    let mut expect = |call: &str, actual: Value| {
        let step = &steps[index];
        assert_eq!(step["call"].as_str().unwrap(), call, "version step {index}");
        assert_eq!(step["result"], actual, "version step {index} ({call})");
        index += 1;
    };

    let mut versions = VersionRegistry::new("widget");

    expect("current unknown", Value::from(versions.current("a", None)));
    expect("bump a", Value::from(versions.bump("a", None)));
    expect("bump a again", Value::from(versions.bump("a", None)));
    expect("current a", Value::from(versions.current("a", None)));
    expect("target a", Value::from(versions.target("a")));

    versions.seed([("b", Some(7)), ("c", Some(0)), ("d", None)], None);
    expect("seeded b", Value::from(versions.current("b", None)));
    // A stored 0 floors to 1: an object that exists has been written once, and
    // 0 is reserved for "nothing knows about this".
    expect("seeded c floors at 1", Value::from(versions.current("c", None)));
    expect("seeded d defaults to 1", Value::from(versions.current("d", None)));
    expect("size", Value::from(versions.size(None)));

    versions.create_overlay("spec");
    expect("overlay sees base", Value::from(versions.current("a", Some("spec"))));
    expect("bump in overlay", Value::from(versions.bump("a", Some("spec"))));
    expect("base untouched", Value::from(versions.current("a", None)));
    expect("overlay size", Value::from(versions.size(Some("spec"))));
    versions.discard("spec");
    expect(
        "after discard, overlay falls back to base",
        Value::from(versions.current("a", Some("spec"))),
    );

    versions.create_overlay("spec2");
    versions.bump("a", Some("spec2"));
    versions.bump("e", Some("spec2"));
    versions.commit("spec2");
    expect("committed a", Value::from(versions.current("a", None)));
    expect("committed e", Value::from(versions.current("e", None)));
    expect("hasOverlay after commit", Value::from(versions.has_overlay("spec2")));

    // Naming an overlay that does not exist forgets from the base.
    versions.forget("a", Some("no-such-overlay"));
    expect(
        "forget through a missing overlay hits the base",
        Value::from(versions.current("a", None)),
    );

    assert_eq!(index, steps.len(), "every version step must be replayed");
}

#[test]
fn resource_ids_parse_the_way_typescript_parses_them() {
    let data = fixture();
    for case in data["resourceCases"].as_array().unwrap() {
        let raw = case["raw"].as_str().unwrap();
        let parsed = parse_resource(raw);
        match case["parsed"].as_object() {
            Some(expected) => {
                let parsed = parsed.unwrap_or_else(|| panic!("{raw} should have parsed"));
                assert_eq!(parsed.scheme, expected["scheme"].as_str().unwrap(), "{raw}: scheme");
                assert_eq!(parsed.id, expected["id"].as_str().unwrap(), "{raw}: id");
            }
            None => assert!(parsed.is_none(), "{raw} should not have parsed"),
        }
        assert_eq!(
            is_resource_id(raw),
            case["isResourceId"].as_bool().unwrap(),
            "{raw}: isResourceId"
        );
    }
}

#[test]
fn file_resources_normalise_the_way_typescript_normalises_them() {
    let data = fixture();
    for case in data["fileCases"].as_array().unwrap() {
        let raw = case["raw"].as_str().unwrap();
        assert_eq!(
            file_resource(raw),
            case["id"].as_str().unwrap(),
            "file_resource({raw:?}) diverged — two processes would not see each other's locks"
        );
    }
}

#[test]
fn error_codes_keep_their_wire_spellings_and_statuses() {
    // These reach agents through `orc` and the control server, so a rename is a
    // breaking change rather than a refactor.
    assert_eq!(ErrorCode::NotFound.as_str(), "not_found");
    assert_eq!(ErrorCode::UnknownCommand.as_str(), "unknown_command");
    assert_eq!(ErrorCode::RateLimited.as_str(), "rate_limited");

    assert_eq!(ErrorCode::Conflict.http_status(), 409);
    assert_eq!(ErrorCode::Locked.http_status(), 409);
    assert_eq!(ErrorCode::UnknownActor.http_status(), 401);
    assert_eq!(ErrorCode::Backpressure.http_status(), 429);
    assert_eq!(ErrorCode::Cancelled.http_status(), 499);
}
