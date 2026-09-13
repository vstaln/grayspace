//! Shared library half of the native app.
//!
//! Modules land here as they are migrated, so they can be covered by
//! integration tests and reused by both binaries. The eframe UI and the engine
//! still live in the binary targets.

pub mod actors;
pub mod cli;
pub mod command;
pub mod flow;
pub mod http;
pub mod idempotency;
pub mod ipc;
pub mod journal;
pub mod jsjson;
pub mod listener;
pub mod locks;
pub mod orchestration;
pub mod planner;
pub mod projection;
pub mod queue;
pub mod resources;
pub mod schema;
pub mod state;
pub mod versioned;
