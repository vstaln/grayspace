//! `orc`: arguments in, one HTTP request out.
//!
//! Block 4. Mirrors the command surface of cli/orc.mjs. The parse is a pure
//! function so every command's request can be asserted without a server — which
//! is the only practical way to keep ~60 commands from drifting.
//!
//! Two conventions are load-bearing and are copied rather than tidied:
//!
//! * every value flag has aliases, and the *first* one present wins. `--spec`,
//!   `--brief` and `--body` all name a task's brief, because agents have been
//!   told all three at various times and breaking any of them breaks a running
//!   fleet.
//! * a value may arrive as a flag or as the first positional argument, in that
//!   order of preference, so `orc task-show otask-3` and
//!   `orc task-show --id otask-3` are the same command.
//!
//! A missing required value is an `invalid` error naming the flag, not a
//! panic — the message is what the agent reads.

use crate::command::{CommandError, CommandResult, ErrorCode};
use indexmap::IndexMap;
use serde_json::{Map, Value};

/// What a parsed command asks the control server to do.
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub method: String,
    pub path: String,
    pub query: IndexMap<String, String>,
    pub body: Value,
}

impl Plan {
    fn get(path: impl Into<String>) -> Self {
        Self {
            method: "GET".into(),
            path: path.into(),
            query: IndexMap::new(),
            body: Value::Null,
        }
    }

    fn post(path: impl Into<String>, body: Value) -> Self {
        Self {
            method: "POST".into(),
            path: path.into(),
            query: IndexMap::new(),
            body,
        }
    }

    fn patch(path: impl Into<String>, body: Value) -> Self {
        Self {
            method: "PATCH".into(),
            path: path.into(),
            query: IndexMap::new(),
            body,
        }
    }

    fn query(mut self, key: &str, value: Option<String>) -> Self {
        if let Some(value) = value.filter(|v| !v.is_empty()) {
            self.query.insert(key.to_owned(), value);
        }
        self
    }
}

/// Flags and positionals, as parsed from the argument vector.
#[derive(Debug, Default, Clone)]
pub struct Args {
    flags: IndexMap<String, Value>,
    positional: Vec<String>,
}

impl Args {
    /// Accepts `--key value`, `--key=value` and bare `--flag` (which is `true`).
    /// A `--` ends flag parsing, so a body that starts with a dash can still be
    /// passed.
    pub fn parse(argv: &[String]) -> Self {
        let mut args = Args::default();
        let mut index = 0;
        let mut flags_over = false;

        while index < argv.len() {
            let token = &argv[index];
            if flags_over || !token.starts_with("--") {
                args.positional.push(token.clone());
                index += 1;
                continue;
            }
            if token == "--" {
                flags_over = true;
                index += 1;
                continue;
            }
            let stripped = &token[2..];
            if let Some((key, value)) = stripped.split_once('=') {
                args.flags.insert(key.to_owned(), Value::from(value));
                index += 1;
                continue;
            }
            if matches!(
                stripped,
                "json" | "all" | "close" | "open" | "ready" | "wait"
            ) {
                args.flags.insert(stripped.to_owned(), Value::Bool(true));
                index += 1;
                continue;
            }
            // A following token that is itself a flag means this one is a bare
            // boolean, not a flag whose value happens to look like a flag.
            let next = argv.get(index + 1);
            match next {
                Some(value) if !value.starts_with("--") => {
                    args.flags
                        .insert(stripped.to_owned(), Value::from(value.clone()));
                    index += 2;
                }
                _ => {
                    args.flags.insert(stripped.to_owned(), Value::Bool(true));
                    index += 1;
                }
            }
        }
        args
    }

    /// The first alias that carries a string value.
    pub fn pick(&self, aliases: &[&str]) -> Option<String> {
        for alias in aliases {
            match self.flags.get(*alias) {
                Some(Value::String(text)) if !text.is_empty() => return Some(text.clone()),
                Some(Value::Bool(true)) => return Some("true".to_owned()),
                _ => {}
            }
        }
        None
    }

    pub fn flag(&self, name: &str) -> bool {
        matches!(self.flags.get(name), Some(Value::Bool(true)))
    }

    pub fn positionals(&self) -> &[String] {
        &self.positional
    }

    /// A flag, or the positional at `index` if no alias carries a value.
    fn pick_or_positional(&self, aliases: &[&str], index: usize) -> Option<String> {
        self.pick(aliases)
            .or_else(|| self.positional.get(index).cloned())
    }

    fn require(&self, aliases: &[&str], index: usize, message: &str) -> CommandResult<String> {
        self.pick_or_positional(aliases, index)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| CommandError::new(ErrorCode::Invalid, message))
    }

    /// A comma-separated flag as a list. Empty entries are dropped, so a
    /// trailing comma is harmless.
    fn list(&self, aliases: &[&str]) -> Vec<String> {
        self.pick(aliases)
            .map(|raw| {
                raw.split(',')
                    .map(str::trim)
                    .filter(|part| !part.is_empty())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    }
}

fn object(pairs: Vec<(&str, Option<Value>)>) -> Value {
    let mut map = Map::new();
    for (key, value) in pairs {
        if let Some(value) = value {
            map.insert(key.to_owned(), value);
        }
    }
    Value::Object(map)
}

fn text(value: Option<String>) -> Option<Value> {
    value.filter(|v| !v.is_empty()).map(Value::from)
}

fn list_value(values: Vec<String>) -> Option<Value> {
    if values.is_empty() {
        None
    } else {
        Some(Value::from(values))
    }
}

/// Percent-encodes an id for a path segment.
fn encode(id: &str) -> String {
    id.bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}

/// Maps one command line to the request it makes.
///
/// Aliases are resolved here rather than at the call sites so that
/// `orc runs` and `orc run-list` cannot drift apart.
pub fn plan(command: &str, args: &Args) -> CommandResult<Plan> {
    match command {
        // --- runs -----------------------------------------------------------
        "run-create" => {
            let objective = args.require(
                &["objective", "o"],
                1,
                "run-create needs --objective \"...\"",
            )?;
            Ok(Plan::post(
                "/orchestration/runs",
                object(vec![("objective", Some(Value::from(objective)))]),
            ))
        }
        "run-list" | "runs" => Ok(Plan::get("/orchestration/runs")),
        "run-show" | "run" => {
            let id = args.require(&["id", "run", "runId"], 1, "run-show needs <run-id>")?;
            Ok(Plan::get(format!("/orchestration/runs/{}", encode(&id))))
        }
        "run-close" => {
            let id = args.require(&["id", "run", "runId"], 1, "run-close needs <run-id>")?;
            Ok(Plan::post(
                format!("/orchestration/runs/{}/close", encode(&id)),
                Value::Object(Map::new()),
            ))
        }

        // --- tasks ----------------------------------------------------------
        "task-create" => {
            let spec = args.require(&["spec", "brief", "body"], 1, "task-create needs <spec>")?;
            Ok(Plan::post(
                "/orchestration/tasks",
                object(vec![
                    ("spec", Some(Value::from(spec))),
                    ("title", text(args.pick(&["taskTitle", "title"]))),
                    ("deps", list_value(args.list(&["deps", "dep"]))),
                    ("runId", text(args.pick(&["run", "runId"]))),
                ]),
            ))
        }
        "task-list" | "tasks" => Ok(Plan::get("/orchestration/tasks")
            .query("runId", args.pick(&["run", "runId"]))
            .query("status", args.pick(&["status"]))
            .query("ready", args.flag("ready").then(|| "1".to_owned()))),
        "task-show" | "task" => {
            let id = args.require(&["id", "task", "taskId"], 1, "task-show needs <task-id>")?;
            Ok(Plan::get(format!("/orchestration/tasks/{}", encode(&id))))
        }
        "task-update" => {
            let id = args.require(&["id", "task", "taskId"], 1, "task-update needs <task-id>")?;
            Ok(Plan::patch(
                format!("/orchestration/tasks/{}", encode(&id)),
                object(vec![
                    ("status", text(args.pick(&["status"]))),
                    ("title", text(args.pick(&["taskTitle", "title"]))),
                    ("spec", text(args.pick(&["spec", "brief"]))),
                ]),
            ))
        }

        // --- dispatches -----------------------------------------------------
        "worker-start" | "dispatch" => {
            let task = args.require(
                &["task", "taskId"],
                1,
                "worker-start needs --task <task-id>",
            )?;
            Ok(Plan::post(
                "/orchestration/dispatches",
                object(vec![
                    ("taskId", Some(Value::from(task))),
                    ("terminalId", text(args.pick(&["terminal", "terminalId"]))),
                    ("agent", text(args.pick(&["agent"]))),
                    ("command", text(args.pick(&["command", "cmd"]))),
                ]),
            ))
        }
        "worker-release" | "worker-retain" => {
            let id = args.require(
                &["dispatch", "dispatchId", "id"],
                1,
                &format!("{command} needs <dispatch-id>"),
            )?;
            let state = if command == "worker-retain" {
                "retained"
            } else {
                "released"
            };
            Ok(Plan::post(
                format!("/orchestration/dispatches/{}/account", encode(&id)),
                object(vec![
                    ("state", Some(Value::from(state))),
                    (
                        "closeTerminal",
                        args.flag("close").then(|| Value::Bool(true)),
                    ),
                ]),
            ))
        }
        "worker-show" | "dispatch-show" => {
            let id = args.require(
                &["dispatch", "dispatchId", "id"],
                1,
                "worker-show needs <dispatch-id>",
            )?;
            Ok(Plan::get(format!(
                "/orchestration/dispatches/{}",
                encode(&id)
            )))
        }
        "dispatches" => Ok(Plan::get("/orchestration/dispatches")
            .query("runId", args.pick(&["run", "runId"]))
            .query("taskId", args.pick(&["task", "taskId"]))),

        // --- reporting ------------------------------------------------------
        "done" => {
            let outcome = args.require(&["outcome"], 1, "done needs --outcome succeeded|failed")?;
            if outcome != "succeeded" && outcome != "failed" {
                return Err(CommandError::new(
                    ErrorCode::Invalid,
                    "done --outcome must be \"succeeded\" or \"failed\"",
                ));
            }
            Ok(Plan::post(
                "/orchestration/messages",
                object(vec![
                    ("type", Some(Value::from("worker_done"))),
                    ("outcome", Some(Value::from(outcome))),
                    ("taskId", text(args.pick(&["task", "taskId"]))),
                    ("dispatchId", text(args.pick(&["dispatch", "dispatchId"]))),
                    ("body", text(args.pick(&["body", "message"]))),
                    (
                        "filesModified",
                        list_value(args.list(&["files", "filesModified"])),
                    ),
                    ("runId", text(args.pick(&["run", "runId"]))),
                ]),
            ))
        }
        "escalate" => Ok(Plan::post(
            "/orchestration/messages",
            object(vec![
                ("type", Some(Value::from("escalation"))),
                ("body", text(args.pick(&["body", "message"]))),
                ("taskId", text(args.pick(&["task", "taskId"]))),
                ("runId", text(args.pick(&["run", "runId"]))),
            ]),
        )),
        "heartbeat" => Ok(Plan::post(
            "/orchestration/messages",
            object(vec![
                ("type", Some(Value::from("heartbeat"))),
                ("body", text(args.pick(&["body", "message"]))),
                ("runId", text(args.pick(&["run", "runId"]))),
            ]),
        )),
        "ask" => {
            let question = args.require(
                &["question", "body", "q"],
                1,
                "ask needs --question \"...\"",
            )?;
            // `--type permission` reuses this path; the default subject differs
            // so a permission request reads as one in an inbox listing.
            let message_type = args.pick(&["type"]).unwrap_or_else(|| "ask".to_owned());
            let default_subject = if message_type == "permission" {
                "permission_request"
            } else {
                "question"
            };
            Ok(Plan::post(
                "/orchestration/messages",
                object(vec![
                    ("type", Some(Value::from(message_type))),
                    ("body", Some(Value::from(question))),
                    (
                        "subject",
                        Some(Value::from(
                            args.pick(&["subject"])
                                .unwrap_or_else(|| default_subject.to_owned()),
                        )),
                    ),
                    ("options", list_value(args.list(&["options"]))),
                    ("runId", text(args.pick(&["run", "runId"]))),
                ]),
            ))
        }
        "reply" => {
            let ask_id = args.require(&["to", "askId", "id"], 1, "reply needs <ask-id>")?;
            let body = args.require(&["body", "message"], 2, "reply needs a body")?;
            Ok(Plan::post(
                "/orchestration/messages",
                object(vec![
                    ("type", Some(Value::from("reply"))),
                    ("replyTo", Some(Value::from(ask_id))),
                    ("body", Some(Value::from(body))),
                    ("runId", text(args.pick(&["run", "runId"]))),
                ]),
            ))
        }
        "send" | "mail" | "msg" => {
            let to = args.require(&["to"], 1, "send needs --to <actor>")?;
            Ok(Plan::post(
                "/orchestration/messages",
                object(vec![
                    (
                        "type",
                        Some(Value::from(
                            args.pick(&["type"]).unwrap_or_else(|| "note".to_owned()),
                        )),
                    ),
                    ("to", Some(Value::from(to))),
                    ("subject", text(args.pick(&["subject"]))),
                    ("body", text(args.pick(&["body", "message"]))),
                    ("taskId", text(args.pick(&["task", "taskId"]))),
                    ("runId", text(args.pick(&["run", "runId"]))),
                ]),
            ))
        }
        "ack" => {
            let id = args.require(&["id", "message", "messageId"], 1, "ack needs <message-id>")?;
            Ok(Plan::post(
                format!("/orchestration/messages/{}/ack", encode(&id)),
                Value::Object(Map::new()),
            ))
        }

        // --- inbox ----------------------------------------------------------
        "check" | "inbox" => Ok(Plan::get("/orchestration/inbox")
            .query("runId", args.pick(&["run", "runId"]))
            .query("types", args.pick(&["types", "type"]))
            .query("wait", args.flag("wait").then(|| "1".to_owned()))
            .query("all", args.flag("all").then(|| "1".to_owned()))
            .query("limit", args.pick(&["limit"]))),

        // --- gates ----------------------------------------------------------
        "gate-create" => {
            let question = args.require(
                &["question", "q"],
                1,
                "gate-create needs --question \"...\"",
            )?;
            Ok(Plan::post(
                "/orchestration/gates",
                object(vec![
                    ("question", Some(Value::from(question))),
                    ("taskId", text(args.pick(&["task", "taskId"]))),
                    ("options", list_value(args.list(&["options"]))),
                    ("runId", text(args.pick(&["run", "runId"]))),
                ]),
            ))
        }
        "gate-list" | "gates" => Ok(Plan::get("/orchestration/gates")
            .query("runId", args.pick(&["run", "runId"]))
            .query("open", args.flag("open").then(|| "1".to_owned()))),
        "gate-resolve" => {
            let id = args.require(&["id", "gate", "gateId"], 1, "gate-resolve needs <gate-id>")?;
            let resolution = args.require(
                &["resolution", "answer"],
                2,
                "gate-resolve needs --resolution \"...\"",
            )?;
            Ok(Plan::post(
                format!("/orchestration/gates/{}/resolve", encode(&id)),
                object(vec![("resolution", Some(Value::from(resolution)))]),
            ))
        }

        // --- permissions ----------------------------------------------------
        // Three spellings each, because agents have been told all of them.
        "allow" | "approve" | "permit" | "deny" | "reject" | "refuse" => {
            let id = args.require(
                &["id", "permission"],
                1,
                &format!("{command} needs <permission-id>"),
            )?;
            let granted = matches!(command, "allow" | "approve" | "permit");
            Ok(Plan::post(
                "/orchestration/messages",
                object(vec![
                    ("type", Some(Value::from("reply"))),
                    ("replyTo", Some(Value::from(id))),
                    (
                        "body",
                        Some(Value::from(
                            args.pick(&["note", "reason", "body"]).unwrap_or_else(|| {
                                if granted { "allowed" } else { "denied" }.to_owned()
                            }),
                        )),
                    ),
                    ("runId", text(args.pick(&["run", "runId"]))),
                ]),
            ))
        }

        // --- status ---------------------------------------------------------
        "status" | "st" => {
            Ok(Plan::get("/orchestration").query("runId", args.pick(&["run", "runId"])))
        }
        "version" => Ok(Plan::get("/health")),

        _ => Err(CommandError::new(
            ErrorCode::UnknownCommand,
            format!("unknown command \"{command}\" — try `orc help`"),
        )),
    }
}
