//! The command bus.
//!
//! Mirrors the `apply` path of `CommandFlow` in src/main/core/flow.ts: prepare,
//! actor check, lock gate, version gate, intent entry, handler, commit entry.
//! A rejection after the intent was written appends an `abort` entry, so the
//! journal records that the command was attempted and refused rather than
//! leaving a dangling intent.
//!
//! The order of the gates is the contract, not an implementation detail. A
//! command that is both locked by someone else and carries a stale
//! `baseVersion` must report `locked`, because that is the answer the
//! TypeScript gives, and an agent's retry logic keys on the code.
//!
//! Handlers are synchronous here. The TypeScript ones are async because they
//! touch the filesystem through Electron; the migrated stores do their own I/O
//! outside the bus, so nothing in this port needs to await mid-command. The
//! queue, rate limiter and speculative overlays of the TypeScript flow are not
//! ported yet — see docs/RUST-MIGRATION.md.

use crate::actors::ActorRegistry;
use crate::command::{CommandError, CommandResult, ErrorCode};
use crate::journal::JournalEntry;
use crate::locks::{AcquireInput, LockManager};
use crate::resources::{file_resource, parse_resource};
use crate::schema::{validate_payload, CommandPayloadSchema};
use crate::versioned::VersionRegistry;
use indexmap::IndexMap;
use serde_json::{json, Value};

/// What a caller submits.
#[derive(Debug, Clone)]
pub struct Command {
    pub id: Option<String>,
    pub actor_id: String,
    pub command_type: String,
    pub target: String,
    pub payload: Value,
    /// The version the caller believes the target is at. A mismatch is a
    /// conflict — this is what stops a stale reader overwriting a newer write.
    pub base_version: Option<u64>,
}

pub struct HandlerContext<'a> {
    pub command: &'a Command,
    pub current_version: u64,
}

pub type Handler = Box<dyn Fn(&HandlerContext<'_>) -> CommandResult<Value>>;

pub struct CommandDefinition {
    pub command_type: String,
    pub payload_schema: Option<CommandPayloadSchema>,
    /// Default true. When false the bus neither checks nor takes a lock.
    pub requires_lock: bool,
    /// Skips the version gate entirely — for commands whose target has no
    /// meaningful version, like a refresh.
    pub ignore_version: bool,
    /// Not journalled: a transient command answers without leaving intent or
    /// commit entries behind. Used for reads and polls that would otherwise
    /// swamp the log.
    pub transient: bool,
    pub handler: Handler,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Accepted {
    pub seq: u64,
    pub version: u64,
    pub data: Value,
    pub command_id: Option<String>,
}

pub struct Outcome {
    pub result: Result<Accepted, CommandError>,
}

/// Minimal in-memory journal: assigns sequence numbers and records entries.
/// Hash chaining lives in `journal.rs`; this is the append side the bus uses.
#[derive(Default)]
pub struct FlowJournal {
    pub entries: Vec<JournalEntry>,
    last_seq: u64,
}

impl FlowJournal {
    pub fn new(start_seq: u64) -> Self {
        Self { entries: Vec::new(), last_seq: start_seq }
    }

    pub fn last_seq(&self) -> u64 {
        self.last_seq
    }

    fn append(
        &mut self,
        phase: &str,
        actor_id: &str,
        command_type: &str,
        target: &str,
        payload: Option<Value>,
        version: Option<i64>,
        error: Option<String>,
        at: i64,
    ) -> u64 {
        self.last_seq += 1;
        self.entries.push(JournalEntry {
            seq: self.last_seq,
            at: at.max(0) as u64,
            phase: phase.to_owned(),
            actor_id: actor_id.to_owned(),
            entry_type: command_type.to_owned(),
            target: target.to_owned(),
            payload,
            version,
            error,
            prev_hash: None,
            hash: None,
        });
        self.last_seq
    }
}

pub struct CommandFlow {
    definitions: IndexMap<String, CommandDefinition>,
    pub actors: ActorRegistry,
    pub locks: LockManager,
    pub journal: FlowJournal,
    pub versions: VersionRegistry,
}

impl CommandFlow {
    pub fn new(versions_scheme: &str, start_seq: u64) -> Self {
        Self {
            definitions: IndexMap::new(),
            actors: ActorRegistry::new(),
            locks: LockManager::new(None),
            journal: FlowJournal::new(start_seq),
            versions: VersionRegistry::new(versions_scheme),
        }
    }

    pub fn register(&mut self, definition: CommandDefinition) {
        self.definitions
            .insert(definition.command_type.clone(), definition);
    }

    pub fn types(&self) -> Vec<String> {
        self.definitions.keys().cloned().collect()
    }

    /// Runs one command to completion.
    ///
    /// Gate order, which callers depend on: unknown command, payload shape,
    /// malformed target, unknown actor, lock held by someone else, stale
    /// baseVersion, then the handler.
    pub fn submit(&mut self, command: Command, now: i64) -> Outcome {
        let mut implicit_lock: Option<String> = None;
        let mut intent_written = false;
        let mut command = command;

        let result = (|| -> CommandResult<Accepted> {
            // --- prepare ---------------------------------------------------
            let Some(definition) = self.definitions.get(&command.command_type) else {
                return Err(CommandError::new(
                    ErrorCode::UnknownCommand,
                    format!("no handler for {}", command.command_type),
                ));
            };
            let requires_lock = definition.requires_lock;
            let ignore_version = definition.ignore_version;
            let transient = definition.transient;

            if let Some(schema) = &definition.payload_schema {
                if let Some(message) = validate_payload(schema, &command.payload) {
                    return Err(CommandError::new(
                        ErrorCode::Invalid,
                        format!(
                            "invalid payload for {}: {message}",
                            command.command_type
                        ),
                    ));
                }
            }

            let Some(parsed) = parse_resource(&command.target) else {
                return Err(CommandError::new(
                    ErrorCode::Invalid,
                    format!(
                        "\"{}\" is not a resource id (expected scheme:id)",
                        command.target
                    ),
                ));
            };
            // A file target is normalised so two callers spelling the same path
            // differently contend for the same lock.
            if parsed.scheme == "file" {
                command.target = file_resource(&parsed.id);
            }

            let actor = self.actors.require(&command.actor_id)?;
            self.actors.touch(&actor.id, now);

            // --- lock gate -------------------------------------------------
            if requires_lock {
                if self
                    .locks
                    .is_locked_by_other(&command.target, &command.actor_id, now)
                {
                    let held = self.locks.holder(&command.target, now);
                    let holder = held
                        .as_ref()
                        .map(|lock| lock.actor_id.clone())
                        .unwrap_or_default();
                    return Err(CommandError::with_details(
                        ErrorCode::Locked,
                        format!("{} is locked by {holder}", command.target),
                        json!({ "lock": held.map(|lock| json!({
                            "resource": lock.resource,
                            "actorId": lock.actor_id,
                            "expiresAt": lock.expires_at,
                        })) }),
                    ));
                }
                if !transient {
                    self.locks.acquire(
                        AcquireInput {
                            resource: &command.target,
                            actor_id: &command.actor_id,
                            ttl_ms: None,
                            reason: Some(command.command_type.clone()),
                            implicit: true,
                        },
                        now,
                    )?;
                    implicit_lock = Some(command.target.clone());
                }
            }

            // --- version gate ----------------------------------------------
            let current_version = self.versions.version_of(&command.target, None).unwrap_or(0);
            if !ignore_version {
                if let Some(base) = command.base_version {
                    if base != current_version {
                        return Err(CommandError::with_details(
                            ErrorCode::Conflict,
                            format!(
                                "{} moved on: expected version {base}, found {current_version}",
                                command.target
                            ),
                            json!({
                                "target": command.target,
                                "expected": base,
                                "actual": current_version,
                            }),
                        ));
                    }
                }
            }

            // --- intent ----------------------------------------------------
            if !transient {
                self.journal.append(
                    "intent",
                    &actor.id,
                    &command.command_type,
                    &command.target,
                    Some(command.payload.clone()),
                    None,
                    None,
                    now,
                );
                intent_written = true;
            }

            // --- handler ---------------------------------------------------
            let definition = self
                .definitions
                .get(&command.command_type)
                .expect("looked up above");
            let data = (definition.handler)(&HandlerContext {
                command: &command,
                current_version,
            })?;

            // The handler may have bumped the version itself; if it did not,
            // accepting a write advances it.
            let version = match self.versions.version_of(&command.target, None) {
                Some(version) if version > current_version => version,
                _ => {
                    let id = parse_resource(&command.target)
                        .map(|parsed| parsed.id)
                        .unwrap_or_else(|| command.target.clone());
                    self.versions.bump(&id, None)
                }
            };

            // --- commit ----------------------------------------------------
            let seq = if transient {
                self.journal.last_seq()
            } else {
                self.journal.append(
                    "commit",
                    &actor.id,
                    &command.command_type,
                    &command.target,
                    Some(command.payload.clone()),
                    Some(version as i64),
                    None,
                    now,
                )
            };

            Ok(Accepted { seq, version, data, command_id: command.id.clone() })
        })();

        if let Err(error) = &result {
            if intent_written {
                self.journal.append(
                    "abort",
                    &command.actor_id,
                    &command.command_type,
                    &command.target,
                    None,
                    None,
                    Some(error.message.clone()),
                    now,
                );
            }
        }

        // The implicit lock is released whichever way the command went: it was
        // taken for the duration of this command and nothing else.
        if let Some(resource) = implicit_lock {
            let _ = self.locks.release(&resource, &command.actor_id, now);
        }

        Outcome { result }
    }
}

impl CommandDefinition {
    /// A definition with the defaults the TypeScript uses when a field is
    /// omitted: locks required, version enforced, journalled.
    pub fn new(command_type: &str, handler: Handler) -> Self {
        Self {
            command_type: command_type.to_owned(),
            payload_schema: None,
            requires_lock: true,
            ignore_version: false,
            transient: false,
            handler,
        }
    }

    pub fn schema(mut self, schema: CommandPayloadSchema) -> Self {
        self.payload_schema = Some(schema);
        self
    }

    pub fn without_lock(mut self) -> Self {
        self.requires_lock = false;
        self
    }

    pub fn ignoring_version(mut self) -> Self {
        self.ignore_version = true;
        self
    }

    pub fn transient(mut self) -> Self {
        self.transient = true;
        self
    }
}
