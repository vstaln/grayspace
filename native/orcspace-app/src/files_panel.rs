use eframe::egui;
use std::{
    io::Read,
    path::{Path, PathBuf},
    sync::mpsc,
};

const MAX_ENTRIES: usize = 2000;
const MAX_PREVIEW: u64 = 256 * 1024;

struct Entry {
    path: PathBuf,
    directory: bool,
}
enum Loaded {
    Directory(Vec<Entry>, bool),
    Text(String),
}

fn read_path(path: &Path) -> Result<Loaded, String> {
    let metadata = path.metadata().map_err(|e| e.to_string())?;
    if metadata.is_dir() {
        let mut entries = Vec::new();
        let mut truncated = false;
        for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
            if entries.len() == MAX_ENTRIES {
                truncated = true;
                break;
            }
            let entry = entry.map_err(|e| e.to_string())?;
            entries.push(Entry {
                path: entry.path(),
                directory: entry.path().is_dir(),
            });
        }
        entries.sort_by_key(|e| {
            (
                !e.directory,
                e.path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_lowercase(),
            )
        });
        Ok(Loaded::Directory(entries, truncated))
    } else if metadata.is_file() {
        let mut bytes = Vec::new();
        std::fs::File::open(path)
            .map_err(|e| e.to_string())?
            .take(MAX_PREVIEW + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_PREVIEW {
            return Err("Preview limited to 256 KB; file left unchanged.".into());
        }
        if bytes.contains(&0) {
            return Err("Binary file · text preview unavailable".into());
        }
        String::from_utf8(bytes)
            .map(Loaded::Text)
            .map_err(|_| "Not a UTF-8 text file".into())
    } else {
        Err("Only regular files and folders can be opened".into())
    }
}

#[derive(Default)]
pub struct FilesPanel {
    path: PathBuf,
    draft: String,
    search: String,
    loaded: Option<Loaded>,
    error: Option<String>,
    pending: Option<mpsc::Receiver<Result<Loaded, String>>>,
}

impl FilesPanel {
    pub fn open(&mut self, path: PathBuf) {
        if self.pending.is_some() {
            return;
        }
        self.path = path.clone();
        self.draft = path.to_string_lossy().into_owned();
        self.loaded = None;
        self.error = None;
        self.search.clear();
        let (sender, receiver) = mpsc::channel();
        self.pending = Some(receiver);
        std::thread::spawn(move || {
            let _ = sender.send(read_path(&path));
        });
    }

    pub fn initialized(&self) -> bool {
        !self.path.as_os_str().is_empty()
    }

    pub fn refresh(&mut self) {
        self.open(self.path.clone());
    }

    pub fn show(&mut self, ui: &mut egui::Ui) {
        if let Some(receiver) = &self.pending {
            match receiver.try_recv() {
                Ok(result) => {
                    self.pending = None;
                    match result {
                        Ok(value) => self.loaded = Some(value),
                        Err(error) => self.error = Some(error),
                    }
                }
                Err(mpsc::TryRecvError::Disconnected) => {
                    self.pending = None;
                    self.error = Some("File reader stopped. Retry opening the path.".into());
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }
        ui.add_enabled_ui(self.pending.is_none(), |ui| {
            ui.horizontal(|ui| {
                if ui
                    .add_enabled(self.path.parent().is_some(), egui::Button::new("Up"))
                    .clicked()
                {
                    if let Some(parent) = self.path.parent() {
                        self.open(parent.to_owned());
                    }
                }
                let response = ui.add(
                    egui::TextEdit::singleline(&mut self.draft)
                        .desired_width((ui.available_width() - 90.0).max(40.0)),
                );
                if ui.button("Open").clicked()
                    || (response.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter)))
                {
                    let path = PathBuf::from(self.draft.trim().trim_matches('"'));
                    if path.is_absolute() {
                        self.open(path);
                    } else {
                        self.error = Some("Enter an absolute path".into());
                    }
                }
            });
        });
        if self.pending.is_some() {
            ui.spinner();
            ui.weak("Reading…");
        }
        if let Some(error) = &self.error {
            ui.colored_label(orcspace_app::theme::status::DANGER, error);
        }
        let mut open = None;
        match &self.loaded {
            Some(Loaded::Directory(entries, truncated)) => {
                ui.add(
                    egui::TextEdit::singleline(&mut self.search)
                        .hint_text("Search files…")
                        .desired_width(ui.available_width()),
                );
                if *truncated {
                    ui.weak("First 2,000 entries only; search covers loaded entries.");
                }
                let query = self.search.to_lowercase();
                egui::ScrollArea::vertical().show(ui, |ui| {
                    let mut count = 0;
                    for entry in entries {
                        let name = entry.path.file_name().unwrap_or_default().to_string_lossy();
                        if !name.to_lowercase().contains(&query) {
                            continue;
                        }
                        count += 1;
                        let label = format!("{}{}", name, if entry.directory { "/" } else { "" });
                        let response =
                            ui.add(egui::Label::new(label).sense(egui::Sense::click_and_drag()));
                        if response.drag_started() {
                            response.dnd_set_drag_payload(entry.path.clone());
                        }
                        if response.clicked() {
                            open = Some(entry.path.clone());
                        }
                        ui.separator();
                    }
                    if count == 0 {
                        ui.weak(if query.is_empty() {
                            "Folder is empty"
                        } else {
                            "No files match search filter"
                        });
                    }
                });
            }
            Some(Loaded::Text(text)) => {
                ui.weak("Text preview · read-only");
                egui::ScrollArea::both().show(ui, |ui| {
                    ui.monospace(text);
                });
            }
            None => {}
        }
        if let Some(path) = open {
            self.open(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preview_rejects_binary_and_large_files_and_sorts_folders_first() {
        let root = std::env::temp_dir().join(format!("orc-files-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("z-folder")).unwrap();
        std::fs::write(root.join("a.txt"), "hello").unwrap();
        std::fs::write(root.join("binary"), [0, 1, 2]).unwrap();
        std::fs::write(root.join("large"), vec![b'a'; MAX_PREVIEW as usize + 1]).unwrap();
        let Loaded::Directory(entries, truncated) = read_path(&root).unwrap() else {
            panic!()
        };
        assert!(entries[0].directory);
        assert!(!truncated);
        assert!(matches!(read_path(&root.join("a.txt")).unwrap(), Loaded::Text(s) if s == "hello"));
        assert!(read_path(&root.join("binary")).is_err());
        assert!(read_path(&root.join("large")).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
