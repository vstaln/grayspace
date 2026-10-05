//! `workspace-canvas-<slot>.json` — the shell's per-workspace canvas
//! snapshot. The journal is global, but each workspace keeps its own
//! folded canvas; loading is snapshot + journal tail `> snapshotSeq`,
//! so the fold cost stays bounded as the journal grows and a rotated
//! journal never loses the canvas.
//!
//! File shape matches `CanvasStore.persistSnapshotForWorkspace`:
//! `{snapshotSeq, schemaVersion, widgets[], camera, strokes, connections,
//! version}` — widget entries go through the same `sanitize_widget` the
//! journal fold uses.

use crate::projection::{self, CanvasState, Clock};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

/// `CANVAS_SCHEMA_VERSION` in canvasState.ts.
const CANVAS_SCHEMA_VERSION: u64 = 3;
/// `EMPTY_WORKSPACE_SLOT` — the slot name canvases take when no workspace
/// directory is selected.
const EMPTY_WORKSPACE_SLOT: &str = "__no-workspace__";
/// `CANVAS_SNAPSHOT_INTERVAL` — a snapshot lands every 50 folded events,
/// far inside the journal's retained tail.
pub const CANVAS_SNAPSHOT_INTERVAL: u64 = 50;

pub fn slot(dir: Option<&str>) -> String {
    match dir {
        Some(dir) if !dir.is_empty() => {
            let digest = Sha256::digest(dir.as_bytes());
            digest.iter().map(|b| format!("{b:02x}")).take(16).collect()
        }
        _ => EMPTY_WORKSPACE_SLOT.to_owned(),
    }
}

pub fn snapshot_path(dir: Option<&str>) -> PathBuf {
    crate::ipc::user_data_dir().join(format!("workspace-canvas-{}.json", slot(dir)))
}

/// The serialized canvas: identical keys to the shell's snapshot.
pub fn canvas_to_value(canvas: &CanvasState, snapshot_seq: u64) -> Value {
    let widgets: Vec<Value> = canvas
        .widgets
        .values()
        .map(projection::widget_to_value)
        .collect();
    let strokes: Vec<Value> = canvas
        .strokes
        .iter()
        .map(|stroke| {
            json!({
                "id": stroke.id,
                "points": stroke.points.iter().map(|p| json!({"x": p.x, "y": p.y})).collect::<Vec<_>>(),
                "color": stroke.color,
            })
        })
        .collect();
    let connections: Vec<Value> = canvas
        .connections
        .iter()
        .map(|c| {
            json!({
                "id": c.id,
                "from": c.from,
                "to": c.to,
                "bornAt": c.born_at,
            })
        })
        .collect();
    json!({
        "snapshotSeq": snapshot_seq,
        "schemaVersion": CANVAS_SCHEMA_VERSION,
        "widgets": widgets,
        "camera": {"x": canvas.camera.x, "y": canvas.camera.y, "zoom": canvas.camera.zoom},
        "strokes": strokes,
        "connections": connections,
        "version": canvas.version,
    })
}

/// `(canvas, snapshot_seq)` — the folded state plus the journal sequence
/// the snapshot covered. Missing/unreadable files are an empty canvas at
/// seq 0, the same boot the store performs on a fresh profile.
pub fn load(dir: Option<&str>) -> (CanvasState, u64) {
    let path = snapshot_path(dir);
    let Some(bytes) = crate::ipc::read_store_recovered(&path) else {
        return (CanvasState::default(), 0);
    };
    let Ok(raw) = serde_json::from_slice::<Value>(&bytes) else {
        return (CanvasState::default(), 0);
    };
    let snapshot_seq = raw.get("snapshotSeq").and_then(Value::as_u64).unwrap_or(0);
    let clock = Clock(raw.get("__now").and_then(Value::as_f64).unwrap_or(0.0));
    let mut canvas = CanvasState {
        camera: projection::sanitize_camera(raw.get("camera")),
        strokes: projection::sanitize_strokes(raw.get("strokes")),
        version: raw
            .get("version")
            .and_then(Value::as_f64)
            .filter(|v| *v > 0.0)
            .unwrap_or(1.0),
        ..CanvasState::default()
    };
    if let Some(entries) = raw.get("widgets").and_then(Value::as_array) {
        for entry in entries {
            if let Some(widget) = projection::sanitize_widget(entry, clock) {
                canvas.widgets.insert(widget.id.clone(), widget);
            }
            if canvas.widgets.len() >= projection::MAX_WIDGETS {
                break;
            }
        }
    }
    // Pruned after widgets load so arcs never point at missing ends — the
    // same liveConnections the store applies.
    canvas.connections = crate::projection::live_connections(
        projection::sanitize_connections(raw.get("connections"), clock),
        &canvas.widgets,
    );
    (canvas, snapshot_seq)
}

/// `persistSnapshotForWorkspace` — atomic write of the folded canvas.
pub fn write(dir: Option<&str>, canvas: &CanvasState, snapshot_seq: u64) {
    let bytes =
        crate::jsjson::to_js_json_pretty(&canvas_to_value(canvas, snapshot_seq), 2).into_bytes();
    let _ = crate::ipc::write_file_atomic(&snapshot_path(dir), &bytes);
}

/// Snapshot + journal tail: load the workspace's snapshot, then fold every
/// journal commit after `snapshotSeq`. Returns `(canvas, snapshot_seq,
/// last_seq)` so callers know both where the snapshot sat and where the
/// journal now stands.
pub fn load_with_tail(
    dir: Option<&str>,
    journal: &crate::journal_log::JournalLog,
) -> (CanvasState, u64, u64) {
    let (mut canvas, snapshot_seq) = load(dir);
    let clock = Clock(now_ms());
    let mut applied = snapshot_seq;
    for entry in journal.entries() {
        if entry.seq <= snapshot_seq {
            continue;
        }
        // Delta filter: an entry belongs to the workspace its `workspaceDir`
        // names; untagged legacy entries live in the no-workspace slot.
        if entry.workspace_dir.as_deref() != dir {
            continue;
        }
        canvas = projection::reduce(&canvas, entry, clock);
        applied = entry.seq.max(applied);
    }
    (canvas, snapshot_seq, applied.max(journal.sequence()))
}

/// The store's `eventsSinceSnapshot >= CANVAS_SNAPSHOT_INTERVAL → flush`.
/// Callers pass the journal's latest sequence; a snapshot that is already
/// within the interval is not rewritten.
pub fn maybe_snapshot(dir: Option<&str>, canvas: &CanvasState, last_seq: u64) {
    let (_, snapshot_seq) = load(dir);
    if last_seq.saturating_sub(snapshot_seq) >= CANVAS_SNAPSHOT_INTERVAL {
        write(dir, canvas, last_seq);
    }
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |elapsed| elapsed.as_millis() as f64)
}
