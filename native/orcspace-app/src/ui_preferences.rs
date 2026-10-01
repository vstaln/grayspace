use crate::code_layout::CodeLayout;
use serde::{Deserialize, Serialize};
use std::{io::Write, path::Path};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct UiPreferences {
    pub sidebar_open: bool,
    pub auto_names: bool,
    pub layout: CodeLayout,
    pub three_way_split: [f32; 2],
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl Default for UiPreferences {
    fn default() -> Self {
        Self {
            sidebar_open: true,
            auto_names: true,
            layout: CodeLayout::Auto,
            three_way_split: [0.5, 0.5],
            extra: Default::default(),
        }
    }
}

impl UiPreferences {
    pub fn load(path: &Path) -> Result<Self, String> {
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self::default())
            }
            Err(error) => return Err(error.to_string()),
        };
        let mut value: Self = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        for ratio in &mut value.three_way_split {
            *ratio = ratio.clamp(0.2, 0.8);
        }
        Ok(value)
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        let parent = path.parent().ok_or("Settings path has no parent")?;
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let temporary = parent.join(format!(".native-ui-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| -> Result<(), String> {
            let bytes = serde_json::to_vec_pretty(self).map_err(|error| error.to_string())?;
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|error| error.to_string())?;
            file.write_all(&bytes)
                .and_then(|()| file.sync_all())
                .map_err(|error| error.to_string())?;
            drop(file);
            std::fs::rename(&temporary, path).map_err(|error| error.to_string())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preferences_replace_atomically_and_keep_unknown_fields() {
        let dir = std::env::temp_dir().join(format!("orc-ui-{}", uuid::Uuid::new_v4()));
        let path = dir.join("native-ui.json");
        let mut preferences = UiPreferences::load(&path).unwrap();
        preferences
            .extra
            .insert("futureSetting".into(), serde_json::json!({"enabled": true}));
        preferences.save(&path).unwrap();
        preferences.layout = CodeLayout::Focus;
        preferences.three_way_split = [0.3, 0.7];
        preferences.save(&path).unwrap();
        assert_eq!(UiPreferences::load(&path).unwrap(), preferences);
        std::fs::write(&path, "broken").unwrap();
        assert!(UiPreferences::load(&path).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "broken");
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
}
