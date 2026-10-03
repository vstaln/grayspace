use rgpui::*;

pub fn list_entries(path: &std::path::Path) -> Result<Vec<(String, bool)>, String> {
    let mut entries: Vec<(String, bool)> = Vec::new();
    for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
        if entries.len() >= 2000 {
            break;
        }
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        entries.push((name, entry.path().is_dir()));
    }
    // Same order as files_panel.rs: dirs first, then case-insensitive name.
    entries.sort_by_key(|(name, dir)| (!dir, name.to_lowercase()));
    Ok(entries)
}

pub fn files_pane(path: &std::path::Path) -> impl IntoElement {
    let mut col = div().flex().flex_col().gap_1();
    match list_entries(path) {
        Ok(entries) => {
            for (name, dir) in entries {
                col = col.child(
                    div()
                        .text_sm()
                        .text_color(if dir { rgb(0xffffff) } else { rgb(0xb9b9be) })
                        .child(format!("{}{}", if dir { "▸ " } else { "· " }, name)),
                );
            }
        }
        Err(e) => {
            col = col.child(div().text_sm().text_color(rgb(0xe7a1a1)).child(format!("files: {e}")));
        }
    }
    div().flex_1().flex().flex_col().child(col)
}
