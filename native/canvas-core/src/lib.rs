use napi::bindgen_prelude::Result;
use napi_derive::napi;
use serde_json::{Map, Value};

const MAX_POINTS_PER_STROKE: usize = 10_000;
const MAX_TOTAL_POINTS: usize = 200_000;

fn point_is_canonical(obj: &Map<String, Value>) -> bool {
    obj.len() == 2
        && obj.get("x").and_then(Value::as_f64).is_some()
        && obj.get("y").and_then(Value::as_f64).is_some()
}

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
