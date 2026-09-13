//! Resource ids: `scheme:id`.
//!
//! Mirrors src/main/core/resources.ts. The scheme list is closed — an id whose
//! scheme is not in it is not a resource id at all, which is what stops a typo
//! from taking a lock on a namespace nothing else uses.

/// The schemes the bus recognises, in the order src/main/core/types.ts lists
/// them.
pub const RESOURCE_SCHEMES: [&str; 14] = [
    "widget",
    "note",
    "terminal",
    "file",
    "task",
    "canvas",
    "git",
    "run",
    "orctask",
    "dispatch",
    "gate",
    "plan",
    "search",
    "system",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedResource {
    pub scheme: String,
    pub id: String,
}

/// Splits on the *first* colon, so an id may itself contain one — a Windows
/// path in a `file:` resource does.
pub fn parse_resource(target: &str) -> Option<ParsedResource> {
    let at = target.find(':')?;
    if at == 0 {
        return None;
    }
    let (scheme, rest) = target.split_at(at);
    let id = &rest[1..];
    if !RESOURCE_SCHEMES.contains(&scheme) || id.is_empty() {
        return None;
    }
    Some(ParsedResource { scheme: scheme.to_owned(), id: id.to_owned() })
}

pub fn is_resource_id(value: &str) -> bool {
    parse_resource(value).is_some()
}

pub fn resource_id(scheme: &str, id: &str) -> String {
    format!("{scheme}:{id}")
}

/// Normalises a filesystem path into a `file:` resource.
///
/// Two processes must agree on the id or they will not see each other's locks,
/// so the normalisation is exact: backslashes become forward slashes, trailing
/// slashes are dropped, a drive letter is upper-cased, and everything after the
/// first slash is lower-cased. The drive letter is the one part that keeps its
/// case — `C:/Users` and `c:/users` are the same file on Windows, and folding
/// the whole string would make `/home/User` collide with `/home/user` on a
/// system where they are different.
pub fn file_resource(path: &str) -> String {
    let unified = path.replace('\\', "/");
    let unified = unified.trim_end_matches('/');

    let has_drive = {
        let bytes = unified.as_bytes();
        bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && bytes[2] == b'/'
    };
    let with_drive = if has_drive {
        let mut chars = unified.chars();
        let drive = chars.next().unwrap().to_ascii_uppercase();
        format!("{drive}{}", chars.as_str())
    } else {
        unified.to_owned()
    };

    let normalized = match with_drive.find('/') {
        Some(slash) => {
            let (head, tail) = with_drive.split_at(slash + 1);
            format!("{head}{}", tail.to_lowercase())
        }
        None => with_drive.to_lowercase(),
    };
    resource_id("file", &normalized)
}
