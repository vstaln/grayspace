use gpui::*;
use slate_app::terminal_screen::{KeyInput, KeyMods, TermKey};

/// One gpui keystroke translated into the boundary type the screen layer
/// encodes. Named keys become `Key`; printable characters become `Text` so
/// the shell sees what the layout typed; ^x / M-x keep their modifiers by
/// staying `Char` keys.
pub fn map_keystroke(ks: &Keystroke) -> Option<KeyInput> {
    let modifiers = KeyMods {
        shift: ks.modifiers.shift,
        alt: ks.modifiers.alt,
        ctrl: ks.modifiers.control,
        mac_cmd: ks.modifiers.platform,
    };
    let named = |key: TermKey| Some(KeyInput::Key { key, modifiers });
    match ks.key.as_str() {
        "enter" => return named(TermKey::Enter),
        "backspace" => return named(TermKey::Backspace),
        "escape" => return named(TermKey::Escape),
        "tab" => return named(TermKey::Tab),
        "delete" => return named(TermKey::Delete),
        "insert" => return named(TermKey::Insert),
        "pageup" => return named(TermKey::PageUp),
        "pagedown" => return named(TermKey::PageDown),
        "up" => return named(TermKey::ArrowUp),
        "down" => return named(TermKey::ArrowDown),
        "left" => return named(TermKey::ArrowLeft),
        "right" => return named(TermKey::ArrowRight),
        "home" => return named(TermKey::Home),
        "end" => return named(TermKey::End),
        "f1" => return named(TermKey::F1),
        "f2" => return named(TermKey::F2),
        "f3" => return named(TermKey::F3),
        "f4" => return named(TermKey::F4),
        "f5" => return named(TermKey::F5),
        "f6" => return named(TermKey::F6),
        "f7" => return named(TermKey::F7),
        "f8" => return named(TermKey::F8),
        "f9" => return named(TermKey::F9),
        "f10" => return named(TermKey::F10),
        "f11" => return named(TermKey::F11),
        "f12" => return named(TermKey::F12),
        _ => {}
    }
    // The keypad survives as `KP_*` keysyms when NumLock is off (with it on,
    // xkb hands over the plain "1"/"enter" keysyms — by then they ARE text).
    // Legacy encodes them as their characters; kitty carries the numpad
    // keycodes so a TUI can tell KP_1 from 1.
    let key_lower = ks.key.to_ascii_lowercase();
    if let Some(rest) = key_lower.strip_prefix("kp_") {
        let numpad = match rest {
            "enter" => Some(TermKey::NumpadEnter),
            "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" => {
                Some(TermKey::Numpad(rest.chars().next()?))
            }
            "add" => Some(TermKey::Numpad('+')),
            "subtract" => Some(TermKey::Numpad('-')),
            "multiply" => Some(TermKey::Numpad('*')),
            "divide" => Some(TermKey::Numpad('/')),
            "decimal" | "separator" => Some(TermKey::Numpad('.')),
            "equal" => Some(TermKey::Numpad('=')),
            _ => None,
        };
        if let Some(key) = numpad {
            return Some(KeyInput::Key { key, modifiers });
        }
    }
    // ^x and M-x are control bytes / meta escapes, not text.
    if (modifiers.ctrl || modifiers.alt) && ks.key.len() == 1 {
        let c = ks.key.chars().next()?;
        return Some(KeyInput::Key {
            key: TermKey::Char(c),
            modifiers,
        });
    }
    if !modifiers.ctrl && !modifiers.mac_cmd {
        if let Some(text) = &ks.key_char {
            return Some(KeyInput::Text(text.clone()));
        }
    }
    None
}
