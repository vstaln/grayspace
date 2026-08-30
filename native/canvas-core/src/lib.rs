use napi::bindgen_prelude::Result;
use napi_derive::napi;
use serde_json::{Map, Value};

const MAX_POINTS_PER_STROKE: usize = 10_000;
const MAX_TOTAL_POINTS: usize = 200_000;

/// True when the object is already exactly `{x, y}` with two finite numbers —
/// the shape the sanitizer promises to emit. Such a point can be moved into the
/// output untouched instead of being rebuilt, which is what keeps a 200k-point
/// canvas from allocating 200k fresh maps (and 400k key strings) per save.
fn point_is_canonical(obj: &Map<String, Value>) -> bool {
    obj.len() == 2
        && obj.get("x").and_then(Value::as_f64).is_some()
        && obj.get("y").and_then(Value::as_f64).is_some()
}

/// Sanitizes the JSON-shaped canvas strokes without changing their public shape.
/// Invalid entries/points are discarded; valid strokes need at least two points.
///
/// The input `Value` is consumed rather than borrowed, so every already-valid
/// point and stroke map is *moved* into the result. The previous version read
/// each point through `as_f64` and then rebuilt it with `json!({"x": x, "y": y})`,
/// allocating a fresh `serde_json::Map` plus two owned key strings for every
/// point on the canvas — on a full canvas that is 200k map allocations on every
/// autosave, on the main process's thread. Points that are not already the
/// canonical `{x, y}` shape (extra keys, integers, a stray `pressure` field)
/// still get rebuilt, so the output shape is byte-for-byte what it always was.
#[napi]
pub fn sanitize_strokes(value: Value) -> Result<Value> {
    let Value::Array(entries) = value else {
        return Ok(Value::Array(Vec::new()));
    };

    let mut strokes = Vec::with_capacity(entries.len());
    let mut total_points = 0usize;

    for entry in entries {
        let Value::Object(mut stroke) = entry else {
            continue;
        };
        // `id` and `color` must be strings; `points` an array. Checked without
        // cloning the strings — they are moved with the map further down.
        if !matches!(stroke.get("id"), Some(Value::String(_))) {
            continue;
        }
        if !matches!(stroke.get("color"), Some(Value::String(_))) {
            continue;
        }
        let Some(Value::Array(raw_points)) = stroke.remove("points") else {
            continue;
        };

        let mut points: Vec<Value> = Vec::with_capacity(raw_points.len().min(MAX_POINTS_PER_STROKE));
        for point in raw_points {
            let Value::Object(obj) = point else {
                continue;
            };
            if point_is_canonical(&obj) {
                points.push(Value::Object(obj));
            } else {
                // serde_json cannot represent NaN/Infinity, so every decoded
                // number is finite just as the TypeScript isNum guard requires.
                let (Some(x), Some(y)) = (
                    obj.get("x").and_then(Value::as_f64),
                    obj.get("y").and_then(Value::as_f64),
                ) else {
                    continue;
                };
                points.push(serde_json::json!({ "x": x, "y": y }));
            }
            if points.len() >= MAX_POINTS_PER_STROKE {
                break;
            }
        }

        if points.len() < 2 {
            continue;
        }
        total_points += points.len();

        // Reuse the incoming map when it carried nothing but the three public
        // fields (`points` was removed above, so two keys remain). Anything
        // else — a stale field from an older schema, an agent-supplied extra —
        // is dropped by rebuilding, exactly as before.
        if stroke.len() == 2 {
            stroke.insert("points".to_string(), Value::Array(points));
            strokes.push(Value::Object(stroke));
        } else {
            let id = stroke.remove("id").unwrap_or(Value::Null);
            let color = stroke.remove("color").unwrap_or(Value::Null);
            let mut clean = Map::with_capacity(3);
            clean.insert("id".to_string(), id);
            clean.insert("points".to_string(), Value::Array(points));
            clean.insert("color".to_string(), color);
            strokes.push(Value::Object(clean));
        }

        if total_points >= MAX_TOTAL_POINTS {
            break;
        }
    }

    Ok(Value::Array(strokes))
}
