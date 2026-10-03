//! The command bus: gate order, journal shape, and what a rejection leaves
//! behind.
//!
//! Unlike the other parity suites these are behavioural rather than
//! fixture-compared — the TypeScript flow is async and driven by a queue, so
//! there is no single recorded transcript to diff against. What is asserted
//! here is the contract the TypeScript `apply` implements and that agents
//! depend on: which error wins when several gates would fire, and that the
//! journal never keeps a dangling intent.

use grayspace_app::actors::ActorType;
use grayspace_app::command::ErrorCode;
use grayspace_app::flow::{Command, CommandDefinition, CommandFlow};
use grayspace_app::locks::AcquireInput;
use grayspace_app::schema::{CommandPayloadSchema, FieldSchema, FieldType};
use serde_json::{json, Value};

const NOW: i64 = 1_000_000;

fn flow() -> CommandFlow {
    let mut flow = CommandFlow::new("widget", 0);
    flow.actors
        .register("alice", ActorType::User, Some("Alice"), "ipc", NOW)
        .unwrap();
    flow.actors
        .register("bob", ActorType::Agent, Some("Bob"), "http", NOW)
        .unwrap();
    flow
}

fn command(actor: &str, command_type: &str, target: &str, payload: Value) -> Command {
    Command {
        id: None,
        actor_id: actor.to_owned(),
        command_type: command_type.to_owned(),
        target: target.to_owned(),
        payload,
        base_version: None,
        idempotency_key: None,
    }
}

fn ok_handler() -> grayspace_app::flow::Handler {
    Box::new(|_| Ok(json!({ "applied": true })))
}

fn phases(flow: &CommandFlow) -> Vec<&str> {
    flow.journal
        .entries
        .iter()
        .map(|entry| entry.phase.as_str())
        .collect()
}

#[test]
fn an_accepted_command_writes_intent_then_commit() {
    let mut flow = flow();
    flow.register(CommandDefinition::new("widget.update", ok_handler()));

    let outcome = flow.submit(
        command("alice", "widget.update", "widget:w1", json!({ "x": 1 })),
        NOW,
    );
    let accepted = outcome.result.expect("the command should be accepted");

    assert_eq!(accepted.data, json!({ "applied": true }));
    assert_eq!(
        accepted.version, 1,
        "accepting a write advances the version"
    );
    assert_eq!(phases(&flow), vec!["intent", "commit"]);
    assert_eq!(flow.journal.entries[1].version, Some(1));
    assert_eq!(accepted.seq, flow.journal.entries[1].seq);
}

#[test]
fn an_unknown_command_is_refused_before_anything_is_written() {
    let mut flow = flow();
    let outcome = flow.submit(command("alice", "widget.nope", "widget:w1", json!({})), NOW);
    let error = outcome.result.expect_err("unknown commands are refused");

    assert_eq!(error.code, ErrorCode::UnknownCommand);
    assert!(flow.journal.entries.is_empty(), "nothing was attempted");
}

#[test]
fn an_unregistered_actor_is_refused() {
    let mut flow = flow();
    flow.register(CommandDefinition::new("widget.update", ok_handler()));

    let outcome = flow.submit(
        command("mallory", "widget.update", "widget:w1", json!({})),
        NOW,
    );
    let error = outcome.result.expect_err("an unknown actor is refused");

    assert_eq!(error.code, ErrorCode::UnknownActor);
    assert!(flow.journal.entries.is_empty());
}

#[test]
fn an_invalid_payload_reports_the_schema_message() {
    let mut flow = flow();
    let mut properties = indexmap::IndexMap::new();
    properties.insert("x".to_owned(), FieldSchema::of(FieldType::Number));
    flow.register(
        CommandDefinition::new("widget.update", ok_handler()).schema(CommandPayloadSchema {
            properties,
            required: vec!["x".to_owned()],
            additional_properties: Some(false),
        }),
    );

    let outcome = flow.submit(
        command("alice", "widget.update", "widget:w1", json!({ "x": "no" })),
        NOW,
    );
    let error = outcome.result.expect_err("a bad payload is refused");

    assert_eq!(error.code, ErrorCode::Invalid);
    assert_eq!(
        error.message,
        "invalid payload for widget.update: field \"x\" must be a finite number"
    );
}

#[test]
fn a_malformed_target_is_refused() {
    let mut flow = flow();
    flow.register(CommandDefinition::new("widget.update", ok_handler()));
    let outcome = flow.submit(
        command("alice", "widget.update", "not-a-target", json!({})),
        NOW,
    );
    assert_eq!(outcome.result.unwrap_err().code, ErrorCode::Invalid);
}

#[test]
fn a_resource_locked_by_another_actor_is_refused() {
    let mut flow = flow();
    flow.register(CommandDefinition::new("widget.update", ok_handler()));
    flow.locks
        .acquire(
            AcquireInput {
                resource: "widget:w1",
                actor_id: "bob",
                ttl_ms: Some(5_000),
                reason: None,
                implicit: false,
            },
            NOW,
        )
        .unwrap();

    let outcome = flow.submit(
        command("alice", "widget.update", "widget:w1", json!({})),
        NOW,
    );
    let error = outcome
        .result
        .expect_err("alice cannot write what bob holds");

    assert_eq!(error.code, ErrorCode::Locked);
    assert!(
        flow.journal.entries.is_empty(),
        "the gate fires before the intent"
    );
}

#[test]
fn a_stale_base_version_is_a_conflict() {
    let mut flow = flow();
    flow.register(CommandDefinition::new("widget.update", ok_handler()));

    flow.submit(
        command("alice", "widget.update", "widget:w1", json!({})),
        NOW,
    )
    .result
    .expect("first write lands");

    let mut stale = command("alice", "widget.update", "widget:w1", json!({}));
    stale.base_version = Some(0);
    let error = flow
        .submit(stale, NOW)
        .result
        .expect_err("a stale writer is refused");

    assert_eq!(error.code, ErrorCode::Conflict);
    assert_eq!(error.details.unwrap()["actual"], json!(1));
}

/// Both gates would fire; `locked` must win, because an agent's retry logic
/// keys on the code and the two call for different responses — back off and
/// retry versus re-read and rebase.
#[test]
fn the_lock_gate_wins_over_the_version_gate() {
    let mut flow = flow();
    flow.register(CommandDefinition::new("widget.update", ok_handler()));
    flow.submit(
        command("alice", "widget.update", "widget:w1", json!({})),
        NOW,
    )
    .result
    .unwrap();
    flow.locks
        .acquire(
            AcquireInput {
                resource: "widget:w1",
                actor_id: "bob",
                ttl_ms: Some(5_000),
                reason: None,
                implicit: false,
            },
            NOW,
        )
        .unwrap();

    let mut stale = command("alice", "widget.update", "widget:w1", json!({}));
    stale.base_version = Some(999);
    let error = flow.submit(stale, NOW).result.expect_err("refused");
    assert_eq!(error.code, ErrorCode::Locked);
}

#[test]
fn a_failing_handler_aborts_the_intent_instead_of_leaving_it_dangling() {
    let mut flow = flow();
    flow.register(CommandDefinition::new(
        "widget.update",
        Box::new(|_| {
            Err(grayspace_app::command::CommandError::new(
                ErrorCode::Failed,
                "the handler gave up",
            ))
        }),
    ));

    let outcome = flow.submit(
        command("alice", "widget.update", "widget:w1", json!({})),
        NOW,
    );
    assert_eq!(outcome.result.unwrap_err().code, ErrorCode::Failed);

    assert_eq!(phases(&flow), vec!["intent", "abort"]);
    assert_eq!(
        flow.journal.entries[1].error.as_deref(),
        Some("the handler gave up")
    );
}

/// The lock is taken for the duration of one command and released either way —
/// a handler that fails must not leave the resource wedged.
#[test]
fn the_implicit_lock_is_released_after_success_and_after_failure() {
    let mut flow = flow();
    flow.register(CommandDefinition::new("widget.ok", ok_handler()));
    flow.register(CommandDefinition::new(
        "widget.fail",
        Box::new(|_| {
            Err(grayspace_app::command::CommandError::new(
                ErrorCode::Failed,
                "nope",
            ))
        }),
    ));

    flow.submit(command("alice", "widget.ok", "widget:w1", json!({})), NOW)
        .result
        .unwrap();
    assert!(
        flow.locks.holder("widget:w1", NOW).is_none(),
        "released after success"
    );

    let _ = flow.submit(command("alice", "widget.fail", "widget:w2", json!({})), NOW);
    assert!(
        flow.locks.holder("widget:w2", NOW).is_none(),
        "released after failure"
    );
}

#[test]
fn a_transient_command_leaves_no_journal_entries() {
    let mut flow = flow();
    flow.register(CommandDefinition::new("widget.peek", ok_handler()).transient());

    let accepted = flow
        .submit(command("alice", "widget.peek", "widget:w1", json!({})), NOW)
        .result
        .expect("transient commands still answer");

    assert!(
        flow.journal.entries.is_empty(),
        "a poll must not swamp the log"
    );
    assert_eq!(accepted.seq, 0, "it reports the journal's current head");
}

#[test]
fn ignore_version_skips_the_conflict_gate() {
    let mut flow = flow();
    flow.register(CommandDefinition::new("git.refresh", ok_handler()).ignoring_version());

    let mut stale = command("alice", "git.refresh", "git:repo", json!({}));
    stale.base_version = Some(999);
    assert!(
        flow.submit(stale, NOW).result.is_ok(),
        "a versionless target has nothing to conflict with"
    );
}

#[test]
fn a_command_without_locking_ignores_a_lock_held_by_someone_else() {
    let mut flow = flow();
    flow.register(CommandDefinition::new("widget.read", ok_handler()).without_lock());
    flow.locks
        .acquire(
            AcquireInput {
                resource: "widget:w1",
                actor_id: "bob",
                ttl_ms: Some(5_000),
                reason: None,
                implicit: false,
            },
            NOW,
        )
        .unwrap();

    assert!(flow
        .submit(command("alice", "widget.read", "widget:w1", json!({})), NOW)
        .result
        .is_ok());
}

/// Two spellings of one path must contend for the same lock, or two callers
/// would each think they held it.
#[test]
fn file_targets_are_normalised_before_the_lock_is_taken() {
    let mut flow = flow();
    flow.register(CommandDefinition::new("file.write", ok_handler()));
    flow.locks
        .acquire(
            AcquireInput {
                resource: "file:C:/users/user/notes.txt",
                actor_id: "bob",
                ttl_ms: Some(5_000),
                reason: None,
                implicit: false,
            },
            NOW,
        )
        .unwrap();

    let outcome = flow.submit(
        command(
            "alice",
            "file.write",
            "file:C:\\Users\\User\\Notes.txt",
            json!({}),
        ),
        NOW,
    );
    assert_eq!(
        outcome.result.unwrap_err().code,
        ErrorCode::Locked,
        "a differently spelled path must hit the same lock"
    );
}

// --- admission control ------------------------------------------------------

fn agent_command(command_type: &str, target: &str) -> Command {
    command("bob", command_type, target, json!({}))
}

/// The limiter bounds a runaway agent loop. It must not bound the person at
/// the keyboard, whose commands are driven by their own hands.
#[test]
fn a_user_is_never_rate_limited_but_an_agent_is() {
    let mut flow = flow();
    flow.register(CommandDefinition::new("widget.update", ok_handler()).without_lock());

    // Far past the 30-token default bucket.
    for i in 0..60 {
        let outcome = flow.submit_command(
            command("alice", "widget.update", "widget:w1", json!({ "i": i })),
            NOW,
        );
        assert!(outcome.result.is_ok(), "the user was throttled at {i}");
    }

    let mut refused = 0;
    for i in 0..60 {
        let outcome = flow.submit_command(agent_command("widget.update", "widget:w2"), NOW + i);
        if let Err(error) = outcome.result {
            assert_eq!(error.code, ErrorCode::RateLimited);
            refused += 1;
        }
    }
    assert!(refused > 0, "a runaway agent must eventually be refused");
}

/// A retry after a dropped connection must get the first answer back rather
/// than run the command a second time.
#[test]
fn a_retry_with_the_same_idempotency_key_is_answered_from_the_cache() {
    let mut flow = flow();
    flow.register(CommandDefinition::new("widget.update", ok_handler()));

    let mut first = command("alice", "widget.update", "widget:w1", json!({ "x": 1 }));
    first.idempotency_key = Some("k1".to_owned());
    let first = flow.submit_command(first, NOW).result.expect("accepted");

    let journal_len = flow.journal.entries.len();

    let mut retry = command("alice", "widget.update", "widget:w1", json!({ "x": 1 }));
    retry.idempotency_key = Some("k1".to_owned());
    let replay = flow.submit_command(retry, NOW).result.expect("replayed");

    assert_eq!(replay.seq, first.seq, "the retry gets the original answer");
    assert_eq!(replay.version, first.version);
    assert_eq!(
        flow.journal.entries.len(),
        journal_len,
        "the retry must not run the command again"
    );
}

/// A failed command leaves no cache entry, so the retry actually retries.
#[test]
fn a_failed_command_is_not_remembered_by_its_idempotency_key() {
    let mut flow = flow();
    flow.register(CommandDefinition::new("widget.update", ok_handler()));

    let mut doomed = command("alice", "widget.update", "not-a-target", json!({}));
    doomed.idempotency_key = Some("k2".to_owned());
    assert!(flow.submit_command(doomed, NOW).result.is_err());

    let mut retry = command("alice", "widget.update", "widget:w1", json!({}));
    retry.idempotency_key = Some("k2".to_owned());
    assert!(
        flow.submit_command(retry, NOW).result.is_ok(),
        "the key of a failed command must not answer for a new one"
    );
}

#[test]
fn a_command_without_an_id_is_given_one() {
    let mut flow = flow();
    flow.register(CommandDefinition::new("widget.update", ok_handler()));
    let accepted = flow
        .submit_command(
            command("alice", "widget.update", "widget:w1", json!({})),
            NOW,
        )
        .result
        .unwrap();
    let id = accepted.command_id.expect("an id is minted");
    assert!(id.starts_with("cmd-"), "got {id}");
}
