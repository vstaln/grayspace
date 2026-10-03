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
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preview_rejects_binary_and_large_files_and_sorts_folders_first() {
        let root = std::env::temp_dir().join(format!("grayspace-files-{}", uuid::Uuid::new_v4()));
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
