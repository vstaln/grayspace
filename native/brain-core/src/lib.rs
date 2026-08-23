use napi::bindgen_prelude::Result;
use napi_derive::napi;
use std::collections::{HashMap, HashSet};

#[napi(object)]
pub struct ReindexNoteInput {
    pub id: String,
    pub title: String,
    pub content: String,
    pub alive: bool,
}

#[napi(object)]
pub struct ReindexNoteResult {
    pub id: String,
    pub links: Vec<String>,
    pub unresolved: Vec<String>,
}

fn norm(value: &str) -> String {
    value.trim().to_lowercase()
}

fn parse_wiki_links(content: &str) -> Vec<String> {
    let chars: Vec<char> = content.chars().collect();
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut i = 0;

    while i + 1 < chars.len() {
        if chars[i] != '[' || chars[i + 1] != '[' {
            i += 1;
            continue;
        }

        let start = i + 2;
        let mut end = start;
        while end < chars.len() && chars[end] != '[' && chars[end] != ']' && chars[end] != '\n' {
            end += 1;
        }
        if end + 1 < chars.len() && chars[end] == ']' && chars[end + 1] == ']' {
            let target: String = chars[start..end].iter().collect();
            let target = target.split('|').next().unwrap_or_default().trim().to_string();
            if !target.is_empty() && seen.insert(target.clone()) {
                out.push(target);
            }
            i = end + 2;
        } else {
            // A failed attempt only rules out `[[` starting exactly here — the second
            // bracket can still open a valid pair one position over (e.g. `[[[foo]]`
            // resolves via the 2nd/3rd brackets). Skipping to `start` would miss that,
            // same as a greedy-but-non-backtracking scan would.
            i += 1;
        }
    }

    out
}

fn lower_char(value: char) -> char {
    value.to_lowercase().next().unwrap_or(value)
}

fn is_word(value: char) -> bool {
    value.is_alphabetic() || value.is_numeric()
}

fn has_dollar_link(content_chars: &[char], title_lower_chars: &[char]) -> bool {
    if title_lower_chars.is_empty() {
        return false;
    }

    for (index, value) in content_chars.iter().enumerate() {
        if *value != '$' {
            continue;
        }
        if index > 0 && is_word(content_chars[index - 1]) {
            continue;
        }
        let end = index + 1 + title_lower_chars.len();
        if end > content_chars.len() {
            continue;
        }
        if !content_chars[index + 1..end]
            .iter()
            .zip(title_lower_chars)
            .all(|(actual, expected)| lower_char(*actual) == *expected)
        {
            continue;
        }
        if end < content_chars.len() && is_word(content_chars[end]) {
            continue;
        }
        return true;
    }

    false
}

#[napi]
pub fn reindex_notes(notes: Vec<ReindexNoteInput>, syntax: String) -> Result<Vec<ReindexNoteResult>> {
    let mut by_title = HashMap::new();
    for note in notes.iter().filter(|note| note.alive) {
        by_title.insert(norm(&note.title), note.id.clone());
    }

    let dollar_patterns = if syntax == "wiki" {
        Vec::new()
    } else {
        notes
            .iter()
            .filter(|note| note.alive)
            .filter_map(|note| {
                let title = note.title.trim();
                if title.is_empty() {
                    None
                } else {
                    Some((note.id.clone(), title.chars().map(lower_char).collect::<Vec<_>>()))
                }
            })
            .collect::<Vec<_>>()
    };

    let mut results = Vec::with_capacity(notes.len());
    for note in &notes {
        let mut links = Vec::new();
        let mut seen_links = HashSet::new();
        let mut unresolved = Vec::new();
        let mut seen_unresolved = HashSet::new();

        if syntax == "wiki" || syntax == "both" {
            for target in parse_wiki_links(&note.content) {
                let id = by_title.get(&norm(&target));
                if let Some(id) = id {
                    if id != &note.id && seen_links.insert(id.clone()) {
                        links.push(id.clone());
                    }
                } else if seen_unresolved.insert(target.clone()) {
                    unresolved.push(target);
                }
            }
        }

        if !dollar_patterns.is_empty() && note.content.contains('$') {
            let content_chars: Vec<char> = note.content.chars().collect();
            for (id, title_lower_chars) in &dollar_patterns {
                if id != &note.id && has_dollar_link(&content_chars, title_lower_chars) && seen_links.insert(id.clone()) {
                    links.push(id.clone());
                }
            }
        }

        results.push(ReindexNoteResult {
            id: note.id.clone(),
            links,
            unresolved,
        });
    }

    Ok(results)
}
