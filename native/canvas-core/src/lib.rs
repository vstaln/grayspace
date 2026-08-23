use napi::bindgen_prelude::Result;
use napi_derive::napi;
use serde_json::Value;

const MAX_POINTS_PER_STROKE: usize = 10_000;
const MAX_TOTAL_POINTS: usize = 200_000;

/// Sanitizes the JSON-shaped canvas strokes without changing their public shape.
/// Invalid entries/points are discarded; valid strokes need at least two points.
#[napi]
pub fn sanitize_strokes(value: Value) -> Result<Value> {
    let Some(entries) = value.as_array() else {
        return Ok(Value::Array(Vec::new()));
    };

    let mut strokes = Vec::new();
    let mut total_points = 0usize;

    for entry in entries {
        let Some(stroke) = entry.as_object() else {
            continue;
        };
        let (Some(id), Some(color), Some(raw_points)) = (
            stroke.get("id").and_then(Value::as_str),
            stroke.get("color").and_then(Value::as_str),
            stroke.get("points").and_then(Value::as_array),
        ) else {
            continue;
        };

        let mut points = Vec::new();
        for point in raw_points {
            let Some(point) = point.as_object() else {
                continue;
            };
            let (Some(x), Some(y)) = (
                point.get("x").and_then(Value::as_f64),
                point.get("y").and_then(Value::as_f64),
            ) else {
                continue;
            };
            // serde_json cannot represent NaN/Infinity, so every decoded number
            // is finite just as the TypeScript isNum guard requires.
            points.push(serde_json::json!({ "x": x, "y": y }));
            if points.len() >= MAX_POINTS_PER_STROKE {
                break;
            }
        }

        if points.len() < 2 {
            continue;
        }
        strokes.push(serde_json::json!({ "id": id, "points": points, "color": color }));
        total_points += points.len();
        if total_points >= MAX_TOTAL_POINTS {
            break;
        }
    }

    Ok(Value::Array(strokes))
}
