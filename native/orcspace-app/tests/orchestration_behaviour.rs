//! Orchestration invariants: the dependency graph, ready promotion, and the
//! conflicts that stop two workers landing on one task.
//!
//! These are the rules a coordinator's correctness rests on, so they are
//! asserted directly rather than diffed against a transcript — what matters is
//! that the rule holds, not that a particular sequence replays.

use orcspace_app::command::ErrorCode;
use orcspace_app::orchestration::OrchestrationStore;

const T0: i64 = 1_000_000;

fn store_with_run() -> (OrchestrationStore, String) {
    let mut store = OrchestrationStore::new();
    let run = store.create_run("ship the thing", "alice", T0).unwrap();
    (store, run.id)
}

#[test]
fn a_run_needs_an_objective() {
    let mut store = OrchestrationStore::new();
    let error = store.create_run("   ", "alice", T0).unwrap_err();
    assert_eq!(error.code, ErrorCode::Invalid);
}

#[test]
fn a_task_with_no_dependencies_is_ready_immediately() {
    let (mut store, run) = store_with_run();
    let task = store
        .create_task(&run, None, "do the work", &[], &[], "alice", T0)
        .unwrap();
    assert_eq!(task.status, "ready");
}

#[test]
fn a_task_with_an_unfinished_dependency_waits() {
    let (mut store, run) = store_with_run();
    let first = store
        .create_task(&run, None, "first", &[], &[], "alice", T0)
        .unwrap();
    let second = store
        .create_task(&run, None, "second", &[first.id.clone()], &[], "alice", T0)
        .unwrap();
    assert_eq!(second.status, "pending", "a dependent task is not dispatchable yet");
}

#[test]
fn the_title_falls_back_to_the_specs_first_line() {
    let (mut store, run) = store_with_run();
    let task = store
        .create_task(&run, None, "Goal: ship it\nScope: everything", &[], &[], "alice", T0)
        .unwrap();
    assert_eq!(task.title, "Goal: ship it");
}

#[test]
fn a_very_long_first_line_is_elided() {
    let (mut store, run) = store_with_run();
    let spec = "x".repeat(200);
    let task = store.create_task(&run, None, &spec, &[], &[], "alice", T0).unwrap();
    assert_eq!(task.title.chars().count(), 78, "77 characters plus the ellipsis");
    assert!(task.title.ends_with('…'));
}

#[test]
fn a_dependency_that_is_not_a_task_is_refused() {
    let (mut store, run) = store_with_run();
    let error = store
        .create_task(&run, None, "spec", &["otask-nope".to_owned()], &[], "alice", T0)
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::NotFound);
}

/// A cross-run dependency would make a task wait on something the coordinator
/// is not tracking.
#[test]
fn a_dependency_from_another_run_is_refused() {
    let (mut store, run_a) = store_with_run();
    let run_b = store.create_run("another", "alice", T0).unwrap();
    let foreign = store
        .create_task(&run_b.id, None, "elsewhere", &[], &[], "alice", T0)
        .unwrap();

    let error = store
        .create_task(&run_a, None, "spec", &[foreign.id], &[], "alice", T0)
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Invalid);
}

/// The promotion has to happen in the same operation as the settle, or a
/// coordinator polling `task-list --ready` would miss it.
#[test]
fn settling_a_dispatch_promotes_what_it_unblocked() {
    let (mut store, run) = store_with_run();
    let first = store.create_task(&run, None, "first", &[], &[], "alice", T0).unwrap();
    let second = store
        .create_task(&run, None, "second", &[first.id.clone()], &[], "alice", T0)
        .unwrap();

    let dispatch = store
        .create_dispatch(&first.id, "term-1", "claude", "brief", T0)
        .unwrap();
    assert_eq!(store.require_task(&first.id).unwrap().status, "dispatched");

    let (_, task, promoted) = store
        .settle_dispatch(&dispatch.id, "succeeded", None, T0 + 1)
        .unwrap();

    assert_eq!(task.status, "completed");
    assert_eq!(promoted, vec![second.id.clone()]);
    assert_eq!(store.require_task(&second.id).unwrap().status, "ready");
}

#[test]
fn a_failed_dispatch_fails_the_task_and_unblocks_nothing() {
    let (mut store, run) = store_with_run();
    let first = store.create_task(&run, None, "first", &[], &[], "alice", T0).unwrap();
    let second = store
        .create_task(&run, None, "second", &[first.id.clone()], &[], "alice", T0)
        .unwrap();
    let dispatch = store
        .create_dispatch(&first.id, "term-1", "claude", "brief", T0)
        .unwrap();

    let (_, task, promoted) = store
        .settle_dispatch(&dispatch.id, "failed", None, T0 + 1)
        .unwrap();

    assert_eq!(task.status, "failed");
    assert!(promoted.is_empty(), "a dependent must not start on a failed dependency");
    assert_eq!(store.require_task(&second.id).unwrap().status, "pending");
}

/// Two workers on one task is the failure this prevents.
#[test]
fn a_task_may_have_only_one_running_dispatch() {
    let (mut store, run) = store_with_run();
    let task = store.create_task(&run, None, "work", &[], &[], "alice", T0).unwrap();
    store
        .create_dispatch(&task.id, "term-1", "claude", "brief", T0)
        .unwrap();

    let error = store
        .create_dispatch(&task.id, "term-2", "codex", "brief", T0)
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
    assert!(error.details.unwrap()["terminalId"] == "term-1");
}

#[test]
fn a_terminal_may_run_only_one_dispatch() {
    let (mut store, run) = store_with_run();
    let one = store.create_task(&run, None, "one", &[], &[], "alice", T0).unwrap();
    let two = store.create_task(&run, None, "two", &[], &[], "alice", T0).unwrap();
    store.create_dispatch(&one.id, "term-1", "claude", "brief", T0).unwrap();

    let error = store
        .create_dispatch(&two.id, "term-1", "claude", "brief", T0)
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
}

#[test]
fn a_completed_task_cannot_be_dispatched_again() {
    let (mut store, run) = store_with_run();
    let task = store.create_task(&run, None, "work", &[], &[], "alice", T0).unwrap();
    let dispatch = store
        .create_dispatch(&task.id, "term-1", "claude", "brief", T0)
        .unwrap();
    store.settle_dispatch(&dispatch.id, "succeeded", None, T0 + 1).unwrap();

    let error = store
        .create_dispatch(&task.id, "term-2", "claude", "brief", T0 + 2)
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
}

/// A duplicated `orc done` must not be able to flip an outcome after the fact.
#[test]
fn settling_is_one_way() {
    let (mut store, run) = store_with_run();
    let task = store.create_task(&run, None, "work", &[], &[], "alice", T0).unwrap();
    let dispatch = store
        .create_dispatch(&task.id, "term-1", "claude", "brief", T0)
        .unwrap();
    store.settle_dispatch(&dispatch.id, "succeeded", None, T0 + 1).unwrap();

    let error = store
        .settle_dispatch(&dispatch.id, "failed", None, T0 + 2)
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
    assert_eq!(
        store.require_task(&task.id).unwrap().status,
        "completed",
        "the first outcome stands"
    );
}

/// Releasing a live dispatch would lose the report the coordinator is blocked
/// on.
#[test]
fn a_running_dispatch_cannot_be_released() {
    let (mut store, run) = store_with_run();
    let task = store.create_task(&run, None, "work", &[], &[], "alice", T0).unwrap();
    let dispatch = store
        .create_dispatch(&task.id, "term-1", "claude", "brief", T0)
        .unwrap();

    let error = store.set_dispatch_state(&dispatch.id, "released").unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
}

#[test]
fn a_settled_dispatch_is_unaccounted_until_it_is_released_or_retained() {
    let (mut store, run) = store_with_run();
    let task = store.create_task(&run, None, "work", &[], &[], "alice", T0).unwrap();
    let dispatch = store
        .create_dispatch(&task.id, "term-1", "claude", "brief", T0)
        .unwrap();
    store.settle_dispatch(&dispatch.id, "succeeded", None, T0 + 1).unwrap();

    assert_eq!(store.unaccounted_dispatches(None).len(), 1);
    store.set_dispatch_state(&dispatch.id, "released").unwrap();
    assert!(store.unaccounted_dispatches(None).is_empty());
}

#[test]
fn marking_a_task_completed_by_hand_also_promotes_its_dependents() {
    let (mut store, run) = store_with_run();
    let first = store.create_task(&run, None, "first", &[], &[], "alice", T0).unwrap();
    let second = store
        .create_task(&run, None, "second", &[first.id.clone()], &[], "alice", T0)
        .unwrap();

    store
        .update_task(&first.id, Some("completed"), None, None, T0 + 1)
        .unwrap();
    assert_eq!(store.require_task(&second.id).unwrap().status, "ready");
}

#[test]
fn an_unknown_status_is_refused() {
    let (mut store, run) = store_with_run();
    let task = store.create_task(&run, None, "work", &[], &[], "alice", T0).unwrap();
    let error = store
        .update_task(&task.id, Some("teleported"), None, None, T0)
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Invalid);
}

#[test]
fn ready_filter_excludes_dispatched_and_finished_tasks() {
    let (mut store, run) = store_with_run();
    let a = store.create_task(&run, None, "a", &[], &[], "alice", T0).unwrap();
    store.create_task(&run, None, "b", &[], &[], "alice", T0 + 1).unwrap();
    store.create_dispatch(&a.id, "term-1", "claude", "brief", T0).unwrap();

    let ready = store.list_tasks(Some(&run), None, true);
    assert_eq!(ready.len(), 1);
    assert_eq!(ready[0].title, "b");
}

#[test]
fn the_inbox_hides_what_the_recipient_already_acked() {
    let (mut store, run) = store_with_run();
    let message = store
        .send(&run, "ask", "worker", "alice", "question", "which way?", None, None, T0)
        .unwrap();
    assert_eq!(store.inbox("alice", None).len(), 1);

    store.ack(&message.id, "alice").unwrap();
    assert!(store.inbox("alice", None).is_empty());
}

/// Broadcast mail reaches everyone, and acking it only clears it for the actor
/// who acked.
#[test]
fn a_broadcast_is_acked_per_recipient() {
    let (mut store, run) = store_with_run();
    let message = store
        .send(&run, "note", "alice", "*", "heads up", "body", None, None, T0)
        .unwrap();
    assert_eq!(store.inbox("bob", None).len(), 1);
    assert_eq!(store.inbox("carol", None).len(), 1);

    store.ack(&message.id, "bob").unwrap();
    assert!(store.inbox("bob", None).is_empty());
    assert_eq!(store.inbox("carol", None).len(), 1, "carol has still not seen it");
}

#[test]
fn an_unknown_message_type_is_refused() {
    let (mut store, run) = store_with_run();
    let error = store
        .send(&run, "telepathy", "a", "b", "s", "b", None, None, T0)
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Invalid);
}

/// Re-resolving would let a decision the run has already acted on be rewritten
/// underneath it.
#[test]
fn a_gate_resolves_once() {
    let (mut store, run) = store_with_run();
    let gate = store
        .create_gate(&run, "ship it?", &["yes".into(), "no".into()], "alice", None, T0)
        .unwrap();
    assert_eq!(store.list_gates(Some(&run), true).len(), 1);

    store.resolve_gate(&gate.id, "yes", T0 + 1).unwrap();
    assert!(store.list_gates(Some(&run), true).is_empty(), "it is no longer open");

    let error = store.resolve_gate(&gate.id, "no", T0 + 2).unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
}

#[test]
fn the_active_run_is_the_newest_open_one() {
    let mut store = OrchestrationStore::new();
    let first = store.create_run("first", "alice", T0).unwrap();
    let second = store.create_run("second", "alice", T0 + 1).unwrap();
    assert_eq!(store.active_run().unwrap().id, second.id);

    store.close_run(&second.id, T0 + 2).unwrap();
    assert_eq!(
        store.active_run().unwrap().id,
        first.id,
        "closing the newest falls back to the one before it"
    );
}

// --- loading a real file ----------------------------------------------------

/// Opens an orchestration.json this app actually wrote.
///
///   ORCSPACE_ORCHESTRATION=<path> cargo test --test orchestration_behaviour -- --ignored --nocapture
///
/// Out of CI: the file carries run objectives and worker preambles.
#[test]
#[ignore = "needs a real file: set ORCSPACE_ORCHESTRATION"]
fn loads_a_real_orchestration_file() {
    let path = std::env::var("ORCSPACE_ORCHESTRATION").expect("ORCSPACE_ORCHESTRATION");
    let raw = std::fs::read_to_string(&path).expect("file is readable");
    let value: serde_json::Value = serde_json::from_str(&raw).expect("parses");

    let store = OrchestrationStore::load(&value);
    let runs = store.list_runs();
    let tasks = store.list_tasks(None, None, false);
    let dispatches = store.list_dispatches(None, None, None);

    assert_eq!(runs.len(), value["runs"].as_array().unwrap().len(), "runs");
    assert_eq!(tasks.len(), value["tasks"].as_array().unwrap().len(), "tasks");
    assert_eq!(
        dispatches.len(),
        value["dispatches"].as_array().unwrap().len(),
        "dispatches"
    );

    // Every task must name a run that is present, or the graph is broken.
    for task in &tasks {
        assert!(
            store.require_run(&task.run_id).is_ok(),
            "task {} points at missing run {}",
            task.id,
            task.run_id
        );
    }
    // Every dispatch must name a task that is present.
    for dispatch in &dispatches {
        assert!(
            store.require_task(&dispatch.task_id).is_ok(),
            "dispatch {} points at missing task {}",
            dispatch.id,
            dispatch.task_id
        );
    }

    // The counter must clear every id already in the file, or the next created
    // record would collide with an existing one.
    let highest = runs
        .iter()
        .map(|r| r.id.clone())
        .chain(tasks.iter().map(|t| t.id.clone()))
        .chain(dispatches.iter().map(|d| d.id.clone()))
        .filter_map(|id| id.rsplit('-').next().and_then(|n| n.parse::<u64>().ok()))
        .max()
        .unwrap_or(0);
    assert!(
        store.counter() >= highest,
        "counter {} would re-mint an existing id (highest seen {highest})",
        store.counter()
    );

    println!(
        "loaded {} runs, {} tasks, {} dispatches; counter at {}",
        runs.len(),
        tasks.len(),
        dispatches.len(),
        store.counter()
    );
}

/// Closes the loop: the store must be able to write back the file it read,
/// byte for byte. Until it can, Rust cannot own orchestration.json — every
/// load would rewrite it and turn a no-op into a diff.
///
///   ORCSPACE_ORCHESTRATION=<path> cargo test --test orchestration_behaviour -- --ignored --nocapture
#[test]
#[ignore = "needs a real file: set ORCSPACE_ORCHESTRATION"]
fn a_real_orchestration_file_survives_a_load_and_save() {
    use orcspace_app::jsjson::to_js_json_pretty;

    let path = std::env::var("ORCSPACE_ORCHESTRATION").expect("ORCSPACE_ORCHESTRATION");
    let raw = std::fs::read_to_string(&path).expect("file is readable");
    let original = raw.trim_start_matches('\u{feff}').trim_end_matches(['\n', '\r']);

    let value: serde_json::Value = serde_json::from_str(original).expect("parses");
    let rendered = to_js_json_pretty(&OrchestrationStore::load(&value).to_json(), 2);

    if original != rendered {
        let at = original
            .char_indices()
            .zip(rendered.char_indices())
            .find(|((_, a), (_, b))| a != b)
            .map(|((i, _), _)| i)
            .unwrap_or_else(|| original.len().min(rendered.len()));
        let from = at.saturating_sub(120);
        panic!(
            "load/save is not byte-identical at char {at}\n  original: {:?}\n  rendered: {:?}",
            &original[from..(at + 120).min(original.len())],
            &rendered[from..(at + 120).min(rendered.len())]
        );
    }
    println!("load/save round-tripped {} bytes byte-for-byte", original.len());
}
