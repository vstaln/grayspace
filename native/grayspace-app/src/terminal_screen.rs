/// RGB triple for one terminal cell color. Same values as before;
/// the rgpui view packs them with crate::theme::hex().
pub type CellRgb = (u8, u8, u8);

use crate::terminal_protocol::{Control, Decoder};
use std::time::{Duration, Instant};

pub struct TerminalScreen {
    parser: vt100::Parser,
    controls: Decoder,
    wheel_remainder: f32,
    focus_reporting: bool,
    mouse_mode: u16,
    mouse_buttons: [bool; 3],
    mouse_position: Option<(u16, u16)>,
    sgr_mouse: bool,
    cursor_blink: bool,
    sync_started: Option<Instant>,
    sync_buffer: Vec<u8>,
    pending_controls: Vec<(usize, Control)>,
    replies: Vec<u8>,
}

pub fn last_mode_toggle(data: &[u8], mode: u16) -> Option<bool> {
    Decoder::default()
        .advance(data)
        .into_iter()
        .filter_map(|control| match control {
            Control::Mode(number, enabled) if number == mode => Some(enabled),
            Control::Reset => Some(false),
            _ => None,
        })
        .next_back()
}

const MAX_SYNC_BYTES: usize = 1 << 20;
const MAX_SYNC_TIME: Duration = Duration::from_millis(150);

impl Default for TerminalScreen {
    fn default() -> Self {
        Self {
            // 1500 lines, the same cap the renderer sets on xterm: every open
            // terminal holds its own buffer, and a workspace full of agents is
            // the case this is built for.
            parser: vt100::Parser::new(32, 120, 1500),
            wheel_remainder: 0.0,
            focus_reporting: false,
            mouse_mode: 0,
            mouse_buttons: [false; 3],
            mouse_position: None,
            sgr_mouse: false,
            cursor_blink: true,
            sync_started: None,
            sync_buffer: Vec::new(),
            controls: Decoder::default(),
            pending_controls: Vec::new(),
            replies: Vec::new(),
        }
    }
}

/// Own mouse button — replaces egui::PointerButton at the boundary.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MouseButton {
    Primary = 0,
    Middle = 1,
    Secondary = 2,
}

/// Own mouse input — replaces egui::Event at the boundary.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum MouseInput {
    Press { button: MouseButton, pos: (f32, f32) },
    Release { button: MouseButton, pos: (f32, f32) },
    Move { pos: (f32, f32) },
}

/// Own key enum — the egui::Key dependency died with the eframe UI.
/// Only the keys the terminal maps are listed; Char covers the rest.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TermKey {
    Char(char),
    Enter,
    Backspace,
    Escape,
    Tab,
    Delete,
    Insert,
    PageUp,
    PageDown,
    ArrowUp,
    ArrowDown,
    ArrowRight,
    ArrowLeft,
    Home,
    End,
    F1,
    F2,
    F3,
    F4,
    F5,
    F6,
    F7,
    F8,
    F9,
    F10,
    F11,
    F12,
    Space,
}

/// Own modifiers bit — replaces egui::Modifiers at the boundary.
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct KeyMods {
    pub shift: bool,
    pub alt: bool,
    pub ctrl: bool,
    pub mac_cmd: bool,
}

/// One key press translated at the UI boundary into terminal bytes.
/// Text input arrives as Text/Paste; special keys as Key.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum KeyInput {
    Text(String),
    Paste(String),
    Key { key: TermKey, modifiers: KeyMods },
}

impl TerminalScreen {
    /// The box one cell occupies: the monospace advance, and the font's own
    /// row height rather than a multiple of the point size. Box-drawing
    /// characters only join up on a grid matching the metrics the font was
    /// designed around — the renderer sets xterm's `lineHeight: 1` for the
    /// same reason, and a 1.25 multiplier left gaps in every frame a TUI drew.
    /// Feed raw pty bytes in. Synchronized-update frames (DECSET 2026)
    /// buffer until the closing sequence so a TUI frame reaches the screen
    /// whole or not at all; everything else flushes straight through.
    pub fn process(&mut self, bytes: &[u8]) {
        self.flush_expired();
        for byte in bytes {
            self.sync_buffer.push(*byte);
            for control in self.controls.advance(std::slice::from_ref(byte)) {
                match control {
                    Control::Mode(2026, true) => {
                        if self.sync_started.is_none() {
                            self.flush_frame();
                            self.sync_started = Some(Instant::now());
                        }
                    }
                    Control::Mode(2026, false) => {
                        self.sync_started = None;
                        self.flush_frame();
                    }
                    _ => self
                        .pending_controls
                        .push((self.sync_buffer.len(), control)),
                }
            }
            if self.sync_buffer.len() >= MAX_SYNC_BYTES {
                self.sync_started = None;
                self.flush_frame();
            }
        }
        if self.sync_started.is_none() {
            self.flush_frame();
        }
    }

    pub fn flush_expired(&mut self) {
        if self
            .sync_started
            .is_some_and(|started| started.elapsed() >= MAX_SYNC_TIME)
        {
            self.sync_started = None;
            self.flush_frame();
        }
    }

    fn flush_frame(&mut self) {
        let frame = std::mem::take(&mut self.sync_buffer);
        let mut offset = 0;
        for (end, control) in std::mem::take(&mut self.pending_controls) {
            self.parser.process(&frame[offset..end]);
            offset = end;
            match control {
                Control::Mode(12, enabled) => self.cursor_blink = enabled,
                Control::Mode(mode @ (1000 | 1002 | 1003), enabled) => {
                    if enabled {
                        self.mouse_mode = mode;
                    } else if self.mouse_mode == mode {
                        self.mouse_mode = 0;
                    }
                    self.mouse_buttons = [false; 3];
                    self.mouse_position = None;
                }
                Control::Mode(1004, enabled) => self.focus_reporting = enabled,
                Control::Mode(1006, enabled) => self.sgr_mouse = enabled,
                Control::Cursor(style) => {
                    self.cursor_blink = style == 0 || style % 2 == 1;
                }
                Control::Reset => {
                    self.cursor_blink = true;
                    self.focus_reporting = false;
                    self.mouse_mode = 0;
                    self.mouse_buttons = [false; 3];
                    self.mouse_position = None;
                    self.sgr_mouse = false;
                }
                Control::Status(5, false) => self.replies.extend_from_slice(b"\x1b[0n"),
                Control::Status(6, private) => {
                    let (row, col) = self.screen().cursor_position();
                    let prefix = if private { "?" } else { "" };
                    self.replies.extend_from_slice(
                        format!("\x1b[{prefix}{};{}R", row + 1, col + 1).as_bytes(),
                    );
                }
                Control::Attributes => self.replies.extend_from_slice(b"\x1b[?1;2c"),
                _ => {}
            }
        }
        self.parser.process(&frame[offset..]);
    }

    pub fn take_replies(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.replies)
    }

    fn cursor_blinks(&self) -> bool {
        !self.screen().alternate_screen() || self.cursor_blink
    }

    pub fn screen(&self) -> &vt100::Screen {
        self.parser.screen()
    }

    pub fn resize(&mut self, rows: u16, cols: u16) {
        self.parser
            .screen_mut()
            .set_size(rows.clamp(1, 300), cols.clamp(1, 500));
    }

    pub fn scroll(&mut self, lines: i32) {
        let offset = self.screen().scrollback();
        let next = if lines >= 0 {
            offset.saturating_add(lines as usize)
        } else {
            offset.saturating_sub(lines.unsigned_abs() as usize)
        };
        self.parser.screen_mut().set_scrollback(next);
    }

    pub fn scroll_pixels(&mut self, pixels: f32, row_height: f32) {
        if self.screen().alternate_screen() {
            self.wheel_remainder = 0.0;
            return;
        }
        if !pixels.is_finite() || !row_height.is_finite() || row_height <= 0.0 {
            return;
        }
        self.wheel_remainder += pixels;
        let lines = (self.wheel_remainder / row_height).trunc() as i32;
        if lines != 0 {
            self.wheel_remainder -= lines as f32 * row_height;
            self.scroll(lines);
        }
    }

    pub fn input(&self, event: &KeyInput) -> Option<Vec<u8>> {
        let text = match event {
            KeyInput::Text(text) => text.clone(),
            KeyInput::Paste(text) => {
                let text = text.replace("\r\n", "\n").replace('\n', "\r");
                if self.screen().bracketed_paste() {
                    format!("\x1b[200~{}\x1b[201~", text.replace('\x1b', ""))
                } else {
                    text
                }
            }
            KeyInput::Key { key, modifiers } => {
                if modifiers.mac_cmd {
                    return None;
                }
                if modifiers.ctrl {
                    if let Some(byte) = control_byte(*key) {
                        return Some(meta(modifiers.alt, vec![byte]));
                    }
                }
                // Arrows and Home/End take a CSI or SS3 introducer depending
                // on the application cursor mode, and grow a modifier
                // parameter when any modifier is held.
                if let Some(suffix) = cursor_suffix(*key) {
                    let modifier = 1
                        + u8::from(modifiers.shift)
                        + 2 * u8::from(modifiers.alt)
                        + 4 * u8::from(modifiers.ctrl);
                    return Some(
                        if modifier > 1 {
                            format!("\x1b[1;{modifier}{suffix}")
                        } else if self.screen().application_cursor() {
                            format!("\x1bO{suffix}")
                        } else {
                            format!("\x1b[{suffix}")
                        }
                        .into_bytes(),
                    );
                }
                if let Some(sequence) = function_key(*key) {
                    return Some(sequence.as_bytes().to_vec());
                }
                let plain = match key {
                    TermKey::Enter => "\r",
                    TermKey::Backspace => "\x7f",
                    TermKey::Escape => "\x1b",
                    TermKey::Tab if modifiers.shift => "\x1b[Z",
                    TermKey::Tab => "\t",
                    TermKey::Delete => "\x1b[3~",
                    TermKey::Insert => "\x1b[2~",
                    TermKey::PageUp => "\x1b[5~",
                    TermKey::PageDown => "\x1b[6~",
                    TermKey::Char(c) => {
                        return Some(meta(modifiers.alt, c.to_string().into_bytes()))
                    }
                    _ => return None,
                };
                return Some(meta(modifiers.alt, plain.as_bytes().to_vec()));
            }
        };
        Some(text.into_bytes())
    }

    pub fn mouse_reporting(&self) -> bool {
        self.mouse_mode != 0
    }

    pub fn mouse_event(
        &mut self,
        event: &MouseInput,
        body: (f32, f32, f32, f32),
        cell: (f32, f32),
        modifiers: KeyMods,
    ) -> Option<Vec<u8>> {
        if !self.mouse_reporting() {
            return None;
        }
        let (left, top, right, bottom) = body;
        let coordinates = |(x, y): (f32, f32)| {
            let (rows, cols) = self.screen().size();
            (
                ((x - left) / cell.0)
                    .floor()
                    .clamp(0.0, f32::from(cols.saturating_sub(1))) as u16,
                ((y - top) / cell.1)
                    .floor()
                    .clamp(0.0, f32::from(rows.saturating_sub(1))) as u16,
            )
        };
        let contains = |(x, y): (f32, f32)| x >= left && x < right && y >= top && y < bottom;
        match event {
            MouseInput::Press { button, pos } => {
                let index = *button as usize;
                if !contains(*pos) || self.mouse_buttons[index] {
                    // Press outside the body, or an already-down button:
                    // nothing to report. (Release outside still reports —
                    // the terminal must see the button come up.)
                    if !contains(*pos) {
                        return None;
                    }
                }
                let (col, row) = coordinates(*pos);
                self.mouse_buttons[index] = true;
                self.mouse_position = Some((col, row));
                let mods = match button {
                    MouseButton::Primary => modifiers,
                    _ => modifiers,
                };
                self.mouse_report(*button as u8, true, col, row, mods)
            }
            MouseInput::Release { button, pos } => {
                let index = *button as usize;
                if !self.mouse_buttons[index] {
                    return None;
                }
                let (col, row) = coordinates(*pos);
                self.mouse_buttons[index] = false;
                self.mouse_position = Some((col, row));
                self.mouse_report(*button as u8, false, col, row, modifiers)
            }
            MouseInput::Move { pos } if self.mouse_mode >= 1002 => {
                let button = self.mouse_buttons.iter().position(|pressed| *pressed);
                if button.is_none() && (self.mouse_mode != 1003 || !contains(*pos)) {
                    return None;
                }
                let (col, row) = coordinates(*pos);
                if self.mouse_position == Some((col, row)) {
                    return None;
                }
                self.mouse_position = Some((col, row));
                self.mouse_report(
                    button.map_or(35, |button| button as u8 + 32),
                    true,
                    col,
                    row,
                    modifiers,
                )
            }
            _ => None,
        }
    }

    /// One mouse report at the given cell. `button` is the xterm code: 0/1/2
    /// for the three buttons, 64 and 65 for the wheel.
    pub fn mouse_report(
        &self,
        button: u8,
        pressed: bool,
        column: u16,
        row: u16,
        modifiers: KeyMods,
    ) -> Option<Vec<u8>> {
        if !self.mouse_reporting() {
            return None;
        }
        let code = button
            + 4 * u8::from(modifiers.shift)
            + 8 * u8::from(modifiers.alt)
            + 16 * u8::from(modifiers.ctrl);
        // Coordinates are 1-based in both encodings.
        let (column, row) = (column.saturating_add(1), row.saturating_add(1));
        if self.sgr_mouse {
            let final_byte = if pressed { 'M' } else { 'm' };
            return Some(format!("\x1b[<{code};{column};{row}{final_byte}").into_bytes());
        }
        // The legacy encoding has one byte per field and no room to say which
        // button was released, so every release is reported as button 3.
        let code = if pressed {
            code
        } else {
            3 + 4 * u8::from(modifiers.shift)
                + 8 * u8::from(modifiers.alt)
                + 16 * u8::from(modifiers.ctrl)
        };
        let clamp = |value: u16| u8::try_from(value.min(223)).unwrap_or(223) + 32;
        Some(vec![0x1b, b'[', b'M', code + 32, clamp(column), clamp(row)])
    }

    /// The report a terminal expects when the window gains or loses focus,
    /// for programs that asked for it with DECSET 1004.
    pub fn focus_report(&self, focused: bool) -> Option<Vec<u8>> {
        self.focus_reporting.then(|| {
            if focused {
                b"\x1b[I".to_vec()
            } else {
                b"\x1b[O".to_vec()
            }
        })
    }
}

/// Alt is Meta: the same bytes, prefixed with ESC.
fn meta(alt: bool, mut bytes: Vec<u8>) -> Vec<u8> {
    if alt {
        bytes.insert(0, 0x1b);
    }
    bytes
}

/// The C0 byte a Ctrl chord sends. Ctrl+letter is the letter's position in
/// the alphabet; the punctuation chords are the rest of the C0 range, and
/// programs read Ctrl+Space as NUL.
fn control_byte(key: TermKey) -> Option<u8> {
    // Ctrl+letter is the letter's position in the alphabet; Ctrl+Space is NUL.
    if let TermKey::Char(c) = key {
        let byte = (c as u8).to_ascii_uppercase();
        if byte.is_ascii_uppercase() {
            return Some(byte - b'A' + 1);
        }
    }
    Some(match key {
        TermKey::Space => 0x00,
        TermKey::Backspace => 0x08,
        _ => return None,
    })
}

fn cursor_suffix(key: TermKey) -> Option<&'static str> {
    Some(match key {
        TermKey::ArrowUp => "A",
        TermKey::ArrowDown => "B",
        TermKey::ArrowRight => "C",
        TermKey::ArrowLeft => "D",
        TermKey::Home => "H",
        TermKey::End => "F",
        _ => return None,
    })
}

/// xterm's function keys: F1–F4 are SS3, the rest are CSI with a number.
fn function_key(key: TermKey) -> Option<&'static str> {
    Some(match key {
        TermKey::F1 => "\x1bOP",
        TermKey::F2 => "\x1bOQ",
        TermKey::F3 => "\x1bOR",
        TermKey::F4 => "\x1bOS",
        TermKey::F5 => "\x1b[15~",
        TermKey::F6 => "\x1b[17~",
        TermKey::F7 => "\x1b[18~",
        TermKey::F8 => "\x1b[19~",
        TermKey::F9 => "\x1b[20~",
        TermKey::F10 => "\x1b[21~",
        TermKey::F11 => "\x1b[23~",
        TermKey::F12 => "\x1b[24~",
        _ => return None,
    })
}

/// Everything about a cell that decides how its glyph is drawn. Cells that
/// agree on all of it can share one text call.
#[derive(Clone, Copy, PartialEq)]
struct CellStyle {
    fg: CellRgb,
    bg: CellRgb,
    bold: bool,
    italic: bool,
}

impl CellStyle {
    fn of(cell: &vt100::Cell) -> Self {
        let mut fg = color(cell.fgcolor(), (232, 232, 234));
        let mut bg = color(cell.bgcolor(), crate::theme::monochrome::BASE);
        if cell.inverse() {
            std::mem::swap(&mut fg, &mut bg);
        }
        // SGR 2 is "faint": the same colour at lower intensity. Agent TUIs
        // lean on it for every secondary line, so ignoring it flattened their
        // whole interface into one weight.
        if cell.dim() {
            fg = (
                (fg.0 as f32 * 0.55) as u8,
                (fg.1 as f32 * 0.55) as u8,
                (fg.2 as f32 * 0.55) as u8,
            );
        }
        Self {
            fg,
            bg,
            bold: cell.bold(),
            italic: cell.italic(),
        }
    }
}

fn color(value: vt100::Color, default: CellRgb) -> CellRgb {
    const ANSI: [u32; 16] = [
        0x050506, 0xf07178, 0x7fd99a, 0xe6c07b, 0x7aa2f7, 0xc792ea, 0x7dcfff, 0xd4d4d8, 0x6b6b74,
        0xff8b92, 0x95e6a8, 0xf0d48a, 0x9ab8ff, 0xd7a6f5, 0x9de8ff, 0xffffff,
    ];
    match value {
        vt100::Color::Default => default,
        vt100::Color::Rgb(r, g, b) => (r, g, b),
        vt100::Color::Idx(index @ 0..=15) => {
            let rgb = ANSI[index as usize];
            ((rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8)
        }
        vt100::Color::Idx(index @ 16..=231) => {
            let index = index - 16;
            let level = |n: u8| if n == 0 { 0 } else { 55 + n * 40 };
            (level(index / 36), level(index / 6 % 6), level(index % 6))
        }
        vt100::Color::Idx(index) => {
            let g = 8 + (index - 232) * 10;
            (g, g, g)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orange_truecolor_survives_every_transport_split() {
        let bytes = b"\x1b[38;2;217;119;87mClaude\x1b[0m";
        for split in 0..=bytes.len() {
            let mut screen = super::TerminalScreen::default();
            screen.process(&bytes[..split]);
            screen.process(&bytes[split..]);
            assert_eq!(
                super::CellStyle::of(screen.screen().cell(0, 0).unwrap()).fg,
                (217, 119, 87)
            );
        }
    }

    #[test]
    fn utf8_and_escape_sequences_survive_split_writes() {
        let mut terminal = TerminalScreen::default();
        for byte in "\x1b[31m\u{41f}\u{440}\u{438}\u{432}\u{435}\u{442} \u{754c}".as_bytes() {
            terminal.process(&[*byte]);
        }
        assert_eq!(terminal.screen().contents(), "\u{41f}\u{440}\u{438}\u{432}\u{435}\u{442} \u{754c}");
        assert_eq!(
            terminal.screen().cell(0, 0).unwrap().fgcolor(),
            vt100::Color::Idx(1)
        );
        assert!(terminal.screen().cell(0, 7).unwrap().is_wide());
    }

    #[test]
    fn cursor_updates_replace_text_and_alternate_screen_restores_it() {
        let mut terminal = TerminalScreen::default();
        terminal.process(b"old\rnew\x1b[?1049hother\x1b[?1049l");
        assert_eq!(terminal.screen().contents(), "new");
    }

    /// A program that turns blinking off must not be given a blinking caret:
    /// an agent that draws its own is the case this broke.
    #[test]
    fn the_program_owns_cursor_blinking() {
        let mut terminal = TerminalScreen::default();
        assert!(terminal.cursor_blink);
        terminal.process(b"\x1b[?12l");
        assert!(!terminal.cursor_blink);
        terminal.process(b"\x1b[?12h");
        assert!(terminal.cursor_blink);
        // DECSCUSR: an even parameter is the steady variant of its shape.
        terminal.process(b"\x1b[4 q");
        assert!(!terminal.cursor_blink);
        // Style 0 restores the default blinking cursor.
        terminal.process(b"\x1b[?12h\x1b[0 q");
        assert!(terminal.cursor_blink);
    }

    #[test]
    fn cursor_commands_keep_stream_order_at_every_chunk_boundary() {
        let stream = b"\x1b[?1049h\x1b[5 q\x1b[?12l";
        for chunk_size in 1..=stream.len() {
            let mut terminal = TerminalScreen::default();
            for chunk in stream.chunks(chunk_size) {
                terminal.process(chunk);
            }
            assert!(!terminal.cursor_blinks(), "chunk size {chunk_size}");
            terminal.process(b"x");
            assert!(!terminal.cursor_blinks());
            terminal.process(b"\x1b[?1049l");
            assert!(terminal.cursor_blinks());
        }
    }

    #[test]
    fn sync_frames_do_not_expose_cursor_changes_early() {
        let mut terminal = TerminalScreen::default();
        terminal.process(b"\x1b[?1049h\x1b[?2026h\x1b[6 qhalf");
        assert_eq!(terminal.screen().contents(), "");
        terminal.process(b" done\x1b[?2026l\x1b[?2026hnext");
        assert_eq!(terminal.screen().contents(), "half done");
        assert!(!terminal.cursor_blinks());
        terminal.sync_started = Some(Instant::now() - MAX_SYNC_TIME);
        terminal.flush_expired();
        assert_eq!(terminal.screen().contents(), "half donenext");
    }

    #[test]
    fn queries_report_the_cursor_at_the_query_and_reset_clears_modes() {
        let mut terminal = TerminalScreen::default();
        terminal.process(b"abc\x1b[6nxyz\x1b[5n\x1b[c");
        assert_eq!(terminal.take_replies(), b"\x1b[1;4R\x1b[0n\x1b[?1;2c");
        terminal.process(b"\x1b[?1004;1006;1000h\x1b[6 q\x1bc");
        assert_eq!(terminal.focus_report(true), None);
        assert!(!terminal.mouse_reporting());
    }

    #[test]
    fn a_synchronized_frame_is_shown_whole_or_not_at_all() {
        let mut terminal = TerminalScreen::default();
        terminal.process(b"\x1b[?2026hhalf");
        assert_eq!(
            terminal.screen().contents(),
            "",
            "a half-drawn frame reached the screen"
        );
        terminal.process(b" a frame\x1b[?2026l");
        assert_eq!(terminal.screen().contents(), "half a frame");
    }

    #[test]
    fn modes_split_across_two_reads_are_still_seen() {
        let mut terminal = TerminalScreen::default();
        terminal.process(b"\x1b[?10");
        terminal.process(b"04h");
        assert_eq!(terminal.focus_report(true), Some(b"\x1b[I".to_vec()));
    }

    #[test]
    fn mouse_reports_only_go_out_once_a_program_asks_for_them() {
        let mut terminal = TerminalScreen::default();
        let modifiers = KeyMods::default();
        assert_eq!(terminal.mouse_report(0, true, 3, 4, modifiers), None);
        terminal.process(b"\x1b[?1000h\x1b[?1006h");
        assert_eq!(
            terminal.mouse_report(0, true, 3, 4, modifiers),
            Some(b"\x1b[<0;4;5M".to_vec())
        );
        assert_eq!(
            terminal.mouse_report(0, false, 3, 4, modifiers),
            Some(b"\x1b[<0;4;5m".to_vec())
        );
    }

    #[test]
    fn function_keys_and_meta_reach_the_shell() {
        let terminal = TerminalScreen::default();
        let key = |key, modifiers| terminal.input(&KeyInput::Key { key, modifiers });
        let none = KeyMods::default();
        assert_eq!(
            key(TermKey::F5, none),
            Some(b"\x1b[15~".to_vec())
        );
        assert_eq!(
            key(TermKey::F1, none),
            Some(b"\x1bOP".to_vec())
        );
        assert_eq!(
            key(TermKey::Char('c'), KeyMods { ctrl: true, ..none }),
            Some(vec![3])
        );
        assert_eq!(
            key(TermKey::Space, KeyMods { ctrl: true, ..none }),
            Some(vec![0])
        );
        assert_eq!(
            key(TermKey::Enter, KeyMods { alt: true, ..none }),
            Some(b"\x1b\r".to_vec())
        );
    }

    #[test]
    fn pointer_clicks_dragging_and_release_outside_the_card_reach_the_terminal() {
        let mut screen = TerminalScreen::default();
        screen.process(b"\x1b[?1002h\x1b[?1006h");
        let body = (0.0, 0.0, 120.0, 32.0);
        let cell = (1.0, 1.0);
        let mods = KeyMods::default();
        let click = |button: MouseButton, pressed: bool, pos: (f32, f32)| {
            if pressed {
                MouseInput::Press { button, pos }
            } else {
                MouseInput::Release { button, pos }
            }
        };
        for (button, code) in [
            (MouseButton::Primary, 0),
            (MouseButton::Middle, 1),
            (MouseButton::Secondary, 2),
        ] {
            assert_eq!(
                screen.mouse_event(&click(button, true, (3.0, 4.0)), body, cell, mods),
                Some(format!("\x1b[<{code};4;5M").into_bytes())
            );
            assert_eq!(
                screen.mouse_event(&click(button, false, (3.0, 4.0)), body, cell, mods),
                Some(format!("\x1b[<{code};4;5m").into_bytes())
            );
        }
        assert!(screen
            .mouse_event(&MouseInput::Move { pos: (5.0, 5.0) }, body, cell, mods)
            .is_none());
        screen.mouse_event(
            &click(MouseButton::Primary, true, (3.0, 4.0)),
            body,
            cell,
            mods,
        );
        assert_eq!(
            screen.mouse_event(&MouseInput::Move { pos: (5.0, 5.0) }, body, cell, mods),
            Some(b"\x1b[<32;6;6M".to_vec())
        );
        assert_eq!(
            screen.mouse_event(
                &click(MouseButton::Primary, false, (200.0, 40.0)),
                body,
                cell,
                mods
            ),
            Some(b"\x1b[<0;120;32m".to_vec())
        );
        screen.process(b"\x1b[?1003h");
        assert_eq!(
            screen.mouse_event(&MouseInput::Move { pos: (5.0, 5.0) }, body, cell, mods),
            Some(b"\x1b[<35;6;6M".to_vec())
        );
        screen.process(b"\x1bc");
        assert!(screen
            .mouse_event(&click(MouseButton::Primary, true, (0.0, 0.0)), body, cell, mods)
            .is_none());
    }

    #[test]
    fn dimensions_are_bounded() {
        let mut terminal = TerminalScreen::default();
        terminal.resize(0, 0);
        assert_eq!(terminal.screen().size(), (1, 1));
        terminal.resize(u16::MAX, u16::MAX);
        assert_eq!(terminal.screen().size(), (300, 500));
    }

    #[test]
    fn paste_uses_terminal_mode_and_cannot_end_its_own_bracket() {
        let mut terminal = TerminalScreen::default();
        assert_eq!(
            terminal.input(&KeyInput::Paste("a\r\nb".into())).unwrap(),
            b"a\rb"
        );
        terminal.process(b"\x1b[?2004h");
        assert_eq!(
            terminal
                .input(&KeyInput::Paste("a\x1b[201~b".into()))
                .unwrap(),
            b"\x1b[200~a[201~b\x1b[201~"
        );
    }

    #[test]
    fn scrollback_is_bounded_and_returns_to_live_output() {
        let mut terminal = TerminalScreen::default();
        terminal.resize(2, 20);
        terminal.process(b"one\r\ntwo\r\nthree");
        terminal.scroll(1);
        assert_eq!(terminal.screen().contents(), "one\ntwo");
        terminal.scroll(i32::MAX);
        assert_eq!(terminal.screen().scrollback(), 1);
        terminal.scroll(i32::MIN);
        assert_eq!(terminal.screen().contents(), "two\nthree");
    }

    #[test]
    fn trackpad_accumulates_fractional_rows() {
        let mut terminal = TerminalScreen::default();
        terminal.resize(2, 20);
        terminal.process(b"one\r\ntwo\r\nthree");
        for _ in 0..3 {
            terminal.scroll_pixels(4.0, 16.0);
        }
        assert_eq!(terminal.screen().scrollback(), 0);
        terminal.scroll_pixels(4.0, 16.0);
        assert_eq!(terminal.screen().scrollback(), 1);
    }

    #[test]
    fn arrow_keys_follow_application_mode_and_control_keys_are_bytes() {
        let key = |key, modifiers| KeyInput::Key { key, modifiers };
        let mut terminal = TerminalScreen::default();
        assert_eq!(
            terminal.input(&key(TermKey::ArrowUp, KeyMods::default())).unwrap(),
            b"\x1b[A"
        );
        terminal.process(b"\x1b[?1h");
        assert_eq!(
            terminal.input(&key(TermKey::ArrowUp, KeyMods::default())).unwrap(),
            b"\x1bOA"
        );
        assert_eq!(
            terminal
                .input(&key(TermKey::Char('c'), KeyMods { ctrl: true, ..KeyMods::default() }))
                .unwrap(),
            [3]
        );
        assert_eq!(
            terminal
                .input(&key(TermKey::ArrowUp, KeyMods { shift: true, ..KeyMods::default() }))
                .unwrap(),
            b"\x1b[1;2A"
        );
    }

    #[test]
    fn palette_covers_ansi_cube_grayscale_and_truecolor() {
        assert_eq!(
            color(vt100::Color::Idx(1), (0, 0, 0)),
            (240, 113, 120)
        );
        assert_eq!(color(vt100::Color::Idx(196), (0, 0, 0)), (255, 0, 0));
        assert_eq!(
            color(vt100::Color::Idx(255), (0, 0, 0)),
            (238, 238, 238)
        );
        assert_eq!(
            color(vt100::Color::Rgb(1, 2, 3), (0, 0, 0)),
            (1, 2, 3)
        );
    }
}
