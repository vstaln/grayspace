//! Command errors and their codes.
//!
//! The codes are part of the wire contract, not an internal detail: the control
//! server maps each one to an HTTP status (see STATUS_BY_CODE in
//! src/main/controlServer.ts) and `orc` reports them to agents. A renamed or
//! reordered variant changes what every caller sees, so the spellings here are
//! the TypeScript spellings.

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ErrorCode {
    Conflict,
    Locked,
    Forbidden,
    NotFound,
    Invalid,
    UnknownCommand,
    UnknownActor,
    Failed,
    RateLimited,
    Backpressure,
    Cancelled,
}

impl ErrorCode {
    /// The snake_case spelling used on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::Conflict => "conflict",
            ErrorCode::Locked => "locked",
            ErrorCode::Forbidden => "forbidden",
            ErrorCode::NotFound => "not_found",
            ErrorCode::Invalid => "invalid",
            ErrorCode::UnknownCommand => "unknown_command",
            ErrorCode::UnknownActor => "unknown_actor",
            ErrorCode::Failed => "failed",
            ErrorCode::RateLimited => "rate_limited",
            ErrorCode::Backpressure => "backpressure",
            ErrorCode::Cancelled => "cancelled",
        }
    }

    /// The HTTP status the control server answers with, mirroring
    /// STATUS_BY_CODE. 499 is nginx's "client closed request"; it is what the
    /// TypeScript table uses for a cancelled command.
    pub fn http_status(self) -> u16 {
        match self {
            ErrorCode::Conflict | ErrorCode::Locked => 409,
            ErrorCode::Forbidden => 403,
            ErrorCode::NotFound => 404,
            ErrorCode::Invalid | ErrorCode::UnknownCommand => 400,
            ErrorCode::UnknownActor => 401,
            ErrorCode::Failed => 500,
            ErrorCode::RateLimited | ErrorCode::Backpressure => 429,
            ErrorCode::Cancelled => 499,
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CommandError {
    pub code: ErrorCode,
    pub message: String,
    /// Extra fields the TypeScript error carries alongside the message — the
    /// conflicting lock, the current version — merged into the JSON response.
    pub details: Option<serde_json::Value>,
}

impl CommandError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), details: None }
    }

    pub fn with_details(
        code: ErrorCode,
        message: impl Into<String>,
        details: serde_json::Value,
    ) -> Self {
        Self { code, message: message.into(), details: Some(details) }
    }
}

impl fmt::Display for CommandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for CommandError {}

pub type CommandResult<T> = Result<T, CommandError>;
