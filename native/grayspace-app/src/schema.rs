//! Command payload validation.
//!
//! Mirrors src/main/core/schema.ts. The returned string is not a log line — it
//! becomes the `invalid` command error's message, which reaches agents through
//! `grayspace` and the control server. Both the wording and the *order* of the checks
//! are therefore observable: a payload that breaks two rules must report the
//! same one the TypeScript reports.
//!
//! Order: shape, then required fields in schema order, then unexpected fields in
//! payload order, then each property in schema order with `enum` ahead of type.

use indexmap::IndexMap;
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldType {
    String,
    Number,
    Boolean,
    Array,
    Object,
    Any,
}

#[derive(Debug, Clone, Default)]
pub struct FieldSchema {
    pub field_type: Option<FieldType>,
    pub enum_values: Option<Vec<Value>>,
}

impl FieldSchema {
    pub fn of(field_type: FieldType) -> Self {
        Self {
            field_type: Some(field_type),
            enum_values: None,
        }
    }

    pub fn with_enum(mut self, values: Vec<Value>) -> Self {
        self.enum_values = Some(values);
        self
    }
}

#[derive(Debug, Clone, Default)]
pub struct CommandPayloadSchema {
    /// Insertion-ordered: the first failing property decides the message.
    pub properties: IndexMap<String, FieldSchema>,
    pub required: Vec<String>,
    pub additional_properties: Option<bool>,
}

/// Renders an enum list the way `Array.prototype.join(', ')` does — strings
/// bare, not quoted, since that is what the TypeScript message shows.
fn join_enum(values: &[Value]) -> String {
    values
        .iter()
        .map(|value| match value {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// `None` when the payload is acceptable, otherwise the message.
pub fn validate_payload(schema: &CommandPayloadSchema, payload: &Value) -> Option<String> {
    let Some(object) = payload.as_object() else {
        return Some("payload must be a JSON object".to_owned());
    };

    // `undefined || null` in the TypeScript: a field present but null counts as
    // missing, not as a supplied null.
    for required in &schema.required {
        match object.get(required) {
            None | Some(Value::Null) => {
                return Some(format!("missing required field \"{required}\""))
            }
            Some(_) => {}
        }
    }

    if schema.additional_properties == Some(false) {
        for key in object.keys() {
            if !schema.properties.contains_key(key) {
                return Some(format!("unexpected field \"{key}\""));
            }
        }
    }

    for (key, field) in &schema.properties {
        let value = match object.get(key) {
            None | Some(Value::Null) => continue,
            Some(value) => value,
        };

        if let Some(allowed) = &field.enum_values {
            if !allowed.contains(value) {
                return Some(format!(
                    "field \"{key}\" must be one of [{}]",
                    join_enum(allowed)
                ));
            }
        }

        let ok = match field.field_type {
            Some(FieldType::String) => value.is_string(),
            // Finite: JSON cannot carry NaN or an infinity, but a number that
            // arrived as one through another path must still be refused.
            Some(FieldType::Number) => value.as_f64().is_some_and(f64::is_finite),
            Some(FieldType::Boolean) => value.is_boolean(),
            Some(FieldType::Array) => value.is_array(),
            Some(FieldType::Object) => value.is_object(),
            Some(FieldType::Any) | None => true,
        };
        if !ok {
            let expected = match field.field_type {
                Some(FieldType::String) => "a string",
                Some(FieldType::Number) => "a finite number",
                Some(FieldType::Boolean) => "a boolean",
                Some(FieldType::Array) => "an array",
                Some(FieldType::Object) => "an object",
                _ => unreachable!("only the checked types can fail"),
            };
            return Some(format!("field \"{key}\" must be {expected}"));
        }
    }

    None
}
