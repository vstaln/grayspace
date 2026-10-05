//! Who is allowed to submit commands.
//!
//! Mirrors src/main/core/actors.ts. Registration is the admission gate: a
//! command from an id nobody registered is refused as `unknown_actor` rather
//! than run anonymously, which is what ties a journal entry to a caller.

use crate::command::{CommandError, CommandResult, ErrorCode};
use indexmap::IndexMap;
use serde_json::json;

pub const ACTOR_TTL_MS: i64 = 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActorType {
    User,
    Assistant,
    Agent,
    System,
}

impl ActorType {
    pub fn as_str(self) -> &'static str {
        match self {
            ActorType::User => "user",
            ActorType::Assistant => "assistant",
            ActorType::Agent => "agent",
            ActorType::System => "system",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Actor {
    pub id: String,
    pub actor_type: ActorType,
    pub label: String,
    pub transport: String,
    pub registered_at: i64,
    pub last_seen_at: i64,
}

#[derive(Default)]
pub struct ActorRegistry {
    actors: IndexMap<String, Actor>,
}

impl ActorRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Re-registering an existing id refreshes it instead of replacing it: the
    /// original `registeredAt` is what tells you how long an agent has been
    /// around, and a reconnect should not reset it.
    pub fn register(
        &mut self,
        id: &str,
        actor_type: ActorType,
        label: Option<&str>,
        transport: &str,
        now: i64,
    ) -> CommandResult<Actor> {
        let id = id.trim();
        if id.is_empty() {
            return Err(CommandError::new(ErrorCode::Invalid, "actorId is required"));
        }
        if let Some(existing) = self.actors.get_mut(id) {
            existing.last_seen_at = now;
            if let Some(label) = label.filter(|l| !l.is_empty()) {
                existing.label = label.to_owned();
            }
            return Ok(existing.clone());
        }
        let actor = Actor {
            id: id.to_owned(),
            actor_type,
            label: label
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .unwrap_or(id)
                .to_owned(),
            transport: transport.to_owned(),
            registered_at: now,
            last_seen_at: now,
        };
        self.actors.insert(id.to_owned(), actor.clone());
        Ok(actor)
    }

    pub fn get(&self, id: &str) -> Option<&Actor> {
        self.actors.get(id)
    }

    pub fn require(&self, id: &str) -> CommandResult<Actor> {
        self.actors.get(id).cloned().ok_or_else(|| {
            CommandError::with_details(
                ErrorCode::UnknownActor,
                format!(
                    "actor {} is not registered",
                    if id.is_empty() { "<empty>" } else { id }
                ),
                json!({ "actorId": id }),
            )
        })
    }

    pub fn touch(&mut self, id: &str, now: i64) {
        if let Some(actor) = self.actors.get_mut(id) {
            actor.last_seen_at = now;
        }
    }

    pub fn is_alive(&self, id: &str, ttl_ms: i64, now: i64) -> bool {
        self.actors
            .get(id)
            .is_some_and(|actor| now - actor.last_seen_at <= ttl_ms)
    }

    pub fn forget(&mut self, id: &str) {
        self.actors.shift_remove(id);
    }

    /// Sweeps agents that have stopped checking in. `user` and `system` are
    /// never swept — the person at the keyboard does not heartbeat, and the app
    /// itself must still be able to act after an idle spell.
    pub fn prune_dead(&mut self, ttl_ms: i64, now: i64) -> Vec<Actor> {
        let cutoff = now - ttl_ms;
        let dead: Vec<Actor> = self
            .actors
            .values()
            .filter(|actor| {
                !matches!(actor.actor_type, ActorType::User | ActorType::System)
                    && actor.last_seen_at < cutoff
            })
            .cloned()
            .collect();
        for actor in &dead {
            self.actors.shift_remove(&actor.id);
        }
        dead
    }

    pub fn list(&self) -> Vec<Actor> {
        self.actors.values().cloned().collect()
    }
}
