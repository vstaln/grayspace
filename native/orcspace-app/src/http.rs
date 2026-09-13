//! The control-server route surface, as a pure function.
//!
//! Block 4. `route` maps a request to a response without touching a socket, so
//! every shape below can be tested directly — and wired into axum by a thin
//! adapter that does nothing but move bytes. The TypeScript equivalent is the
//! `route()` in src/main/controlServer.ts.
//!
//! What is *not* here, deliberately: the loopback guard, the control-token
//! check and the rate limiter. Those run before routing in the TypeScript too
//! (`isTrustedCaller` gates `route`), and keeping them out of the router means
//! the authorization decision stays in one place instead of being repeated per
//! route — which is exactly the duplication that makes an auth bug possible.
//!
//! Response shapes are the contract: `orc --json` parses them. A renamed field
//! is a breaking change for every agent, so the spellings mirror the
//! TypeScript exactly, including that a rejection carries `error` and `code`
//! while an acceptance carries `ok`, `version`, `seq` and `data`.

use crate::command::{CommandError, ErrorCode};
use crate::orchestration::{
    OrchestrationStore, MESSAGE_TYPES, OUTCOMES, TASK_STATUSES,
};
use indexmap::IndexMap;
use serde_json::{json, Map, Value};

#[derive(Debug, Clone)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub query: IndexMap<String, String>,
    pub body: Value,
    /// From `?agentId=` or the `x-agent-id` header, whichever the caller used.
    pub agent_id: Option<String>,
}

impl Request {
    pub fn get(method: &str, path: &str) -> Self {
        Self {
            method: method.to_owned(),
            path: path.to_owned(),
            query: IndexMap::new(),
            body: Value::Null,
            agent_id: None,
        }
    }

    pub fn with_query(mut self, key: &str, value: &str) -> Self {
        self.query.insert(key.to_owned(), value.to_owned());
        self
    }

    pub fn with_body(mut self, body: Value) -> Self {
        self.body = body;
        self
    }

    pub fn as_agent(mut self, agent_id: &str) -> Self {
        self.agent_id = Some(agent_id.to_owned());
        self
    }

    fn segments(&self) -> Vec<String> {
        self.path
            .split('/')
            .filter(|segment| !segment.is_empty())
            .map(|segment| percent_decode(segment))
            .collect()
    }

    fn param(&self, key: &str) -> Option<&str> {
        self.query.get(key).map(String::as_str).filter(|v| !v.is_empty())
    }

    fn flag(&self, key: &str) -> bool {
        self.param(key) == Some("1")
    }

    fn field(&self, key: &str) -> Option<&Value> {
        self.body.get(key).filter(|value| !value.is_null())
    }

    fn text(&self, key: &str) -> Option<&str> {
        self.field(key).and_then(Value::as_str)
    }

    fn strings(&self, key: &str) -> Vec<String> {
        self.field(key)
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Response {
    pub status: u16,
    pub body: Value,
}

impl Response {
    pub fn json(status: u16, body: Value) -> Self {
        Self { status, body }
    }

    /// A rejection, shaped as the TypeScript `reply()` shapes it: the message
    /// under `error`, the machine-readable code beside it, and any details the
    /// error carried merged in at the top level rather than nested.
    pub fn from_error(error: &CommandError) -> Self {
        let mut body = Map::new();
        body.insert("error".into(), Value::from(error.message.clone()));
        body.insert("code".into(), Value::from(error.code.as_str()));
        if let Some(Value::Object(details)) = &error.details {
            for (key, value) in details {
                body.insert(key.clone(), value.clone());
            }
        }
        Self { status: error.code.http_status(), body: Value::Object(body) }
    }

    /// An acceptance, shaped as `reply()` shapes it.
    fn accepted(status: u16, version: u64, seq: u64, data: Value) -> Self {
        Self::json(
            status,
            json!({ "ok": true, "version": version, "seq": seq, "data": data }),
        )
    }
}

/// Minimal percent-decoding for path segments. Ids are generated and contain no
/// reserved characters, but a caller may still encode one.
fn percent_decode(segment: &str) -> String {
    let bytes = segment.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn invalid(message: impl Into<String>) -> Response {
    Response::from_error(&CommandError::new(ErrorCode::Invalid, message))
}

fn not_found(message: impl Into<String>) -> Response {
    Response::from_error(&CommandError::new(ErrorCode::NotFound, message))
}

pub struct RouteDeps<'a> {
    pub orchestration: &'a mut OrchestrationStore,
    pub app_version: &'a str,
    pub workspace_dir: Option<&'a str>,
    pub now: i64,
}

/// Routes one request. `None` means no route matched — the caller answers 404,
/// as the TypeScript does after falling through every branch.
pub fn route(request: &Request, deps: &mut RouteDeps<'_>) -> Option<Response> {
    let segments = request.segments();
    let method = request.method.as_str();
    let head = segments.first().map(String::as_str);

    match head {
        None | Some("health") if method == "GET" => Some(Response::json(
            200,
            json!({
                "ok": true,
                "app": "orcspace",
                "server": "orcspace-control",
                "version": deps.app_version,
                "workspaceDir": deps.workspace_dir,
            }),
        )),
        Some("orchestration") => orchestration_route(request, &segments, deps),
        _ => None,
    }
}

fn orchestration_route(
    request: &Request,
    segments: &[String],
    deps: &mut RouteDeps<'_>,
) -> Option<Response> {
    let method = request.method.as_str();
    let run_id_param = request.param("runId");
    let second = segments.get(1).map(String::as_str);
    let third = segments.get(2).map(String::as_str);
    let fourth = segments.get(3).map(String::as_str);
    let store = &mut *deps.orchestration;

    match (method, second, third, fourth) {
        // --- reads ----------------------------------------------------------
        ("GET", None, _, _) => Some(Response::json(200, snapshot(store, run_id_param))),

        ("GET", Some("runs"), None, _) => Some(Response::json(
            200,
            json!({
                "runs": store.list_runs().iter().map(run_json).collect::<Vec<_>>(),
                "active": store.active_run().map(run_json),
            }),
        )),
        ("GET", Some("runs"), Some(id), _) => Some(match store.require_run(id) {
            Ok(run) => Response::json(200, json!({ "run": run_json(run) })),
            Err(error) => not_found(error.message),
        }),

        ("GET", Some("tasks"), None, _) => {
            if let Some(status) = request.param("status") {
                if !TASK_STATUSES.contains(&status) {
                    return Some(invalid(format!("unknown task status \"{status}\"")));
                }
            }
            let tasks = store.list_tasks(run_id_param, request.param("status"), request.flag("ready"));
            Some(Response::json(
                200,
                json!({ "tasks": tasks.iter().map(task_json).collect::<Vec<_>>() }),
            ))
        }
        ("GET", Some("tasks"), Some(id), _) => Some(match store.require_task(id) {
            Ok(task) => Response::json(200, json!({ "task": task_json(task) })),
            Err(error) => not_found(error.message),
        }),

        ("GET", Some("dispatches"), None, _) => {
            let dispatches =
                store.list_dispatches(run_id_param, request.param("taskId"), None);
            let unaccounted: Vec<String> = store
                .unaccounted_dispatches(run_id_param)
                .iter()
                .map(|d| d.id.clone())
                .collect();
            Some(Response::json(
                200,
                json!({
                    "dispatches": dispatches.iter().map(dispatch_json).collect::<Vec<_>>(),
                    "unaccounted": unaccounted,
                }),
            ))
        }
        ("GET", Some("dispatches"), Some(id), _) => Some(match store.require_dispatch(id) {
            Ok(dispatch) => Response::json(200, json!({ "dispatch": dispatch_json(dispatch) })),
            Err(error) => not_found(error.message),
        }),

        ("GET", Some("gates"), None, _) => Some(Response::json(
            200,
            json!({
                "gates": store
                    .list_gates(run_id_param, request.flag("open"))
                    .iter()
                    .map(gate_json)
                    .collect::<Vec<_>>(),
            }),
        )),
        ("GET", Some("gates"), Some(id), _) => Some(match store.require_gate(id) {
            Ok(gate) => Response::json(200, json!({ "gate": gate_json(gate) })),
            Err(error) => not_found(error.message),
        }),

        ("GET", Some("messages"), Some(id), _) => Some(match store.message_by_id(id) {
            Some(message) => Response::json(200, json!({ "message": message_json(message) })),
            None => not_found(format!("no message \"{id}\"")),
        }),

        ("GET", Some("inbox"), _, _) => {
            let Some(agent_id) = request.agent_id.as_deref() else {
                return Some(Response::from_error(&CommandError::new(
                    ErrorCode::UnknownActor,
                    "agentId is required",
                )));
            };
            let types: Vec<String> = request
                .param("types")
                .map(|raw| {
                    raw.split(',')
                        .map(str::trim)
                        .filter(|t| !t.is_empty())
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            for message_type in &types {
                if !MESSAGE_TYPES.contains(&message_type.as_str()) {
                    return Some(invalid(format!("unknown message type \"{message_type}\"")));
                }
            }
            let messages = store.inbox(agent_id, if types.is_empty() { None } else { Some(&types) });
            // `waited` is always false here: long-polling belongs to the
            // transport, not the router, and a caller that asked to wait gets
            // the immediate answer rather than a wrong claim that it blocked.
            Some(Response::json(
                200,
                json!({
                    "messages": messages.iter().map(message_json).collect::<Vec<_>>(),
                    "waited": false,
                }),
            ))
        }

        ("GET", Some("replies"), Some(ask_id), _) => {
            if store.message_by_id(ask_id).is_none() {
                return Some(not_found(format!("no message \"{ask_id}\"")));
            }
            Some(Response::json(
                200,
                json!({
                    "reply": store.reply_to(ask_id).map(message_json),
                    "waited": false,
                }),
            ))
        }

        // --- writes ---------------------------------------------------------
        ("POST", Some("runs"), None, _) => {
            let objective = request.text("objective").unwrap_or("");
            let coordinator = request.agent_id.as_deref().unwrap_or("api");
            Some(match store.create_run(objective, coordinator, deps.now) {
                Ok(run) => Response::accepted(201, run.version, 0, run_json(&run)),
                Err(error) => Response::from_error(&error),
            })
        }
        ("POST", Some("runs"), Some(id), Some("close")) => {
            Some(match store.close_run(id, deps.now) {
                Ok(run) => Response::accepted(200, run.version, 0, run_json(&run)),
                Err(error) => Response::from_error(&error),
            })
        }

        ("POST", Some("tasks"), None, _) => {
            let run_id = match store.resolve_run_id(request.text("runId")) {
                Ok(id) => id,
                Err(error) => return Some(Response::from_error(&error)),
            };
            let created_by = request.agent_id.as_deref().unwrap_or("api");
            Some(
                match store.create_task(
                    &run_id,
                    request.text("title"),
                    request.text("spec").unwrap_or(""),
                    &request.strings("deps"),
                    &request.strings("images"),
                    created_by,
                    deps.now,
                ) {
                    Ok(task) => Response::accepted(201, task.version, 0, task_json(&task)),
                    Err(error) => Response::from_error(&error),
                },
            )
        }
        ("PATCH", Some("tasks"), Some(id), _) => Some(
            match store.update_task(
                id,
                request.text("status"),
                request.text("title"),
                request.text("spec"),
                deps.now,
            ) {
                Ok(task) => Response::accepted(200, task.version, 0, task_json(&task)),
                Err(error) => Response::from_error(&error),
            },
        ),

        ("POST", Some("dispatches"), None, _) => {
            let (Some(task_id), Some(terminal_id)) =
                (request.text("taskId"), request.text("terminalId"))
            else {
                return Some(invalid("taskId and terminalId are required"));
            };
            Some(
                match store.create_dispatch(
                    task_id,
                    terminal_id,
                    request.text("agent").unwrap_or(""),
                    request.text("preamble").unwrap_or(""),
                    deps.now,
                ) {
                    Ok(dispatch) => {
                        Response::accepted(201, dispatch.version, 0, dispatch_json(&dispatch))
                    }
                    Err(error) => Response::from_error(&error),
                },
            )
        }
        ("POST", Some("dispatches"), Some(id), Some("settle")) => {
            let outcome = request.text("outcome").unwrap_or("");
            if !OUTCOMES.contains(&outcome) {
                return Some(invalid(format!(
                    "outcome must be one of {}",
                    OUTCOMES.join(", ")
                )));
            }
            let files = request.field("filesModified").map(|_| request.strings("filesModified"));
            Some(match store.settle_dispatch(id, outcome, files, deps.now) {
                Ok((dispatch, task, promoted)) => Response::accepted(
                    200,
                    dispatch.version,
                    0,
                    json!({
                        "dispatchId": dispatch.id,
                        "taskId": task.id,
                        "status": task.status,
                        "promoted": promoted,
                    }),
                ),
                Err(error) => Response::from_error(&error),
            })
        }
        ("POST", Some("dispatches"), Some(id), Some("account")) => {
            let state = request.text("state").unwrap_or("released");
            Some(match store.set_dispatch_state(id, state) {
                Ok(dispatch) => {
                    Response::accepted(200, dispatch.version, 0, dispatch_json(&dispatch))
                }
                Err(error) => Response::from_error(&error),
            })
        }

        ("POST", Some("messages"), None, _) => {
            let run_id = match store.resolve_run_id(request.text("runId")) {
                Ok(id) => id,
                Err(error) => return Some(Response::from_error(&error)),
            };
            let from = request.agent_id.as_deref().unwrap_or("api");
            Some(
                match store.send(
                    &run_id,
                    request.text("type").unwrap_or("note"),
                    from,
                    request.text("to").unwrap_or(""),
                    request.text("subject").unwrap_or(""),
                    request.text("body").unwrap_or(""),
                    request.text("taskId"),
                    request.text("dispatchId"),
                    deps.now,
                ) {
                    Ok(message) => Response::accepted(201, 1, 0, message_json(&message)),
                    Err(error) => Response::from_error(&error),
                },
            )
        }
        ("POST", Some("messages"), Some(id), Some("ack")) => {
            let actor = request.agent_id.as_deref().unwrap_or("api");
            Some(match store.ack(id, actor) {
                Ok(message) => Response::accepted(200, 1, 0, message_json(&message)),
                Err(error) => Response::from_error(&error),
            })
        }

        ("POST", Some("gates"), None, _) => {
            let run_id = match store.resolve_run_id(request.text("runId")) {
                Ok(id) => id,
                Err(error) => return Some(Response::from_error(&error)),
            };
            let created_by = request.agent_id.as_deref().unwrap_or("api");
            Some(
                match store.create_gate(
                    &run_id,
                    request.text("question").unwrap_or(""),
                    &request.strings("options"),
                    created_by,
                    request.text("taskId"),
                    deps.now,
                ) {
                    Ok(gate) => Response::accepted(201, gate.version, 0, gate_json(&gate)),
                    Err(error) => Response::from_error(&error),
                },
            )
        }
        ("POST", Some("gates"), Some(id), Some("resolve")) => {
            let resolution = request.text("resolution").unwrap_or("");
            Some(match store.resolve_gate(id, resolution, deps.now) {
                Ok(gate) => Response::accepted(200, gate.version, 0, gate_json(&gate)),
                Err(error) => Response::from_error(&error),
            })
        }

        _ => None,
    }
}

fn snapshot(store: &OrchestrationStore, run_id: Option<&str>) -> Value {
    json!({
        "runs": store.list_runs().iter().map(run_json).collect::<Vec<_>>(),
        "tasks": store.list_tasks(run_id, None, false).iter().map(task_json).collect::<Vec<_>>(),
        "dispatches": store
            .list_dispatches(run_id, None, None)
            .iter()
            .map(dispatch_json)
            .collect::<Vec<_>>(),
        "messages": store.list_messages(run_id).iter().map(message_json).collect::<Vec<_>>(),
        "gates": store.list_gates(run_id, false).iter().map(gate_json).collect::<Vec<_>>(),
    })
}

// The record shapes the API returns are the persisted shapes, so they are
// borrowed from the store's own serializer rather than spelled out twice.
use crate::orchestration::{Dispatch, Gate, Message, OrcTask, Run};

fn run_json(run: &Run) -> Value {
    crate::orchestration::json_for_run(run)
}
fn task_json(task: &OrcTask) -> Value {
    crate::orchestration::json_for_task(task)
}
fn dispatch_json(dispatch: &Dispatch) -> Value {
    crate::orchestration::json_for_dispatch(dispatch)
}
fn message_json(message: &Message) -> Value {
    crate::orchestration::json_for_message(message)
}
fn gate_json(gate: &Gate) -> Value {
    crate::orchestration::json_for_gate(gate)
}
