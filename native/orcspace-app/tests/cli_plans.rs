//! `orc` argument parsing: every command must produce the request the
//! TypeScript CLI produces.
//!
//! The parse is asserted rather than the output, because the request is what
//! the server sees. A wrong path or a dropped field is a command that silently
//! does nothing — or the wrong thing — to a running fleet.

use orcspace_app::cli::{plan, Args, Plan};
use orcspace_app::command::ErrorCode;
use serde_json::{json, Value};

fn args(line: &str) -> Args {
    Args::parse(
        &line
            .split_whitespace()
            .map(str::to_owned)
            .collect::<Vec<_>>(),
    )
}

/// Parses a whole command line: first token is the command.
fn parse(line: &str) -> Plan {
    let tokens: Vec<String> = line.split_whitespace().map(str::to_owned).collect();
    let parsed = Args::parse(&tokens);
    plan(&tokens[0], &parsed).unwrap_or_else(|error| panic!("{line}: {}", error.message))
}

fn parse_err(line: &str) -> orcspace_app::command::CommandError {
    let tokens: Vec<String> = line.split_whitespace().map(str::to_owned).collect();
    let parsed = Args::parse(&tokens);
    plan(&tokens[0], &parsed).expect_err("should have been refused")
}

// --- argument parsing -------------------------------------------------------

#[test]
fn flags_accept_both_spellings() {
    let a = args("cmd --key value --other=thing");
    assert_eq!(a.pick(&["key"]).as_deref(), Some("value"));
    assert_eq!(a.pick(&["other"]).as_deref(), Some("thing"));
}

/// A flag followed by another flag is a boolean, not a flag whose value happens
/// to look like one.
#[test]
fn a_bare_flag_is_true_and_does_not_swallow_the_next_flag() {
    let a = args("cmd --ready --status pending");
    assert!(a.flag("ready"));
    assert_eq!(a.pick(&["status"]).as_deref(), Some("pending"));
}

#[test]
fn the_first_present_alias_wins() {
    let a = args("cmd --body second");
    assert_eq!(
        a.pick(&["spec", "brief", "body"]).as_deref(),
        Some("second")
    );

    let b = args("cmd --spec first --body second");
    assert_eq!(
        b.pick(&["spec", "brief", "body"]).as_deref(),
        Some("first"),
        "alias order decides, not argument order"
    );
}

/// A double dash ends flag parsing, so a body that starts with a dash still
/// reaches the server.
#[test]
fn a_double_dash_ends_flag_parsing() {
    let a = args("cmd -- --not-a-flag");
    assert_eq!(a.pick(&["not-a-flag"]), None);
}

// --- runs -------------------------------------------------------------------

#[test]
fn run_create_takes_a_flag_or_a_positional() {
    let flagged = parse("run-create --objective ship");
    assert_eq!(flagged.method, "POST");
    assert_eq!(flagged.path, "/orchestration/runs");
    assert_eq!(flagged.body, json!({ "objective": "ship" }));

    let positional = parse("run-create ship");
    assert_eq!(positional.body, json!({ "objective": "ship" }));
}

#[test]
fn run_create_without_an_objective_names_the_flag() {
    let error = parse_err("run-create");
    assert_eq!(error.code, ErrorCode::Invalid);
    assert!(
        error.message.contains("--objective"),
        "got {}",
        error.message
    );
}

#[test]
fn runs_and_run_list_are_the_same_command() {
    assert_eq!(parse("runs"), parse("run-list"));
}

#[test]
fn run_show_encodes_the_id_into_the_path() {
    assert_eq!(parse("run-show run-1").path, "/orchestration/runs/run-1");
    assert_eq!(parse("run run-1").path, "/orchestration/runs/run-1");
}

#[test]
fn run_close_posts_to_the_close_sub_path() {
    let plan = parse("run-close run-1");
    assert_eq!(plan.method, "POST");
    assert_eq!(plan.path, "/orchestration/runs/run-1/close");
}

// --- tasks ------------------------------------------------------------------

#[test]
fn task_create_carries_deps_as_a_list() {
    let plan = parse("task-create --spec work --deps otask-1,otask-2 --run run-1");
    assert_eq!(plan.path, "/orchestration/tasks");
    assert_eq!(plan.body["spec"], json!("work"));
    assert_eq!(plan.body["deps"], json!(["otask-1", "otask-2"]));
    assert_eq!(plan.body["runId"], json!("run-1"));
}

/// An omitted optional must be absent, not null — the server distinguishes
/// "not given" from "given as empty".
#[test]
fn task_create_omits_what_was_not_given() {
    let plan = parse("task-create --spec work");
    assert_eq!(plan.body, json!({ "spec": "work" }));
}

#[test]
fn a_trailing_comma_in_a_list_is_harmless() {
    let plan = parse("task-create --spec work --deps otask-1,");
    assert_eq!(plan.body["deps"], json!(["otask-1"]));
}

#[test]
fn task_list_turns_ready_into_a_query_flag() {
    let plan = parse("task-list --ready --run run-1");
    assert_eq!(plan.method, "GET");
    assert_eq!(plan.query.get("ready").map(String::as_str), Some("1"));
    assert_eq!(plan.query.get("runId").map(String::as_str), Some("run-1"));

    let without = parse("tasks");
    assert!(
        without.query.is_empty(),
        "nothing is sent that was not asked for"
    );
}

#[test]
fn task_update_patches() {
    let plan = parse("task-update otask-3 --status completed");
    assert_eq!(plan.method, "PATCH");
    assert_eq!(plan.path, "/orchestration/tasks/otask-3");
    assert_eq!(plan.body, json!({ "status": "completed" }));
}

// --- dispatches -------------------------------------------------------------

#[test]
fn worker_start_and_dispatch_are_the_same_command() {
    assert_eq!(
        parse("worker-start --task otask-1 --agent claude"),
        parse("dispatch --task otask-1 --agent claude")
    );
}

/// Release and retain differ only in the state they send — a single typo here
/// would silently retain what a coordinator meant to release.
#[test]
fn release_and_retain_differ_only_in_state() {
    let released = parse("worker-release disp-1");
    let retained = parse("worker-retain disp-1");
    assert_eq!(released.path, "/orchestration/dispatches/disp-1/account");
    assert_eq!(retained.path, released.path);
    assert_eq!(released.body["state"], json!("released"));
    assert_eq!(retained.body["state"], json!("retained"));
}

#[test]
fn close_is_passed_through_as_a_boolean() {
    let plan = parse("worker-release disp-1 --close");
    assert_eq!(plan.body["closeTerminal"], json!(true));
}

// --- reporting --------------------------------------------------------------

#[test]
fn done_sends_a_worker_done_message() {
    let plan = parse("done --outcome succeeded --task-id otask-1 --dispatch-id disp-1");
    assert_eq!(plan.path, "/orchestration/messages");
    assert_eq!(plan.body["type"], json!("worker_done"));
    assert_eq!(plan.body["outcome"], json!("succeeded"));
}

#[test]
fn done_refuses_an_outcome_that_is_neither() {
    let error = parse_err("done --outcome mostly");
    assert_eq!(error.code, ErrorCode::Invalid);
    assert!(error.message.contains("succeeded"), "got {}", error.message);
}

#[test]
fn done_carries_files_as_a_list() {
    let plan = parse("done --outcome failed --files a.rs,b.rs");
    assert_eq!(plan.body["filesModified"], json!(["a.rs", "b.rs"]));
}

#[test]
fn ask_defaults_its_subject_and_permission_changes_it() {
    let asked = parse("ask --question which?");
    assert_eq!(asked.body["type"], json!("ask"));
    assert_eq!(asked.body["subject"], json!("question"));

    let permission = parse("ask --question may-i? --type permission");
    assert_eq!(permission.body["type"], json!("permission"));
    assert_eq!(
        permission.body["subject"],
        json!("permission_request"),
        "a permission request must read as one in an inbox listing"
    );
}

#[test]
fn reply_names_the_ask_it_answers() {
    let plan = parse("reply msg-4 yes");
    assert_eq!(plan.body["type"], json!("reply"));
    assert_eq!(plan.body["replyTo"], json!("msg-4"));
    assert_eq!(plan.body["body"], json!("yes"));
}

/// Every spelling of allow and of deny must behave identically — agents have
/// been told all of them.
#[test]
fn permission_verbs_are_interchangeable() {
    for granting in ["allow", "approve", "permit"] {
        let plan = parse(&format!("{granting} msg-9"));
        assert_eq!(plan.body["replyTo"], json!("msg-9"), "{granting}");
        assert_eq!(plan.body["body"], json!("allowed"), "{granting}");
    }
    for refusing in ["deny", "reject", "refuse"] {
        let plan = parse(&format!("{refusing} msg-9"));
        assert_eq!(plan.body["body"], json!("denied"), "{refusing}");
    }
}

#[test]
fn a_permission_note_replaces_the_default_body() {
    let plan = parse("deny msg-9 --reason too-risky");
    assert_eq!(plan.body["body"], json!("too-risky"));
}

// --- inbox and gates --------------------------------------------------------

#[test]
fn check_and_inbox_are_the_same_command() {
    assert_eq!(parse("check --wait"), parse("inbox --wait"));
}

#[test]
fn check_passes_its_filters_as_query_parameters() {
    let plan = parse("check --wait --types worker_done,escalation --limit 10");
    assert_eq!(plan.path, "/orchestration/inbox");
    assert_eq!(plan.query.get("wait").map(String::as_str), Some("1"));
    assert_eq!(
        plan.query.get("types").map(String::as_str),
        Some("worker_done,escalation")
    );
    assert_eq!(plan.query.get("limit").map(String::as_str), Some("10"));
}

#[test]
fn gate_resolve_needs_both_an_id_and_a_resolution() {
    let plan = parse("gate-resolve gate-1 yes");
    assert_eq!(plan.path, "/orchestration/gates/gate-1/resolve");
    assert_eq!(plan.body, json!({ "resolution": "yes" }));

    assert_eq!(parse_err("gate-resolve gate-1").code, ErrorCode::Invalid);
}

#[test]
fn gates_takes_an_open_flag() {
    assert_eq!(
        parse("gates --open").query.get("open").map(String::as_str),
        Some("1")
    );
    assert!(parse("gate-list").query.is_empty());
}

// --- misc -------------------------------------------------------------------

#[test]
fn status_reads_the_snapshot() {
    let plan = parse("status --run run-1");
    assert_eq!(plan.path, "/orchestration");
    assert_eq!(plan.query.get("runId").map(String::as_str), Some("run-1"));
    assert_eq!(parse("st"), parse("status"));
}

#[test]
fn an_unknown_command_is_refused_with_a_pointer_to_help() {
    let error = parse_err("teleport");
    assert_eq!(error.code, ErrorCode::UnknownCommand);
    assert!(error.message.contains("help"), "got {}", error.message);
}

/// A body with characters that must not land raw in a URL is encoded.
#[test]
fn ids_are_percent_encoded_into_paths() {
    let tokens: Vec<String> = vec!["run-show".into(), "run 1/x".into()];
    let parsed = Args::parse(&tokens);
    let plan = plan("run-show", &parsed).unwrap();
    assert_eq!(plan.path, "/orchestration/runs/run%201%2Fx");
}

/// A cheap guard over the whole surface: every command must name a method and
/// an absolute path, a GET must carry no body, and a write must carry an object
/// rather than a bare value.
#[test]
fn every_command_plans_a_well_formed_request() {
    for line in [
        "runs",
        "tasks",
        "gates",
        "status",
        "version",
        "dispatches",
        "run-create x",
        "task-create x",
        "task-show t",
        "task-update t --status ready",
        "worker-start --task t",
        "worker-show d",
        "worker-release d",
        "done --outcome failed",
        "escalate",
        "heartbeat",
        "ask q",
        "reply m b",
        "send --to a",
        "ack m",
        "check",
        "gate-create q",
        "gate-resolve g r",
        "allow m",
    ] {
        let plan = parse(line);
        assert!(
            matches!(plan.method.as_str(), "GET" | "POST" | "PATCH"),
            "{line}: odd method {}",
            plan.method
        );
        assert!(plan.path.starts_with('/'), "{line}: {}", plan.path);
        if plan.method == "GET" {
            assert_eq!(
                plan.body,
                Value::Null,
                "{line}: a read must not carry a body"
            );
        } else {
            assert!(
                plan.body.is_object(),
                "{line}: a write must carry an object, got {}",
                plan.body
            );
        }
    }
}
