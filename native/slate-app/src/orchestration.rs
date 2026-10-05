//! Runs, tasks, dispatches, messages and gates.
//!
//! Mirrors src/main/orchestration/store.ts. This is what `slate` drives and what
//! a coordinator's correctness rests on, so the invariants are the point:
//!
//! * a task is `ready` only when every dependency has *completed*; settling a
//!   dispatch promotes whatever that unblocked, in the same operation, so a
//!   coordinator polling `task-list --ready` never misses a promotion;
//! * a task may have at most one running dispatch and a terminal may run at
//!   most one, both refused as `conflict` rather than silently allowed — two
//!   workers on one task is the failure this prevents;
//! * settling is one-way. A dispatch that is not `running` cannot be settled
//!   again, so a duplicated `slate done` cannot flip a task's outcome.
//!
//! Not journal-folded: this store owns its own file (see block 1). The clock is
//! injected, as everywhere else in the migrated code.

use crate::command::{CommandError, CommandResult, ErrorCode};
use indexmap::IndexMap;
use serde_json::json;

pub const TASK_STATUSES: [&str; 6] = [
    "pending",
    "ready",
    "dispatched",
    "completed",
    "failed",
    "blocked",
];

pub const MESSAGE_TYPES: [&str; 8] = [
    "dispatch",
    "worker_done",
    "heartbeat",
    "escalation",
    "ask",
    "permission",
    "reply",
    "note",
];

pub const DISPATCH_STATES: [&str; 4] = ["running", "settled", "retained", "released"];
pub const OUTCOMES: [&str; 2] = ["succeeded", "failed"];
const MAX_MESSAGES: usize = 2_000;
const MAX_BODY_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct Run {
    pub id: String,
    pub objective: String,
    pub coordinator: String,
    pub created_at: i64,
    pub closed_at: Option<i64>,
    pub version: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OrchestrationTask {
    pub id: String,
    pub run_id: String,
    pub title: String,
    pub spec: String,
    pub deps: Vec<String>,
    pub images: Vec<String>,
    pub status: String,
    pub created_by: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub outcome: Option<String>,
    pub version: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Dispatch {
    pub id: String,
    pub run_id: String,
    pub task_id: String,
    pub terminal_id: String,
    pub agent: String,
    pub state: String,
    pub outcome: Option<String>,
    pub preamble: String,
    pub started_at: i64,
    pub settled_at: Option<i64>,
    pub files_modified: Vec<String>,
    pub version: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Message {
    pub id: String,
    pub run_id: String,
    pub message_type: String,
    pub from: String,
    pub to: String,
    pub subject: String,
    pub body: String,
    pub task_id: Option<String>,
    pub dispatch_id: Option<String>,
    pub outcome: Option<String>,
    pub reply_to: Option<String>,
    /// Attachments a coordinator may still reference — the shell preserved
    /// them through load/rewrite; dropping them was quiet data loss.
    pub files_modified: Vec<String>,
    pub images: Vec<String>,
    /// `ask` messages carry the option labels the user picks between.
    pub options: Vec<String>,
    pub created_at: i64,
    pub acked_by: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Gate {
    pub id: String,
    pub run_id: String,
    pub task_id: Option<String>,
    pub question: String,
    pub options: Vec<String>,
    pub created_by: String,
    pub resolution: Option<String>,
    pub created_at: i64,
    pub resolved_at: Option<i64>,
    pub version: u64,
}

#[derive(Default)]
pub struct OrchestrationStore {
    runs: IndexMap<String, Run>,
    tasks: IndexMap<String, OrchestrationTask>,
    dispatches: IndexMap<String, Dispatch>,
    messages: IndexMap<String, Message>,
    gates: IndexMap<String, Gate>,
    counter: u64,
}

/// The title shown when a task spec's first line has to stand in for one.
fn first_line(text: &str) -> String {
    let line = text.split('\n').next().unwrap_or("").trim();
    if line.chars().count() > 80 {
        let head: String = line.chars().take(77).collect();
        format!("{head}…")
    } else {
        line.to_owned()
    }
}

fn cap_body(body: &str) -> String {
    if body.len() <= MAX_BODY_BYTES {
        return body.to_owned();
    }
    let mut end = MAX_BODY_BYTES;
    while end > 0 && !body.is_char_boundary(end) {
        end -= 1;
    }
    body[..end].to_owned()
}

impl OrchestrationStore {
    pub fn new() -> Self {
        Self::default()
    }

    fn next_id(&mut self, prefix: &str) -> String {
        self.counter += 1;
        format!("{prefix}-{}", self.counter)
    }

    // --- runs ---------------------------------------------------------------

    pub fn create_run(
        &mut self,
        objective: &str,
        coordinator: &str,
        now: i64,
    ) -> CommandResult<Run> {
        let objective = objective.trim();
        if objective.is_empty() {
            return Err(CommandError::new(
                ErrorCode::Invalid,
                "a run needs an objective",
            ));
        }
        let id = self.next_id("run");
        let run = Run {
            id: id.clone(),
            objective: objective.to_owned(),
            coordinator: coordinator.to_owned(),
            created_at: now,
            closed_at: None,
            version: 1,
        };
        self.runs.insert(id, run.clone());
        Ok(run)
    }

    pub fn require_run(&self, id: &str) -> CommandResult<&Run> {
        self.runs.get(id).ok_or_else(|| {
            CommandError::new(
                ErrorCode::NotFound,
                format!("no run \"{id}\" — call run-list first"),
            )
        })
    }

    pub fn close_run(&mut self, id: &str, now: i64) -> CommandResult<Run> {
        self.require_run(id)?;
        let run = self.runs.get_mut(id).expect("checked above");
        run.closed_at = Some(now);
        run.version += 1;
        Ok(run.clone())
    }

    pub fn list_runs(&self) -> Vec<Run> {
        self.runs.values().cloned().collect()
    }

    /// The newest run that has not been closed.
    pub fn active_run(&self) -> Option<&Run> {
        self.runs.values().rev().find(|run| run.closed_at.is_none())
    }

    // --- tasks --------------------------------------------------------------

    // Mirrors the existing command API and its independently optional fields.
    #[allow(clippy::too_many_arguments)]
    pub fn create_task(
        &mut self,
        run_id: &str,
        title: Option<&str>,
        spec: &str,
        deps: &[String],
        images: &[String],
        created_by: &str,
        now: i64,
    ) -> CommandResult<OrchestrationTask> {
        let run_id = self.require_run(run_id)?.id.clone();
        let spec = spec.trim();
        if spec.is_empty() {
            return Err(CommandError::new(ErrorCode::Invalid, "a task needs a spec"));
        }

        // A dependency must exist and belong to this run. A cross-run dep would
        // make a task wait on something the coordinator is not tracking.
        for dep in deps {
            let Some(dep_task) = self.tasks.get(dep) else {
                return Err(CommandError::new(
                    ErrorCode::NotFound,
                    format!("dependency \"{dep}\" is not a task"),
                ));
            };
            if dep_task.run_id != run_id {
                return Err(CommandError::new(
                    ErrorCode::Invalid,
                    format!("dependency \"{dep}\" belongs to a different run"),
                ));
            }
        }

        let satisfied = deps
            .iter()
            .all(|dep| self.tasks.get(dep).is_some_and(|t| t.status == "completed"));
        let id = self.next_id("otask");
        let title = title.unwrap_or("").trim();
        let task = OrchestrationTask {
            id: id.clone(),
            run_id,
            title: if title.is_empty() {
                first_line(spec)
            } else {
                title.to_owned()
            },
            spec: spec.to_owned(),
            deps: deps.to_vec(),
            images: images.to_vec(),
            status: if satisfied { "ready" } else { "pending" }.to_owned(),
            created_by: created_by.to_owned(),
            created_at: now,
            updated_at: now,
            outcome: None,
            version: 1,
        };
        self.tasks.insert(id, task.clone());
        Ok(task)
    }

    pub fn require_task(&self, id: &str) -> CommandResult<&OrchestrationTask> {
        self.tasks.get(id).ok_or_else(|| {
            CommandError::new(
                ErrorCode::NotFound,
                format!("no task \"{id}\" — call task-list first"),
            )
        })
    }

    pub fn list_tasks(
        &self,
        run_id: Option<&str>,
        status: Option<&str>,
        ready_only: bool,
    ) -> Vec<OrchestrationTask> {
        let mut all: Vec<OrchestrationTask> = self
            .tasks
            .values()
            .filter(|task| run_id.is_none_or(|id| task.run_id == id))
            .filter(|task| status.is_none_or(|s| task.status == s))
            .filter(|task| !ready_only || self.is_ready(task))
            .cloned()
            .collect();
        all.sort_by_key(|task| task.created_at);
        all
    }

    /// Dispatchable now: not already running or finished, and every dependency
    /// completed.
    fn is_ready(&self, task: &OrchestrationTask) -> bool {
        if task.status != "pending" && task.status != "ready" {
            return false;
        }
        task.deps
            .iter()
            .all(|dep| self.tasks.get(dep).is_some_and(|t| t.status == "completed"))
    }

    pub fn update_task(
        &mut self,
        id: &str,
        status: Option<&str>,
        title: Option<&str>,
        spec: Option<&str>,
        now: i64,
    ) -> CommandResult<OrchestrationTask> {
        self.require_task(id)?;
        if let Some(status) = status {
            if !TASK_STATUSES.contains(&status) {
                return Err(CommandError::new(
                    ErrorCode::Invalid,
                    format!("status must be one of {}", TASK_STATUSES.join(", ")),
                ));
            }
        }
        {
            let task = self.tasks.get_mut(id).expect("checked above");
            if let Some(status) = status {
                task.status = status.to_owned();
            }
            if let Some(title) = title {
                task.title = title.to_owned();
            }
            if let Some(spec) = spec {
                task.spec = spec.to_owned();
            }
            task.updated_at = now;
            task.version += 1;
        }
        // Marking a task completed by hand can unblock others, so the sweep runs
        // here too, not only on settle.
        self.promote_ready(now);
        Ok(self.tasks.get(id).expect("still present").clone())
    }

    /// Moves every `pending` task whose dependencies are now complete to
    /// `ready`, and reports which moved.
    fn promote_ready(&mut self, now: i64) -> Vec<String> {
        let promoted: Vec<String> = self
            .tasks
            .values()
            .filter(|task| task.status == "pending" && self.is_ready(task))
            .map(|task| task.id.clone())
            .collect();
        for id in &promoted {
            let task = self.tasks.get_mut(id).expect("just listed");
            task.status = "ready".to_owned();
            task.updated_at = now;
            task.version += 1;
        }
        promoted
    }

    // --- dispatches ---------------------------------------------------------

    pub fn create_dispatch(
        &mut self,
        task_id: &str,
        terminal_id: &str,
        agent: &str,
        preamble: &str,
        now: i64,
    ) -> CommandResult<Dispatch> {
        let task = self.require_task(task_id)?.clone();
        if task.status == "completed" {
            return Err(CommandError::new(
                ErrorCode::Conflict,
                format!("task \"{}\" is already completed", task.id),
            ));
        }
        // Two workers on one task is the failure this prevents.
        if let Some(open) = self
            .dispatches
            .values()
            .find(|d| d.task_id == task.id && d.state == "running")
        {
            return Err(CommandError::with_details(
                ErrorCode::Conflict,
                format!("task \"{}\" already has a running dispatch", task.id),
                json!({ "dispatchId": open.id, "terminalId": open.terminal_id }),
            ));
        }
        // Status alone is not the test: a failed task is retried by
        // dispatching it again. What blocks is an unfinished dependency or a
        // decision gate still waiting on the user.
        let has_open_gate = self
            .gates
            .values()
            .any(|gate| gate.task_id.as_deref() == Some(task_id) && gate.resolved_at.is_none());
        if has_open_gate {
            return Err(CommandError::new(
                ErrorCode::Conflict,
                format!("task \"{task_id}\" is waiting on an open decision gate"),
            ));
        }
        let waiting: Vec<&str> = task
            .deps
            .iter()
            .filter(|dep| {
                self.tasks
                    .get(dep.as_str())
                    .is_none_or(|dependency| dependency.status != "completed")
            })
            .map(String::as_str)
            .collect();
        if !waiting.is_empty() {
            return Err(CommandError::new(
                ErrorCode::Conflict,
                format!("task \"{task_id}\" is waiting on {}", waiting.join(", ")),
            ));
        }
        if let Some(busy) = self.dispatch_for_terminal(terminal_id) {
            return Err(CommandError::new(
                ErrorCode::Conflict,
                format!(
                    "terminal \"{terminal_id}\" is already running dispatch {}",
                    busy.id
                ),
            ));
        }

        let id = self.next_id("disp");
        let dispatch = Dispatch {
            id: id.clone(),
            run_id: task.run_id.clone(),
            task_id: task.id.clone(),
            terminal_id: terminal_id.to_owned(),
            agent: agent.to_owned(),
            state: "running".to_owned(),
            outcome: None,
            preamble: preamble.to_owned(),
            started_at: now,
            settled_at: None,
            files_modified: Vec::new(),
            version: 1,
        };
        self.dispatches.insert(id, dispatch.clone());

        let task = self
            .tasks
            .get_mut(&dispatch.task_id)
            .expect("required above");
        task.status = "dispatched".to_owned();
        task.updated_at = now;
        task.version += 1;

        Ok(dispatch)
    }

    pub fn require_dispatch(&self, id: &str) -> CommandResult<&Dispatch> {
        self.dispatches
            .get(id)
            .ok_or_else(|| CommandError::new(ErrorCode::NotFound, format!("no dispatch \"{id}\"")))
    }

    pub fn set_dispatch_preamble(&mut self, id: &str, preamble: &str) -> CommandResult<Dispatch> {
        self.require_dispatch(id)?;
        let dispatch = self.dispatches.get_mut(id).expect("checked above");
        dispatch.preamble = preamble.to_owned();
        Ok(dispatch.clone())
    }

    pub fn list_dispatches(
        &self,
        run_id: Option<&str>,
        task_id: Option<&str>,
        terminal_id: Option<&str>,
    ) -> Vec<Dispatch> {
        let mut all: Vec<Dispatch> = self
            .dispatches
            .values()
            .filter(|d| run_id.is_none_or(|id| d.run_id == id))
            .filter(|d| task_id.is_none_or(|id| d.task_id == id))
            .filter(|d| terminal_id.is_none_or(|id| d.terminal_id == id))
            .cloned()
            .collect();
        all.sort_by_key(|d| d.started_at);
        all
    }

    pub fn dispatch_for_terminal(&self, terminal_id: &str) -> Option<Dispatch> {
        self.dispatches
            .values()
            .find(|d| d.terminal_id == terminal_id && d.state == "running")
            .cloned()
    }

    /// Settles a dispatch and promotes whatever it unblocked, in one step.
    ///
    /// Settling is one-way: a dispatch that is no longer `running` is refused,
    /// so a duplicated `slate done` cannot flip a task's outcome after the fact.
    pub fn settle_dispatch(
        &mut self,
        id: &str,
        outcome: &str,
        files_modified: Option<Vec<String>>,
        now: i64,
    ) -> CommandResult<(Dispatch, OrchestrationTask, Vec<String>)> {
        let dispatch = self.require_dispatch(id)?.clone();
        if dispatch.state != "running" {
            let settled_as = dispatch.outcome.clone().unwrap_or(dispatch.state.clone());
            return Err(CommandError::new(
                ErrorCode::Conflict,
                format!("dispatch \"{id}\" already settled as {settled_as}"),
            ));
        }
        if !OUTCOMES.contains(&outcome) {
            return Err(CommandError::new(
                ErrorCode::Invalid,
                format!("outcome must be one of {}", OUTCOMES.join(", ")),
            ));
        }

        {
            let dispatch = self.dispatches.get_mut(id).expect("checked above");
            dispatch.state = "settled".to_owned();
            dispatch.outcome = Some(outcome.to_owned());
            dispatch.settled_at = Some(now);
            if let Some(files) = files_modified {
                dispatch.files_modified = files;
            }
            dispatch.version += 1;
        }

        self.require_task(&dispatch.task_id)?;
        {
            let task = self
                .tasks
                .get_mut(&dispatch.task_id)
                .expect("checked above");
            task.status = if outcome == "succeeded" {
                "completed"
            } else {
                "failed"
            }
            .to_owned();
            task.outcome = Some(outcome.to_owned());
            task.updated_at = now;
            task.version += 1;
        }

        let promoted = self.promote_ready(now);
        Ok((
            self.dispatches.get(id).expect("present").clone(),
            self.tasks.get(&dispatch.task_id).expect("present").clone(),
            promoted,
        ))
    }

    /// Accounting for a finished worker. Refused while it is still running:
    /// releasing a live dispatch would lose the report the coordinator is
    /// waiting on.
    pub fn set_dispatch_state(&mut self, id: &str, state: &str) -> CommandResult<Dispatch> {
        let dispatch = self.require_dispatch(id)?.clone();
        if dispatch.state == "running" {
            return Err(CommandError::new(
                ErrorCode::Conflict,
                format!("dispatch \"{id}\" is still running — stop it or wait for worker_done"),
            ));
        }
        if state != "retained" && state != "released" {
            return Err(CommandError::new(
                ErrorCode::Invalid,
                format!("unknown dispatch state \"{state}\""),
            ));
        }
        let dispatch = self.dispatches.get_mut(id).expect("checked above");
        dispatch.state = state.to_owned();
        dispatch.version += 1;
        Ok(dispatch.clone())
    }

    /// Settled but neither retained nor released — work the coordinator has not
    /// accounted for yet.
    pub fn unaccounted_dispatches(&self, run_id: Option<&str>) -> Vec<Dispatch> {
        self.list_dispatches(run_id, None, None)
            .into_iter()
            .filter(|d| d.state == "settled")
            .collect()
    }

    // --- messages and gates -------------------------------------------------

    #[allow(clippy::too_many_arguments)]
    pub fn send(
        &mut self,
        run_id: &str,
        message_type: &str,
        from: &str,
        to: &str,
        subject: &str,
        body: &str,
        task_id: Option<&str>,
        dispatch_id: Option<&str>,
        reply_to: Option<&str>,
        outcome: Option<&str>,
        files_modified: Vec<String>,
        images: Vec<String>,
        options: Vec<String>,
        now: i64,
    ) -> CommandResult<Message> {
        self.require_run(run_id)?;
        if !MESSAGE_TYPES.contains(&message_type) {
            return Err(CommandError::new(
                ErrorCode::Invalid,
                format!("type must be one of {}", MESSAGE_TYPES.join(", ")),
            ));
        }
        if let Some(reply_id) = reply_to {
            if !self.messages.contains_key(reply_id) {
                return Err(CommandError::new(
                    ErrorCode::NotFound,
                    format!("no message \"{reply_id}\" to reply to"),
                ));
            }
        }
        let id = self.next_id("msg");
        // defaultSubject(type) + a 500-char cap — the shell labelled mail by
        // kind when the sender gave none.
        let subject = if subject.trim().is_empty() {
            message_type.to_owned()
        } else {
            subject.trim().chars().take(500).collect()
        };
        let message = Message {
            id: id.clone(),
            run_id: run_id.to_owned(),
            message_type: message_type.to_owned(),
            from: from.to_owned(),
            to: to.to_owned(),
            subject,
            body: cap_body(body),
            task_id: task_id.map(str::to_owned),
            dispatch_id: dispatch_id.map(str::to_owned),
            outcome: outcome.map(str::to_owned),
            // Without this a reply cannot be matched back to the ask it
            // answers, and `slate ask` waits forever on an answer that arrived.
            reply_to: reply_to.map(str::to_owned),
            files_modified,
            images,
            options,
            created_at: now,
            acked_by: Vec::new(),
        };
        self.messages.insert(id, message.clone());
        while self.messages.len() > MAX_MESSAGES {
            // Acked mail goes first — an unread ask must outlive thousands of
            // answered reports, exactly the shell's eviction order.
            let victim = self
                .messages
                .iter()
                .find(|(_, m)| !m.acked_by.is_empty())
                .map(|(id, _)| id.clone())
                .or_else(|| self.messages.keys().next().cloned());
            let Some(victim) = victim else {
                break;
            };
            self.messages.shift_remove(&victim);
        }
        Ok(message)
    }

    /// Whether a stored `to` resolves to `actor` under the shell's
    /// `addresses()` semantics: a direct id, `*`/`@all` broadcasts,
    /// `@coordinator` for the run's coordinator, `@idle` for any worker with
    /// a dispatch history but nothing running, and `@<agent>` for the
    /// terminal running that agent right now.
    fn delivers_to(&self, m: &Message, actor: &str) -> bool {
        if m.to == actor || m.to == "*" || m.to == "@all" {
            return true;
        }
        if m.to == "@coordinator" {
            return self
                .runs
                .get(&m.run_id)
                .is_some_and(|run| run.coordinator == actor);
        }
        if m.to == "@idle" {
            let has_history = self.dispatches.values().any(|d| d.terminal_id == actor);
            let running = self
                .dispatches
                .values()
                .any(|d| d.terminal_id == actor && d.state == "running");
            return has_history && !running;
        }
        if let Some(agent) = m.to.strip_prefix('@') {
            return self.dispatches.values().any(|d| {
                d.state == "running"
                    && d.agent.eq_ignore_ascii_case(agent)
                    && d.terminal_id == actor
            });
        }
        false
    }

    /// Unacknowledged mail for one recipient, oldest first — the order a
    /// coordinator should work through it. The sender's own direct mail is
    /// skipped (handles still loop back), same as the shell's `inbox()`.
    /// `all` includes already-acked entries, `run_id` scopes to one run, and
    /// `limit` caps the page the way `since` did.
    pub fn inbox(
        &self,
        to: &str,
        types: Option<&[String]>,
        run_id: Option<&str>,
        include_acked: bool,
        limit: usize,
    ) -> Vec<Message> {
        let mut all: Vec<Message> = self
            .messages
            .values()
            .filter(|m| self.delivers_to(m, to))
            .filter(|m| !(m.from == to && !m.to.starts_with('@') && m.to != "*"))
            .filter(|m| include_acked || !m.acked_by.iter().any(|actor| actor == to))
            .filter(|m| run_id.is_none_or(|run| m.run_id == run))
            .filter(|m| types.is_none_or(|types| types.contains(&m.message_type)))
            .cloned()
            .collect();
        all.sort_by_key(|m| m.created_at);
        all.truncate(limit);
        all
    }

    pub fn ack(&mut self, id: &str, actor_id: &str) -> CommandResult<Message> {
        let Some(message) = self.messages.get_mut(id) else {
            return Err(CommandError::new(
                ErrorCode::NotFound,
                format!("no message \"{id}\""),
            ));
        };
        if !message.acked_by.iter().any(|a| a == actor_id) {
            message.acked_by.push(actor_id.to_owned());
        }
        Ok(message.clone())
    }

    pub fn create_gate(
        &mut self,
        run_id: &str,
        question: &str,
        options: &[String],
        created_by: &str,
        task_id: Option<&str>,
        now: i64,
    ) -> CommandResult<Gate> {
        self.require_run(run_id)?;
        let question = question.trim();
        if question.is_empty() {
            return Err(CommandError::new(
                ErrorCode::Invalid,
                "a gate needs a question",
            ));
        }
        if let Some(task_id) = task_id {
            let Some(task) = self.tasks.get(task_id) else {
                return Err(CommandError::new(
                    ErrorCode::NotFound,
                    format!("no task \"{task_id}\""),
                ));
            };
            if task.run_id != run_id {
                return Err(CommandError::new(
                    ErrorCode::Invalid,
                    format!("task \"{task_id}\" belongs to a different run"),
                ));
            }
            if task.status == "completed" {
                return Err(CommandError::new(
                    ErrorCode::Conflict,
                    format!("task \"{task_id}\" is already completed"),
                ));
            }
        }
        let id = self.next_id("gate");
        let gate = Gate {
            id: id.clone(),
            run_id: run_id.to_owned(),
            task_id: task_id.map(str::to_owned),
            question: question.to_owned(),
            options: options.to_vec(),
            created_by: created_by.to_owned(),
            resolution: None,
            created_at: now,
            resolved_at: None,
            version: 1,
        };
        self.gates.insert(id, gate.clone());
        if let Some(task_id) = task_id {
            if let Some(task) = self.tasks.get_mut(task_id) {
                task.status = "blocked".to_owned();
                task.updated_at = now;
                task.version += 1;
            }
        }
        Ok(gate)
    }

    /// A gate is resolved once. Re-resolving would let a decision the run has
    /// already acted on be rewritten underneath it.
    pub fn resolve_gate(&mut self, id: &str, resolution: &str, now: i64) -> CommandResult<Gate> {
        let Some(existing) = self.gates.get(id) else {
            return Err(CommandError::new(
                ErrorCode::NotFound,
                format!("no gate \"{id}\""),
            ));
        };
        if existing.resolved_at.is_some() {
            return Err(CommandError::new(
                ErrorCode::Conflict,
                format!("gate \"{id}\" is already resolved"),
            ));
        }
        if !existing.options.is_empty()
            && !existing.options.iter().any(|option| option == resolution)
        {
            return Err(CommandError::new(
                ErrorCode::Invalid,
                format!("resolution must be one of {}", existing.options.join(", ")),
            ));
        }
        let task_id = existing.task_id.clone();
        let gate = self.gates.get_mut(id).expect("checked above");
        gate.resolution = Some(resolution.to_owned());
        gate.resolved_at = Some(now);
        gate.version += 1;
        let resolved = gate.clone();
        if let Some(task_id) = task_id {
            let has_open_gate = self.gates.values().any(|gate| {
                gate.task_id.as_deref() == Some(task_id.as_str()) && gate.resolved_at.is_none()
            });
            if has_open_gate {
                return Ok(resolved);
            }
            let deps = self
                .tasks
                .get(&task_id)
                .filter(|task| task.status == "blocked")
                .map(|task| task.deps.clone());
            if let Some(deps) = deps {
                let ready = deps.iter().all(|dep| {
                    self.tasks
                        .get(dep)
                        .is_some_and(|task| task.status == "completed")
                });
                if let Some(task) = self.tasks.get_mut(&task_id) {
                    task.status = if ready { "ready" } else { "pending" }.to_owned();
                    task.updated_at = now;
                    task.version += 1;
                }
            }
        }
        Ok(resolved)
    }

    pub fn list_gates(&self, run_id: Option<&str>, open_only: bool) -> Vec<Gate> {
        self.gates
            .values()
            .filter(|gate| run_id.is_none_or(|id| gate.run_id == id))
            .filter(|gate| !open_only || gate.resolved_at.is_none())
            .cloned()
            .collect()
    }

    pub fn message_by_id(&self, id: &str) -> Option<&Message> {
        self.messages.get(id)
    }

    pub fn require_gate(&self, id: &str) -> CommandResult<&Gate> {
        self.gates
            .get(id)
            .ok_or_else(|| CommandError::new(ErrorCode::NotFound, format!("no gate \"{id}\"")))
    }

    /// The answer to an `ask`, if one has been sent.
    pub fn reply_to(&self, ask_id: &str) -> Option<&Message> {
        self.messages
            .values()
            .find(|m| m.message_type == "reply" && m.reply_to.as_deref() == Some(ask_id))
    }

    /// A run id for a caller that did not name one: the newest open run.
    pub fn resolve_run_id(&self, given: Option<&str>) -> CommandResult<String> {
        if let Some(given) = given.filter(|id| !id.is_empty()) {
            return Ok(self.require_run(given)?.id.clone());
        }
        self.active_run().map(|run| run.id.clone()).ok_or_else(|| {
            CommandError::new(ErrorCode::NotFound, "no open run — call run-create first")
        })
    }

    pub fn list_messages(&self, run_id: Option<&str>) -> Vec<Message> {
        self.messages
            .values()
            .filter(|m| run_id.is_none_or(|id| m.run_id == id))
            .cloned()
            .collect()
    }
}

// --- persistence ------------------------------------------------------------

fn string_at(value: &serde_json::Value, key: &str) -> String {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_owned()
}

fn opt_string(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .filter(|s| !s.is_empty())
}

fn int_at(value: &serde_json::Value, key: &str) -> i64 {
    value
        .get(key)
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0)
}

fn opt_int(value: &serde_json::Value, key: &str) -> Option<i64> {
    value.get(key).and_then(serde_json::Value::as_i64)
}

fn strings_at(value: &serde_json::Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

impl OrchestrationStore {
    /// Rebuilds a store from the JSON `orchestration.json` holds.
    ///
    /// Unknown fields are ignored and missing ones take their zero value: a
    /// file written by an older build must still open, which is the whole point
    /// of reading the real format rather than a normalised one.
    pub fn load(value: &serde_json::Value) -> Self {
        let mut store = Self::new();
        let array = |key: &str| {
            value
                .get(key)
                .and_then(serde_json::Value::as_array)
                .cloned()
                .unwrap_or_default()
        };

        for raw in array("runs") {
            let run = Run {
                id: string_at(&raw, "id"),
                objective: string_at(&raw, "objective"),
                coordinator: string_at(&raw, "coordinator"),
                created_at: int_at(&raw, "createdAt"),
                closed_at: opt_int(&raw, "closedAt"),
                version: int_at(&raw, "version").max(1) as u64,
            };
            store.runs.insert(run.id.clone(), run);
        }
        for raw in array("tasks") {
            let task = OrchestrationTask {
                id: string_at(&raw, "id"),
                run_id: string_at(&raw, "runId"),
                title: string_at(&raw, "title"),
                spec: string_at(&raw, "spec"),
                deps: strings_at(&raw, "deps"),
                images: strings_at(&raw, "images"),
                status: string_at(&raw, "status"),
                created_by: string_at(&raw, "createdBy"),
                created_at: int_at(&raw, "createdAt"),
                updated_at: int_at(&raw, "updatedAt"),
                outcome: opt_string(&raw, "outcome"),
                version: int_at(&raw, "version").max(1) as u64,
            };
            store.tasks.insert(task.id.clone(), task);
        }
        for raw in array("dispatches") {
            let dispatch = Dispatch {
                id: string_at(&raw, "id"),
                run_id: string_at(&raw, "runId"),
                task_id: string_at(&raw, "taskId"),
                terminal_id: string_at(&raw, "terminalId"),
                agent: string_at(&raw, "agent"),
                state: string_at(&raw, "state"),
                outcome: opt_string(&raw, "outcome"),
                preamble: string_at(&raw, "preamble"),
                started_at: int_at(&raw, "startedAt"),
                settled_at: opt_int(&raw, "settledAt"),
                files_modified: strings_at(&raw, "filesModified"),
                version: int_at(&raw, "version").max(1) as u64,
            };
            store.dispatches.insert(dispatch.id.clone(), dispatch);
        }
        for raw in array("messages") {
            let message = Message {
                id: string_at(&raw, "id"),
                run_id: string_at(&raw, "runId"),
                message_type: string_at(&raw, "type"),
                from: string_at(&raw, "from"),
                to: string_at(&raw, "to"),
                subject: string_at(&raw, "subject"),
                body: string_at(&raw, "body"),
                task_id: opt_string(&raw, "taskId"),
                dispatch_id: opt_string(&raw, "dispatchId"),
                outcome: opt_string(&raw, "outcome"),
                reply_to: opt_string(&raw, "replyTo"),
                files_modified: strings_at(&raw, "filesModified"),
                images: strings_at(&raw, "images"),
                options: strings_at(&raw, "options"),
                created_at: int_at(&raw, "createdAt"),
                acked_by: strings_at(&raw, "ackedBy"),
            };
            store.messages.insert(message.id.clone(), message);
        }
        for raw in array("gates") {
            let gate = Gate {
                id: string_at(&raw, "id"),
                run_id: string_at(&raw, "runId"),
                task_id: opt_string(&raw, "taskId"),
                question: string_at(&raw, "question"),
                options: strings_at(&raw, "options"),
                created_by: string_at(&raw, "createdBy"),
                resolution: opt_string(&raw, "resolution"),
                created_at: int_at(&raw, "createdAt"),
                resolved_at: opt_int(&raw, "resolvedAt"),
                version: int_at(&raw, "version").max(1) as u64,
            };
            store.gates.insert(gate.id.clone(), gate);
        }

        // The id counter is shared across every kind — real files hold run-1,
        // otask-2, disp-7 from one sequence — so it restores to the highest
        // number seen anywhere. Restarting it at zero would mint ids that
        // collide with existing records and overwrite them.
        let ids = store
            .runs
            .keys()
            .chain(store.tasks.keys())
            .chain(store.dispatches.keys())
            .chain(store.gates.keys())
            .chain(store.messages.keys());
        let mut counter = 0u64;
        for id in ids {
            if let Some(tail) = id.rsplit('-').next() {
                if let Ok(n) = tail.parse::<u64>() {
                    counter = counter.max(n);
                }
            }
        }
        store.counter = counter;
        store
    }

    pub fn counter(&self) -> u64 {
        self.counter
    }
}

/// Serialization back to the shape `orchestration.json` holds.
///
/// Two rules, both from JavaScript object semantics rather than from taste:
///
/// * an absent optional field is **omitted**, not written as `null` — the
///   TypeScript builds these objects with conditional spreads and by assigning
///   properties, so a field that was never set has no key at all;
/// * field order is *insertion* order. Fields set at creation come first, and
///   fields a later mutation adds — `closedAt`, `outcome`, `settledAt`,
///   `filesModified` — are appended after `version`, because that is where
///   assigning a new property in JavaScript puts it.
///
/// Getting either wrong produces a file the TypeScript still reads but rewrites
/// on its next save, turning every load into a spurious diff.
mod serialize {
    use super::*;
    use serde_json::{Map, Value};

    fn object(pairs: Vec<(&str, Value)>) -> Value {
        let mut map = Map::new();
        for (key, value) in pairs {
            map.insert(key.to_owned(), value);
        }
        Value::Object(map)
    }

    pub fn run(run: &Run) -> Value {
        let mut pairs = vec![
            ("id", Value::from(run.id.clone())),
            ("objective", Value::from(run.objective.clone())),
            ("coordinator", Value::from(run.coordinator.clone())),
            ("createdAt", Value::from(run.created_at)),
            ("version", Value::from(run.version)),
        ];
        if let Some(closed_at) = run.closed_at {
            pairs.push(("closedAt", Value::from(closed_at)));
        }
        object(pairs)
    }

    pub fn task(task: &OrchestrationTask) -> Value {
        let mut pairs = vec![
            ("id", Value::from(task.id.clone())),
            ("runId", Value::from(task.run_id.clone())),
            ("title", Value::from(task.title.clone())),
            ("spec", Value::from(task.spec.clone())),
            ("deps", Value::from(task.deps.clone())),
        ];
        if !task.images.is_empty() {
            pairs.push(("images", Value::from(task.images.clone())));
        }
        pairs.extend([
            ("status", Value::from(task.status.clone())),
            ("createdBy", Value::from(task.created_by.clone())),
            ("createdAt", Value::from(task.created_at)),
            ("updatedAt", Value::from(task.updated_at)),
            ("version", Value::from(task.version)),
        ]);
        if let Some(outcome) = &task.outcome {
            pairs.push(("outcome", Value::from(outcome.clone())));
        }
        object(pairs)
    }

    pub fn dispatch(dispatch: &Dispatch) -> Value {
        let mut pairs = vec![
            ("id", Value::from(dispatch.id.clone())),
            ("runId", Value::from(dispatch.run_id.clone())),
            ("taskId", Value::from(dispatch.task_id.clone())),
            ("terminalId", Value::from(dispatch.terminal_id.clone())),
            ("agent", Value::from(dispatch.agent.clone())),
            ("state", Value::from(dispatch.state.clone())),
            ("preamble", Value::from(dispatch.preamble.clone())),
            ("startedAt", Value::from(dispatch.started_at)),
            ("version", Value::from(dispatch.version)),
        ];
        if let Some(outcome) = &dispatch.outcome {
            pairs.push(("outcome", Value::from(outcome.clone())));
        }
        if let Some(settled_at) = dispatch.settled_at {
            pairs.push(("settledAt", Value::from(settled_at)));
        }
        if !dispatch.files_modified.is_empty() {
            pairs.push((
                "filesModified",
                Value::from(dispatch.files_modified.clone()),
            ));
        }
        object(pairs)
    }

    pub fn message(message: &Message) -> Value {
        let mut pairs = vec![
            ("id", Value::from(message.id.clone())),
            ("runId", Value::from(message.run_id.clone())),
            ("type", Value::from(message.message_type.clone())),
            ("from", Value::from(message.from.clone())),
            ("to", Value::from(message.to.clone())),
            ("subject", Value::from(message.subject.clone())),
            ("body", Value::from(message.body.clone())),
        ];
        if let Some(task_id) = &message.task_id {
            pairs.push(("taskId", Value::from(task_id.clone())));
        }
        if let Some(dispatch_id) = &message.dispatch_id {
            pairs.push(("dispatchId", Value::from(dispatch_id.clone())));
        }
        if let Some(outcome) = &message.outcome {
            pairs.push(("outcome", Value::from(outcome.clone())));
        }
        if let Some(reply_to) = &message.reply_to {
            pairs.push(("replyTo", Value::from(reply_to.clone())));
        }
        // Same conditional emit as the shell — these fields exist only when
        // they carry something.
        if !message.files_modified.is_empty() {
            pairs.push(("filesModified", Value::from(message.files_modified.clone())));
        }
        if !message.images.is_empty() {
            pairs.push(("images", Value::from(message.images.clone())));
        }
        if !message.options.is_empty() {
            pairs.push(("options", Value::from(message.options.clone())));
        }
        pairs.push(("createdAt", Value::from(message.created_at)));
        pairs.push(("ackedBy", Value::from(message.acked_by.clone())));
        object(pairs)
    }

    pub fn gate(gate: &Gate) -> Value {
        let mut pairs = vec![
            ("id", Value::from(gate.id.clone())),
            ("runId", Value::from(gate.run_id.clone())),
        ];
        if let Some(task_id) = &gate.task_id {
            pairs.push(("taskId", Value::from(task_id.clone())));
        }
        pairs.extend([
            ("question", Value::from(gate.question.clone())),
            ("options", Value::from(gate.options.clone())),
            ("createdBy", Value::from(gate.created_by.clone())),
            ("createdAt", Value::from(gate.created_at)),
            ("version", Value::from(gate.version)),
        ]);
        if let Some(resolution) = &gate.resolution {
            pairs.push(("resolution", Value::from(resolution.clone())));
        }
        if let Some(resolved_at) = gate.resolved_at {
            pairs.push(("resolvedAt", Value::from(resolved_at)));
        }
        object(pairs)
    }
}

pub const ORCHESTRATION_SCHEMA_VERSION: u64 = 1;

impl OrchestrationStore {
    /// The document this store would write.
    pub fn to_json(&self) -> serde_json::Value {
        let mut map = serde_json::Map::new();
        map.insert(
            "schemaVersion".into(),
            serde_json::Value::from(ORCHESTRATION_SCHEMA_VERSION),
        );
        map.insert(
            "runs".into(),
            self.runs.values().map(serialize::run).collect(),
        );
        map.insert(
            "tasks".into(),
            self.tasks.values().map(serialize::task).collect(),
        );
        map.insert(
            "dispatches".into(),
            self.dispatches.values().map(serialize::dispatch).collect(),
        );
        map.insert(
            "messages".into(),
            self.messages.values().map(serialize::message).collect(),
        );
        map.insert(
            "gates".into(),
            self.gates.values().map(serialize::gate).collect(),
        );
        serde_json::Value::Object(map)
    }
}

// Record serialization is shared with the HTTP layer: the API returns the same
// shapes that are persisted, so spelling them out twice would let the two drift.
pub fn json_for_run(run: &Run) -> serde_json::Value {
    serialize::run(run)
}
pub fn json_for_task(task: &OrchestrationTask) -> serde_json::Value {
    serialize::task(task)
}
pub fn json_for_dispatch(dispatch: &Dispatch) -> serde_json::Value {
    serialize::dispatch(dispatch)
}
pub fn json_for_message(message: &Message) -> serde_json::Value {
    serialize::message(message)
}
pub fn json_for_gate(gate: &Gate) -> serde_json::Value {
    serialize::gate(gate)
}
