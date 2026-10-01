//! Shared library half of the native app.
//!
//! Modules land here as they are migrated, so they can be covered by
//! integration tests and reused by both binaries. The eframe UI and the engine
//! still live in the binary targets.

pub mod actors;
pub mod attachments;
pub mod canvas;
pub mod cli;
pub mod code_layout;
pub mod command;
pub mod conpty_startup;
pub mod flow;
pub mod http;
pub mod idempotency;
pub mod ipc;
pub mod journal;
pub mod journal_log;
pub mod jsjson;
pub mod listener;
pub mod locks;
pub mod orchestration;
pub mod planner;
pub mod planner_document;
pub mod projection;
pub mod queue;
pub mod resources;
pub mod schema;
pub mod state;
pub mod terminal_names;
pub mod terminal_protocol;
pub mod terminal_screen;
pub mod theme;
pub mod ui_preferences;
pub mod versioned;

pub mod platform;
