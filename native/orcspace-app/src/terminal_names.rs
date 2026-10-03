//! Automatic terminal names (pool vendored in `tests/fixtures/terminalNames.ts`).
//!
//! The pool is fixed so every session is called the same thing. Names are never suffixed: the pool is
//! larger than the number of terminals a window holds, so "James-2" would only
//! ever mean the picker had gone wrong.

use std::collections::HashSet;

pub const NAMES: [&str; 64] = [
    "James",
    "Henry",
    "Oliver",
    "William",
    "Jack",
    "George",
    "Thomas",
    "Charles",
    "Edward",
    "Arthur",
    "Harry",
    "John",
    "Robert",
    "Michael",
    "David",
    "Daniel",
    "Samuel",
    "Joseph",
    "Benjamin",
    "Alexander",
    "Matthew",
    "Andrew",
    "Joshua",
    "Nathan",
    "Peter",
    "Paul",
    "Luke",
    "Mark",
    "Adam",
    "Simon",
    "Isaac",
    "Noah",
    "Liam",
    "Ethan",
    "Jacob",
    "Oscar",
    "Leo",
    "Louis",
    "Frederick",
    "Albert",
    "Alfred",
    "Theodore",
    "Sebastian",
    "Nicholas",
    "Anthony",
    "Jonathan",
    "Christopher",
    "Patrick",
    "Richard",
    "Philip",
    "Stephen",
    "Victor",
    "Vincent",
    "Hugo",
    "Miles",
    "Julian",
    "Caleb",
    "Dylan",
    "Owen",
    "Connor",
    "Ryan",
    "Aaron",
    "Adrian",
    "Eric",
];

/// The first free name at or after `start`, wrapping once. `None` once every
/// name is taken, which leaves the caller showing the terminal's id instead.
pub fn pick_from(start: usize, taken: &HashSet<String>) -> Option<&'static str> {
    let lowered: HashSet<String> = taken.iter().map(|name| name.to_lowercase()).collect();
    (0..NAMES.len())
        .map(|offset| NAMES[(start + offset) % NAMES.len()])
        .find(|name| !lowered.contains(&name.to_lowercase()))
}

/// Starts somewhere random so a fresh window does not always open as "James".
pub fn pick(taken: &HashSet<String>) -> Option<&'static str> {
    let start = (uuid::Uuid::new_v4().as_u128() % NAMES.len() as u128) as usize;
    pick_from(start, taken)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn taken(names: &[&str]) -> HashSet<String> {
        names.iter().map(|name| (*name).to_owned()).collect()
    }

    #[test]
    fn the_first_free_name_is_taken_in_pool_order() {
        assert_eq!(pick_from(0, &taken(&[])), Some("James"));
        assert_eq!(pick_from(0, &taken(&["James", "Henry"])), Some("Oliver"));
        assert_eq!(pick_from(2, &taken(&[])), Some("Oliver"));
    }

    #[test]
    fn the_search_wraps_and_ignores_case() {
        assert_eq!(pick_from(63, &taken(&["eric"])), Some("James"));
    }

    #[test]
    fn an_exhausted_pool_reports_no_name_rather_than_suffixing_one() {
        assert_eq!(pick_from(0, &taken(&NAMES)), None);
    }

    /// The pool must not drift from the vendored Electron pool.
    #[test]
    fn the_pool_matches_the_renderers() {
        const SOURCE: &str = include_str!("../tests/fixtures/terminalNames.ts");
        for name in NAMES {
            assert!(
                SOURCE.contains(&format!("'{name}'")),
                "{name} is not in terminalNames.ts"
            );
        }
    }
}
