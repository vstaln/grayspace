//! Folding the command journal into the planner's item list.
//!
//! The second half of block 2. Mirrors `PlannerStore.reduce`
//! (src/main/plannerStore.ts).
//!
//! Two behaviours here are easy to get wrong and are pinned by fixtures:
//!
//! * `plan.update` normalises `day` with the *throwing* validator, not the
//!   forgiving one. A malformed day in a `plan.update` payload aborts the fold
//!   rather than being ignored — so a replay of a journal containing one fails
//!   loudly, which is the existing behaviour and not something to paper over.
//!   Item revival on load uses the forgiving variant instead.
//! * `order` is read differently by the two paths, and the difference is
//!   observable. `plan.create` uses `Number(payload.order) || 0`, which
//!   coerces, so `order: "5"` stores 5. `plan.update` uses
//!   `typeof === 'number' && Number.isFinite(...)`, which does not, so the same
//!   payload leaves the previous order untouched. Reading both as strict
//!   numbers looked right and silently lost the create case; the fixture
//!   caught it.
//!
//! `today` / `tomorrow` / `yesterday` resolve against the local calendar day, so
//! the clock is injected rather than read — a replay must not depend on when it
//! is run.

use crate::journal::JournalEntry;
use indexmap::IndexMap;
use serde_json::Value;

pub const MAX_TITLE: usize = 200;
pub const MAX_NOTE: usize = 4_000;
pub const MAX_PROJECT: usize = 80;
pub const MAX_ATTACHMENT: usize = 1_024;
pub const MAX_ATTACHMENTS: usize = 12;

#[derive(Debug, Clone, PartialEq)]
pub struct PlanItem {
    pub id: String,
    pub title: String,
    pub note: String,
    pub project: Option<String>,
    pub day: Option<String>,
    pub time: Option<String>,
    pub done: bool,
    pub created_by: String,
    pub order: f64,
    pub created_at: f64,
    pub updated_at: f64,
    pub version: f64,
    /// Absent rather than empty: the TypeScript reducer deletes the key when a
    /// patch leaves no attachments, and the persisted shape follows.
    pub attachments: Option<Vec<String>>,
}

pub type PlannerState = IndexMap<String, PlanItem>;

/// The local calendar day a replay should treat as "today", as `YYYY-MM-DD`.
#[derive(Debug, Clone)]
pub struct Today(pub String);

#[derive(Debug, PartialEq)]
pub struct InvalidDay(pub String);

fn text(value: Option<&Value>) -> Option<&str> {
    value?.as_str()
}

/// JavaScript's `Number.isFinite`: no coercion, so a numeric string is not a
/// number. This is what `plan.update` uses.
fn strict_number(value: Option<&Value>) -> Option<f64> {
    let n = value?.as_f64()?;
    if n.is_finite() {
        Some(n)
    } else {
        None
    }
}

/// JavaScript's `Number(value) || 0`, which is what `plan.create` uses instead.
///
/// The two paths genuinely differ: `plan.create` coerces, so `order: "5"`
/// stores 5, while the same payload through `plan.update` is not a number and
/// leaves the previous order alone. The `|| 0` tail then collapses both NaN and
/// zero to 0, so anything non-finite lands on 0 without a separate check.
fn coerced_number(value: Option<&Value>) -> f64 {
    let coerced = match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(true)) => 1.0,
        Some(Value::Bool(false)) => 0.0,
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                0.0
            } else {
                trimmed.parse::<f64>().unwrap_or(f64::NAN)
            }
        }
        // Number([]) is 0 and Number([x]) coerces x; anything else is NaN.
        Some(Value::Array(items)) => match items.len() {
            0 => 0.0,
            1 => coerced_number(items.first()),
            _ => f64::NAN,
        },
        Some(Value::Object(_)) => f64::NAN,
    };
    if coerced.is_finite() {
        coerced
    } else {
        0.0
    }
}

fn shift_day(key: &str, delta: i64) -> String {
    // Civil-date arithmetic on a proleptic Gregorian calendar, matching what
    // `new Date(y, m - 1, d + delta)` does for the one-day shifts used here.
    let parts: Vec<i64> = key.split('-').filter_map(|p| p.parse().ok()).collect();
    if parts.len() != 3 {
        return key.to_owned();
    }
    let (y, m, d) = (parts[0], parts[1], parts[2]);
    let days = days_from_civil(y, m, d) + delta;
    let (y2, m2, d2) = civil_from_days(days);
    format!("{y2:04}-{m2:02}-{d2:02}")
}

/// Howard Hinnant's days_from_civil.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = (mp + 2) % 12 + 1;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// The throwing validator, as used by `plan.update`.
pub fn normalize_day(value: Option<&Value>, today: &Today) -> Result<Option<String>, InvalidDay> {
    match value {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::String(_)) => {}
        Some(_) => return Err(InvalidDay("day must be YYYY-MM-DD".into())),
    }
    let raw = value.unwrap().as_str().unwrap().trim();
    if raw.is_empty() {
        return Ok(None);
    }
    match raw.to_lowercase().as_str() {
        "today" => return Ok(Some(today.0.clone())),
        "tomorrow" => return Ok(Some(shift_day(&today.0, 1))),
        "yesterday" => return Ok(Some(shift_day(&today.0, -1))),
        _ => {}
    }

    let parts: Vec<&str> = raw.split('-').collect();
    let valid_shape = parts.len() == 3
        && parts[0].len() == 4
        && (1..=2).contains(&parts[1].len())
        && (1..=2).contains(&parts[2].len())
        && parts.iter().all(|p| p.chars().all(|c| c.is_ascii_digit()) && !p.is_empty());
    if !valid_shape {
        return Err(InvalidDay(format!("day \"{raw}\" is not YYYY-MM-DD")));
    }
    let (year, month, day) = (
        parts[0].parse::<i64>().unwrap(),
        parts[1].parse::<i64>().unwrap(),
        parts[2].parse::<i64>().unwrap(),
    );
    // JavaScript's `new Date(y, m - 1, d)` rolls an out-of-range component over
    // into the next month or year; the TypeScript check then notices the
    // round trip changed and rejects it. Checking the range directly is the
    // same answer without building a date.
    let (ry, rm, rd) = civil_from_days(days_from_civil(year, month, day));
    if (ry, rm, rd) != (year, month, day) {
        return Err(InvalidDay(format!("day \"{raw}\" is not a real date")));
    }
    Ok(Some(format!("{year}-{month:02}-{day:02}")))
}

/// The forgiving variant used when reviving a stored item.
fn safe_day(value: Option<&Value>, today: &Today) -> Option<String> {
    normalize_day(value, today).unwrap_or(None)
}

pub fn normalize_time(value: Option<&Value>) -> Option<String> {
    let raw = text(value)?;
    let bytes = raw.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' {
        return None;
    }
    if !raw[0..2].chars().all(|c| c.is_ascii_digit()) || !raw[3..5].chars().all(|c| c.is_ascii_digit())
    {
        return None;
    }
    let hours: u32 = raw[0..2].parse().ok()?;
    let minutes: u32 = raw[3..5].parse().ok()?;
    if hours < 24 && minutes < 60 {
        Some(raw.to_owned())
    } else {
        None
    }
}

pub fn normalize_project(value: Option<&Value>) -> Option<String> {
    let raw = text(value)?;
    let trimmed: String = raw.trim().chars().take(MAX_PROJECT).collect();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

pub fn normalize_attachments(value: Option<&Value>) -> Option<Vec<String>> {
    let entries = match value {
        None | Some(Value::Null) => return None,
        Some(Value::Array(entries)) => entries,
        Some(_) => return None,
    };
    let mut out = Vec::new();
    for entry in entries {
        let Some(raw) = entry.as_str() else { continue };
        let trimmed = raw.trim();
        if trimmed.is_empty() || trimmed.chars().count() > MAX_ATTACHMENT {
            continue;
        }
        out.push(trimmed.to_owned());
        if out.len() >= MAX_ATTACHMENTS {
            break;
        }
    }
    Some(out)
}

fn truncate(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

/// One journal entry applied to the planner. Mirrors `PlannerStore.reduce`.
///
/// Returns `Err` when a `plan.update` carries a malformed day, which is what
/// the TypeScript reducer does by throwing.
pub fn reduce(
    state: &PlannerState,
    event: &JournalEntry,
    today: &Today,
) -> Result<PlannerState, InvalidDay> {
    if event.phase != "commit" {
        return Ok(state.clone());
    }

    let mut next = state.clone();
    let empty = Value::Object(Default::default());
    let payload = event.payload.as_ref().unwrap_or(&empty);
    let object = payload.as_object();
    let get = |key: &str| object.and_then(|o| o.get(key));

    let target_id = event
        .target
        .strip_prefix("plan:")
        .unwrap_or(&event.target)
        .to_owned();

    match event.entry_type.as_str() {
        "plan.create" => {
            let id = if target_id == "new" {
                text(get("id"))
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("plan-{}-{}", event.at, event.seq))
            } else {
                target_id
            };
            let title = text(get("title")).map(str::trim).unwrap_or("").to_owned();
            // revive() drops an item with no id or no title.
            if id.is_empty() || title.is_empty() {
                return Ok(next);
            }
            let attachments = normalize_attachments(get("attachments"));
            let item = PlanItem {
                id: id.clone(),
                title,
                note: text(get("note")).unwrap_or("").to_owned(),
                project: normalize_project(get("project")),
                day: safe_day(get("day"), today),
                time: normalize_time(get("time")),
                done: false,
                created_by: event.actor_id.clone(),
                order: coerced_number(get("order")),
                created_at: event.at as f64,
                updated_at: event.at as f64,
                version: event.version.map(|v| v as f64).unwrap_or(1.0),
                attachments: attachments.filter(|a| !a.is_empty()),
            };
            next.insert(id, item);
        }
        "plan.update" => {
            if let Some(existing) = next.get(&target_id).cloned() {
                let mut updated = existing.clone();

                if let Some(title) = text(get("title")) {
                    if !title.trim().is_empty() {
                        updated.title = truncate(title.trim(), MAX_TITLE);
                    }
                }
                if let Some(note) = text(get("note")) {
                    updated.note = truncate(note, MAX_NOTE);
                }
                if let Some(project) = get("project") {
                    updated.project = if project.is_null() {
                        None
                    } else {
                        normalize_project(Some(project))
                    };
                }
                if let Some(day) = get("day") {
                    updated.day = if day.is_null() {
                        None
                    } else {
                        // The throwing validator: a malformed day aborts the
                        // fold rather than being quietly dropped.
                        normalize_day(Some(day), today)?
                    };
                }
                if let Some(time) = get("time") {
                    updated.time = if time.is_null() {
                        None
                    } else {
                        normalize_time(Some(time))
                    };
                }
                if let Some(Value::Bool(done)) = get("done") {
                    updated.done = *done;
                }
                if let Some(order) = strict_number(get("order")) {
                    updated.order = order;
                }
                if get("attachments").is_some() {
                    updated.attachments = normalize_attachments(get("attachments"));
                }
                updated.updated_at = event.at as f64;
                updated.version = event
                    .version
                    .map(|v| v as f64)
                    .unwrap_or(existing.version + 1.0);

                // An empty list is dropped entirely, not stored as [].
                if updated.attachments.as_ref().is_some_and(Vec::is_empty) {
                    updated.attachments = None;
                }
                next.insert(target_id, updated);
            }
        }
        "plan.toggle" => {
            if let Some(existing) = next.get(&target_id).cloned() {
                let done = match get("done") {
                    Some(Value::Bool(done)) => *done,
                    _ => !existing.done,
                };
                let mut updated = existing.clone();
                updated.done = done;
                updated.updated_at = event.at as f64;
                updated.version = event
                    .version
                    .map(|v| v as f64)
                    .unwrap_or(existing.version + 1.0);
                next.insert(target_id, updated);
            }
        }
        "plan.delete" => {
            next.shift_remove(&target_id);
        }
        _ => {}
    }

    Ok(next)
}

pub fn fold<'a>(
    events: impl IntoIterator<Item = &'a JournalEntry>,
    initial: PlannerState,
    today: &Today,
) -> Result<PlannerState, InvalidDay> {
    let mut state = initial;
    for event in events {
        state = reduce(&state, event, today)?;
    }
    Ok(state)
}
