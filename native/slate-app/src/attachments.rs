use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub fn path_token(path: &str) -> Result<String, String> {
    if path.chars().any(|ch| ch <= '\u{1f}' || ch == '\u{7f}') {
        return Err("Attachment path contains control characters".into());
    }
    Ok(format!("\"{}\" ", path.replace('"', "\\\"")))
}

pub fn import_image(source: &Path, directory: &Path) -> Result<PathBuf, String> {
    if !source.is_absolute() {
        return Err("Image path must be absolute and local".into());
    }
    let source_text = source.to_str().ok_or("Image path is not UTF-8")?;
    let extended_drive = source_text.starts_with("\\\\?\\")
        && source_text
            .as_bytes()
            .get(4)
            .is_some_and(u8::is_ascii_alphabetic)
        && source_text.as_bytes().get(5) == Some(&b':')
        && source_text.as_bytes().get(6) == Some(&b'\\');
    if source_text.starts_with("\\\\") && !extended_drive {
        return Err("Network image paths are not accepted".into());
    }
    path_token(source.to_str().ok_or("Image path is not UTF-8")?)?;
    let extension = source
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ![
        "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg", "heic", "tif", "tiff",
    ]
    .contains(&extension.as_str())
    {
        return Err("Unsupported image extension".into());
    }
    let mut input = std::fs::File::open(source).map_err(|e| e.to_string())?;
    let metadata = input.metadata().map_err(|e| e.to_string())?;
    const MAX: u64 = 256 * 1024 * 1024;
    if !metadata.is_file() || metadata.len() > MAX {
        return Err("Image must be a file no larger than 256 MB".into());
    }
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let temporary = directory.join(format!(".import-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<PathBuf, String> {
        let mut output = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 65536];
        let mut total = 0u64;
        loop {
            let count = input.read(&mut buffer).map_err(|e| e.to_string())?;
            if count == 0 {
                break;
            }
            total += count as u64;
            if total > MAX {
                return Err("Image grew beyond 256 MB while reading".into());
            }
            hash.update(&buffer[..count]);
            output
                .write_all(&buffer[..count])
                .map_err(|e| e.to_string())?;
        }
        output.sync_all().map_err(|e| e.to_string())?;
        drop(output);
        let target = directory.join(format!("{:x}.{extension}", hash.finalize()));
        // Images are content-addressed, so an existing target is already the
        // result of this same import. Windows rename does not replace an
        // existing file; handle both a previous import and a concurrent one
        // without turning an idempotent paste into an error.
        if target.is_file() {
            std::fs::remove_file(&temporary).map_err(|e| e.to_string())?;
            return Ok(target);
        }
        match std::fs::rename(&temporary, &target) {
            Ok(()) => {}
            Err(_error) if target.is_file() => {
                std::fs::remove_file(&temporary).map_err(|e| e.to_string())?;
            }
            Err(error) => return Err(error.to_string()),
        }
        Ok(target)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quote_paths_without_allowing_terminal_controls() {
        assert_eq!(path_token("a b.png").unwrap(), "\"a b.png\" ");
        for path in ["a\rb", "a\nb", "a\x1bb", "a\0b"] {
            assert!(path_token(path).is_err());
        }
    }
    #[test]
    fn remote_or_relative_images_are_not_imported() {
        assert!(import_image(Path::new("https://example.com/a.png"), Path::new("unused")).is_err());
        assert!(import_image(Path::new("a.png"), Path::new("unused")).is_err());
    }

    #[test]
    fn imported_images_survive_source_removal_and_repeated_import() {
        let root =
            std::env::temp_dir().join(format!("slate-attachments-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let source = root.join("sample.png");
        let media = root.join("media");
        let bytes = b"\x89PNG\r\n\x1a\nfixture";
        std::fs::write(&source, bytes).unwrap();
        let imported = import_image(&source, &media).unwrap();
        assert_eq!(import_image(&source, &media).unwrap(), imported);
        std::fs::remove_file(&source).unwrap();
        assert_eq!(std::fs::read(&imported).unwrap(), bytes);
        assert_eq!(std::fs::read_dir(&media).unwrap().count(), 1);
        std::fs::remove_file(imported).unwrap();
        std::fs::remove_dir(media).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
