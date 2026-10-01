use egui::{Align2, Color32, FontId, Pos2, Rect, Stroke, Vec2};

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

impl TerminalScreen {
    /// The box one cell occupies: the monospace advance, and the font's own
    /// row height rather than a multiple of the point size. Box-drawing
    /// characters only join up on a grid matching the metrics the font was
    /// designed around — the renderer sets xterm's `lineHeight: 1` for the
    /// same reason, and a 1.25 multiplier left gaps in every frame a TUI drew.
    pub fn cell_size(painter: &egui::Painter, font_size: f32) -> Vec2 {
        let size = painter
            .layout_no_wrap("M".into(), FontId::monospace(font_size), Color32::WHITE)
            .size();
        Vec2::new(size.x.max(0.1), size.y.max(1.0))
    }

    pub fn size_for_rect(painter: &egui::Painter, rect: Rect, font_size: f32) -> (u16, u16) {
        let cell = Self::cell_size(painter, font_size);
        (
            (rect.height() / cell.y).floor().clamp(1.0, 300.0) as u16,
            (rect.width() / cell.x).floor().clamp(1.0, 500.0) as u16,
        )
    }

    fn caret_rect(painter: &egui::Painter, origin: Pos2, font_size: f32) -> Rect {
        // The row contains font leading below the visible capitals. Centering
        // on that row shifts the caret down relative to a shell prompt.
        // Use the same capital-glyph metrics as the terminal row.  The pipe
        // glyph has platform-specific descender/leading bounds and can make
        // the caret visibly lower on Linux than the prompt it accompanies.
        let reference =
            painter.layout_no_wrap("M".into(), FontId::monospace(font_size), Color32::WHITE);
        let ink = reference.mesh_bounds;
        let scale = painter.ctx().pixels_per_point();
        let snap = |value: f32| (value * scale).round() / scale;
        let top_padding = 2.0 / scale;
        let bottom_padding = 3.0 / scale;
        let caret_x = snap(origin.x + ink.left());
        Rect::from_min_max(
            Pos2::new(
                caret_x,
                snap(origin.y + ink.top() - top_padding),
            ),
            Pos2::new(
                caret_x + 1.0 / scale,
                snap(origin.y + ink.bottom() + bottom_padding),
            ),
        )
    }

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

    pub fn input(&self, event: &egui::Event) -> Option<Vec<u8>> {
        use egui::{Event, Key};
        let text = match event {
            Event::Text(text) => text.clone(),
            Event::Paste(text) => {
                let text = text.replace("\r\n", "\n").replace('\n', "\r");
                if self.screen().bracketed_paste() {
                    format!("\x1b[200~{}\x1b[201~", text.replace('\x1b', ""))
                } else {
                    text
                }
            }
            Event::Key {
                key,
                pressed: true,
                modifiers,
                ..
            } => {
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
                    Key::Enter => "\r",
                    Key::Backspace => "\x7f",
                    Key::Escape => "\x1b",
                    Key::Tab if modifiers.shift => "\x1b[Z",
                    Key::Tab => "\t",
                    Key::Delete => "\x1b[3~",
                    Key::Insert => "\x1b[2~",
                    Key::PageUp => "\x1b[5~",
                    Key::PageDown => "\x1b[6~",
                    _ => return None,
                };
                return Some(meta(modifiers.alt, plain.as_bytes().to_vec()));
            }
            _ => return None,
        };
        Some(text.into_bytes())
    }

    pub fn mouse_reporting(&self) -> bool {
        self.mouse_mode != 0
    }

    pub fn mouse_event(
        &mut self,
        event: &egui::Event,
        body: Rect,
        cell: Vec2,
        modifiers: egui::Modifiers,
    ) -> Option<Vec<u8>> {
        if !self.mouse_reporting() {
            return None;
        }
        let coordinates = |pos: Pos2| {
            let (rows, cols) = self.screen().size();
            (
                ((pos.x - body.left()) / cell.x)
                    .floor()
                    .clamp(0.0, f32::from(cols.saturating_sub(1))) as u16,
                ((pos.y - body.top()) / cell.y)
                    .floor()
                    .clamp(0.0, f32::from(rows.saturating_sub(1))) as u16,
            )
        };
        match event {
            egui::Event::PointerButton {
                pos,
                button,
                pressed,
                modifiers,
            } => {
                let button = match button {
                    egui::PointerButton::Primary => 0,
                    egui::PointerButton::Middle => 1,
                    egui::PointerButton::Secondary => 2,
                    _ => return None,
                };
                if (*pressed && !body.contains(*pos)) || (!*pressed && !self.mouse_buttons[button])
                {
                    return None;
                }
                let (col, row) = coordinates(*pos);
                self.mouse_buttons[button] = *pressed;
                self.mouse_position = Some((col, row));
                self.mouse_report(button as u8, *pressed, col, row, *modifiers)
            }
            egui::Event::PointerMoved(pos) if self.mouse_mode >= 1002 => {
                let button = self.mouse_buttons.iter().position(|pressed| *pressed);
                if button.is_none() && (self.mouse_mode != 1003 || !body.contains(*pos)) {
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
        modifiers: egui::Modifiers,
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

    pub fn paint(&self, painter: &egui::Painter, rect: Rect, font_size: f32, focused: bool) {
        let painter = painter.with_clip_rect(rect.intersect(painter.clip_rect()));
        let cell_size = Self::cell_size(&painter, font_size);
        let screen = self.screen();
        let (rows, cols) = screen.size();
        // Cells are drawn in runs that share a style rather than one call per
        // cell: a full screen is a few thousand cells, and laying out a galley
        // for each of them, every frame, for every open terminal, was the
        // single most expensive thing this app did.
        let mut run = String::new();
        for row in 0..rows {
            if rect.top() + row as f32 * cell_size.y >= rect.bottom() {
                break;
            }
            let mut pending: Option<(usize, CellStyle)> = None;
            let flush =
                |painter: &egui::Painter, run: &mut String, start: usize, style: CellStyle| {
                    if run.is_empty() {
                        return;
                    }
                    let origin =
                        rect.min + Vec2::new(start as f32 * cell_size.x, row as f32 * cell_size.y);
                    painter.text(
                        origin,
                        Align2::LEFT_TOP,
                        &*run,
                        style.face.font(font_size),
                        style.fg,
                    );
                    run.clear();
                };
            for col in 0..cols {
                if rect.left() + col as f32 * cell_size.x >= rect.right() {
                    break;
                }
                let Some(cell) = screen.cell(row, col) else {
                    continue;
                };
                if cell.is_wide_continuation() {
                    continue;
                }
                let style = CellStyle::of(cell);
                let pos = rect.min + Vec2::new(col as f32 * cell_size.x, row as f32 * cell_size.y);
                let width = cell_size.x * if cell.is_wide() { 2.0 } else { 1.0 };
                let cell_rect = Rect::from_min_size(pos, Vec2::new(width, cell_size.y));
                if style.bg != crate::theme::monochrome::BASE {
                    painter.rect_filled(cell_rect, 0.0, style.bg);
                }
                if cell.underline() {
                    painter.line_segment(
                        [cell_rect.left_bottom(), cell_rect.right_bottom()],
                        Stroke::new(1.0, style.fg),
                    );
                }
                let glyph = cell.contents();
                // A run has to break where the style changes, and where a gap
                // in the columns would shift everything after it left.
                let column = usize::from(col);
                let continues = pending.is_some_and(|(start, last)| {
                    last == style && start + run.chars().count() == column
                });
                if !continues {
                    if let Some((start, last)) = pending {
                        flush(&painter, &mut run, start, last);
                    }
                    pending = Some((column, style));
                }
                run.push_str(if glyph.is_empty() { " " } else { glyph });
            }
            if let Some((start, last)) = pending {
                flush(&painter, &mut run, start, last);
            }
        }
        if !screen.hide_cursor() && screen.scrollback() == 0 {
            let (row, col) = screen.cursor_position();
            let pos = Pos2::new(
                rect.left() + col as f32 * cell_size.x,
                rect.top() + row as f32 * cell_size.y,
            );
            let ink = Color32::from_rgb(232, 232, 234);
            let blinked_out = focused
                && self.cursor_blinks()
                && painter.ctx().input(|input| input.time) % 1.0 >= 0.5;
            if !blinked_out {
                painter.rect_filled(Self::caret_rect(&painter, pos, font_size), 0.0, ink);
            }
        }
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
fn control_byte(key: egui::Key) -> Option<u8> {
    use egui::Key;
    let name = key.name();
    if name.len() == 1 {
        let byte = name.as_bytes()[0].to_ascii_uppercase();
        if byte.is_ascii_uppercase() {
            return Some(byte - b'A' + 1);
        }
    }
    Some(match key {
        Key::Space => 0x00,
        Key::OpenBracket => 0x1b,
        Key::Backslash => 0x1c,
        Key::CloseBracket => 0x1d,
        Key::Slash | Key::Minus => 0x1f,
        Key::Backspace => 0x08,
        _ => return None,
    })
}

fn cursor_suffix(key: egui::Key) -> Option<&'static str> {
    use egui::Key;
    Some(match key {
        Key::ArrowUp => "A",
        Key::ArrowDown => "B",
        Key::ArrowRight => "C",
        Key::ArrowLeft => "D",
        Key::Home => "H",
        Key::End => "F",
        _ => return None,
    })
}

/// xterm's function keys: F1–F4 are SS3, the rest are CSI with a number.
fn function_key(key: egui::Key) -> Option<&'static str> {
    use egui::Key;
    Some(match key {
        Key::F1 => "\x1bOP",
        Key::F2 => "\x1bOQ",
        Key::F3 => "\x1bOR",
        Key::F4 => "\x1bOS",
        Key::F5 => "\x1b[15~",
        Key::F6 => "\x1b[17~",
        Key::F7 => "\x1b[18~",
        Key::F8 => "\x1b[19~",
        Key::F9 => "\x1b[20~",
        Key::F10 => "\x1b[21~",
        Key::F11 => "\x1b[23~",
        Key::F12 => "\x1b[24~",
        _ => return None,
    })
}

/// Everything about a cell that decides how its glyph is drawn. Cells that
/// agree on all of it can share one text call.
#[derive(Clone, Copy, PartialEq)]
struct CellStyle {
    fg: Color32,
    bg: Color32,
    face: crate::theme::TerminalStyle,
}

impl CellStyle {
    fn of(cell: &vt100::Cell) -> Self {
        let mut fg = color(cell.fgcolor(), Color32::from_rgb(232, 232, 234));
        let mut bg = color(cell.bgcolor(), crate::theme::monochrome::BASE);
        if cell.inverse() {
            std::mem::swap(&mut fg, &mut bg);
        }
        // SGR 2 is "faint": the same colour at lower intensity. Agent TUIs
        // lean on it for every secondary line, so ignoring it flattened their
        // whole interface into one weight.
        if cell.dim() {
            fg = fg.gamma_multiply(0.55);
        }
        Self {
            fg,
            bg,
            face: crate::theme::TerminalStyle::new(cell.bold(), cell.italic()),
        }
    }
}

fn color(value: vt100::Color, default: Color32) -> Color32 {
    const ANSI: [u32; 16] = [
        0x050506, 0xf07178, 0x7fd99a, 0xe6c07b, 0x7aa2f7, 0xc792ea, 0x7dcfff, 0xd4d4d8, 0x6b6b74,
        0xff8b92, 0x95e6a8, 0xf0d48a, 0x9ab8ff, 0xd7a6f5, 0x9de8ff, 0xffffff,
    ];
    match value {
        vt100::Color::Default => default,
        vt100::Color::Rgb(r, g, b) => Color32::from_rgb(r, g, b),
        vt100::Color::Idx(index @ 0..=15) => {
            let rgb = ANSI[index as usize];
            Color32::from_rgb((rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8)
        }
        vt100::Color::Idx(index @ 16..=231) => {
            let index = index - 16;
            let level = |n| if n == 0 { 0 } else { 55 + n * 40 };
            Color32::from_rgb(level(index / 36), level(index / 6 % 6), level(index % 6))
        }
        vt100::Color::Idx(index) => Color32::from_gray(8 + (index - 232) * 10),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn orange_truecolor_survives_every_transport_split() {
        let bytes = b"\x1b[38;2;217;119;87mClaude\x1b[0m";
        for split in 0..=bytes.len() {
            let mut screen = super::TerminalScreen::default();
            screen.process(&bytes[..split]);
            screen.process(&bytes[split..]);
            assert_eq!(
                super::CellStyle::of(screen.screen().cell(0, 0).unwrap()).fg,
                egui::Color32::from_rgb(217, 119, 87)
            );
        }
    }
    use super::*;

    #[test]
    fn caret_tracks_prompt_ink_at_different_font_sizes_and_scales() {
        for scale in [1.0, 1.25, 1.5, 2.0] {
            let ctx = egui::Context::default();
            crate::theme::apply(&ctx);
            ctx.set_pixels_per_point(scale);
            let mut output = ctx.run_ui(egui::RawInput::default(), |ui| {
                let ctx = ui.ctx();
                let painter = ctx.layer_painter(egui::LayerId::background());
                for size in [11.0, 13.0, 16.0, 20.0] {
                    let origin = Pos2::new(20.0, 31.0);
                    let prompt = painter.layout_no_wrap(
                        "PS C:\\Users>".into(),
                        FontId::monospace(size),
                        Color32::WHITE,
                    );
                    let caret = TerminalScreen::caret_rect(&painter, origin, size);
                    let text = prompt.mesh_bounds.translate(origin.to_vec2());
                    let pixel = 1.0 / ctx.pixels_per_point();
                    assert!(
                        (caret.center().y - text.center().y).abs() <= pixel,
                        "caret {caret:?}, prompt {text:?}, size {size}, scale {scale}"
                    );
                    assert!((caret.width() - pixel).abs() < 0.001);
                    assert!(caret.top() <= text.top() + pixel);
                    assert!(
                        caret.bottom() >= text.bottom() - pixel,
                        "caret {caret:?}, prompt {text:?}, size {size}, scale {scale}"
                    );
                }
            });
            output.textures_delta.clear();
        }
    }

    #[test]
    fn utf8_and_escape_sequences_survive_split_writes() {
        let mut terminal = TerminalScreen::default();
        for byte in "\x1b[31mПривет 界\x1b[0m".as_bytes() {
            terminal.process(&[*byte]);
        }
        assert_eq!(terminal.screen().contents(), "Привет 界");
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
        let modifiers = egui::Modifiers::default();
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
        let key = |key, modifiers| {
            terminal.input(&egui::Event::Key {
                key,
                physical_key: None,
                pressed: true,
                repeat: false,
                modifiers,
            })
        };
        assert_eq!(
            key(egui::Key::F5, egui::Modifiers::default()),
            Some(b"\x1b[15~".to_vec())
        );
        assert_eq!(
            key(egui::Key::F1, egui::Modifiers::default()),
            Some(b"\x1bOP".to_vec())
        );
        assert_eq!(key(egui::Key::C, egui::Modifiers::CTRL), Some(vec![3]));
        assert_eq!(key(egui::Key::Space, egui::Modifiers::CTRL), Some(vec![0]));
        assert_eq!(
            key(egui::Key::Enter, egui::Modifiers::ALT),
            Some(b"\x1b\r".to_vec())
        );
    }

    #[test]
    fn pointer_clicks_dragging_and_release_outside_the_card_reach_the_terminal() {
        let mut screen = TerminalScreen::default();
        screen.process(b"\x1b[?1002h\x1b[?1006h");
        let rect = Rect::from_min_size(Pos2::ZERO, Vec2::new(120.0, 32.0));
        let cell = Vec2::splat(1.0);
        let mods = egui::Modifiers::default();
        let click = |button, pressed, pos| egui::Event::PointerButton {
            pos,
            button,
            pressed,
            modifiers: mods,
        };
        for (button, code) in [
            (egui::PointerButton::Primary, 0),
            (egui::PointerButton::Middle, 1),
            (egui::PointerButton::Secondary, 2),
        ] {
            assert_eq!(
                screen.mouse_event(&click(button, true, Pos2::new(3.0, 4.0)), rect, cell, mods),
                Some(format!("\x1b[<{code};4;5M").into_bytes())
            );
            assert_eq!(
                screen.mouse_event(&click(button, false, Pos2::new(3.0, 4.0)), rect, cell, mods),
                Some(format!("\x1b[<{code};4;5m").into_bytes())
            );
        }
        assert!(screen
            .mouse_event(
                &egui::Event::PointerMoved(Pos2::new(5.0, 5.0)),
                rect,
                cell,
                mods
            )
            .is_none());
        screen.mouse_event(
            &click(egui::PointerButton::Primary, true, Pos2::new(3.0, 4.0)),
            rect,
            cell,
            mods,
        );
        assert_eq!(
            screen.mouse_event(
                &egui::Event::PointerMoved(Pos2::new(5.0, 5.0)),
                rect,
                cell,
                mods
            ),
            Some(b"\x1b[<32;6;6M".to_vec())
        );
        assert_eq!(
            screen.mouse_event(
                &click(egui::PointerButton::Primary, false, Pos2::new(200.0, 40.0)),
                rect,
                cell,
                mods
            ),
            Some(b"\x1b[<0;120;32m".to_vec())
        );
        screen.process(b"\x1b[?1003h");
        assert_eq!(
            screen.mouse_event(
                &egui::Event::PointerMoved(Pos2::new(5.0, 5.0)),
                rect,
                cell,
                mods
            ),
            Some(b"\x1b[<35;6;6M".to_vec())
        );
        screen.process(b"\x1bc");
        assert!(screen
            .mouse_event(
                &click(egui::PointerButton::Primary, true, Pos2::ZERO),
                rect,
                cell,
                mods
            )
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
            terminal
                .input(&egui::Event::Paste("a\r\nb".into()))
                .unwrap(),
            b"a\rb"
        );
        terminal.process(b"\x1b[?2004h");
        assert_eq!(
            terminal
                .input(&egui::Event::Paste("a\x1b[201~b".into()))
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
        let key = |key, modifiers| egui::Event::Key {
            key,
            physical_key: None,
            pressed: true,
            repeat: false,
            modifiers,
        };
        let mut terminal = TerminalScreen::default();
        assert_eq!(
            terminal
                .input(&key(egui::Key::ArrowUp, egui::Modifiers::NONE))
                .unwrap(),
            b"\x1b[A"
        );
        terminal.process(b"\x1b[?1h");
        assert_eq!(
            terminal
                .input(&key(egui::Key::ArrowUp, egui::Modifiers::NONE))
                .unwrap(),
            b"\x1bOA"
        );
        assert_eq!(
            terminal
                .input(&key(egui::Key::C, egui::Modifiers::CTRL))
                .unwrap(),
            [3]
        );
        assert_eq!(
            terminal
                .input(&key(egui::Key::ArrowUp, egui::Modifiers::SHIFT))
                .unwrap(),
            b"\x1b[1;2A"
        );
    }

    #[test]
    fn palette_covers_ansi_cube_grayscale_and_truecolor() {
        assert_eq!(
            color(vt100::Color::Idx(1), Color32::BLACK),
            Color32::from_rgb(240, 113, 120)
        );
        assert_eq!(color(vt100::Color::Idx(196), Color32::BLACK), Color32::RED);
        assert_eq!(
            color(vt100::Color::Idx(255), Color32::BLACK),
            Color32::from_gray(238)
        );
        assert_eq!(
            color(vt100::Color::Rgb(1, 2, 3), Color32::BLACK),
            Color32::from_rgb(1, 2, 3)
        );
    }
}
