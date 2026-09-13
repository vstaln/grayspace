//! Shared library half of the native app.
//!
//! Modules land here as they are migrated, so they can be covered by
//! integration tests and reused by both binaries. The eframe UI and the engine
//! still live in the binary targets.

pub mod journal;
pub mod jsjson;
pub mod planner;
pub mod projection;
pub mod state;
