//! OrcSpace's design tokens.
//!
//! These are not "a dark theme" — they are the exact values from
//! src/renderer/src/ui/tokens.ts, and a test reads that file to keep them so.
//! The palette is deliberately near-black and almost hueless: the canvas is a
//! backdrop for terminals full of coloured output, and any tint in the chrome
//! fights with it.
//!
//! Ported as data rather than as egui styling calls so the same numbers can
//! drive the canvas, the widget chrome and anything added later, instead of
//! being retyped per call site.

use egui::Color32;

/// The five greys everything is built from.
pub mod monochrome {
    use super::Color32;
    /// The canvas itself, and the body of a terminal.
    pub const BASE: Color32 = Color32::from_rgb(0x08, 0x08, 0x08);
    pub const TERMINAL_HEADER: Color32 = Color32::from_rgb(0x0D, 0x0D, 0x0D);
    /// A widget's body, and the title bar.
    pub const SURFACE: Color32 = Color32::from_rgb(0x12, 0x12, 0x12);
    /// Menus and panels that sit above a widget.
    pub const ELEVATED: Color32 = Color32::from_rgb(0x18, 0x18, 0x18);
    /// Hover fills, and the ring around a widget.
    pub const RAISED: Color32 = Color32::from_rgb(0x1F, 0x1F, 0x1F);
}

/// Hairlines. `FAINT` is the one that separates a header from its body;
/// `SOFT` is the ring around a widget.
pub mod hairline {
    use super::{monochrome, Color32};
    pub const FAINT: Color32 = Color32::from_rgb(0x2A, 0x2A, 0x2E);
    pub const SOFT: Color32 = monochrome::RAISED;
    pub const ACTIVE: Color32 = monochrome::RAISED;
}

pub mod text {
    use super::Color32;
    pub const NORMAL: Color32 = Color32::WHITE;
    pub const DIM: Color32 = Color32::from_rgb(0xB9, 0xB9, 0xBE);
    pub const FAINT: Color32 = Color32::from_rgb(0xA9, 0xA9, 0xB0);
}

pub mod status {
    use super::Color32;
    pub const DANGER: Color32 = Color32::from_rgb(0xE7, 0xA1, 0xA1);
    pub const OK: Color32 = Color32::from_rgb(0x6F, 0xD3, 0x9A);
}

pub mod geometry {
    pub const WIDGET_RADIUS: f32 = 0.0;
    /// Widget header height, matching `h-[34px]`.
    pub const HEADER_HEIGHT: f32 = 34.0;
    /// The ring around a widget is one *device* pixel in the DOM; at canvas
    /// zoom it stays one logical pixel so it does not thicken when zoomed.
    pub const HAIRLINE: f32 = 1.0;
    pub const RAIL_WIDTH: f32 = 56.0;
    pub const SIDEBAR_EXPANDED: f32 = 200.0;
}

/// Applies the palette to an egui context, so widgets that are not drawn by
/// hand still match.
pub fn apply(ctx: &egui::Context) {
    let mut visuals = egui::Visuals::dark();
    visuals.panel_fill = monochrome::BASE;
    visuals.window_fill = monochrome::SURFACE;
    visuals.extreme_bg_color = monochrome::BASE;
    visuals.faint_bg_color = monochrome::SURFACE;
    visuals.override_text_color = Some(text::NORMAL);

    visuals.widgets.noninteractive.bg_fill = monochrome::SURFACE;
    visuals.widgets.noninteractive.bg_stroke = egui::Stroke::new(1.0, hairline::FAINT);
    visuals.widgets.inactive.bg_fill = monochrome::SURFACE;
    visuals.widgets.inactive.bg_stroke = egui::Stroke::new(1.0, hairline::SOFT);
    visuals.widgets.hovered.bg_fill = monochrome::RAISED;
    visuals.widgets.hovered.bg_stroke = egui::Stroke::new(1.0, hairline::ACTIVE);
    visuals.widgets.active.bg_fill = monochrome::RAISED;
    visuals.widgets.active.bg_stroke = egui::Stroke::new(1.0, hairline::ACTIVE);
    visuals.widgets.open.bg_fill = monochrome::RAISED;
    visuals.widgets.open.bg_stroke = egui::Stroke::new(1.0, hairline::SOFT);
    visuals.window_stroke = egui::Stroke::new(1.0, hairline::SOFT);
    visuals.hyperlink_color = text::NORMAL;
    visuals.warn_fg_color = text::DIM;
    visuals.error_fg_color = status::DANGER;
    for widget in [
        &mut visuals.widgets.noninteractive,
        &mut visuals.widgets.inactive,
        &mut visuals.widgets.hovered,
        &mut visuals.widgets.active,
        &mut visuals.widgets.open,
    ] {
        widget.weak_bg_fill = widget.bg_fill;
        widget.corner_radius = egui::CornerRadius::ZERO;
        widget.fg_stroke.color = text::DIM;
    }
    visuals.widgets.hovered.fg_stroke.color = text::NORMAL;
    visuals.widgets.active.fg_stroke.color = text::NORMAL;
    visuals.window_corner_radius = egui::CornerRadius::ZERO;
    visuals.menu_corner_radius = egui::CornerRadius::ZERO;

    // The renderer uses a single accent — white — rather than a hue, so
    // selection reads as brightness instead of colour.
    visuals.selection.bg_fill = Color32::from_rgba_unmultiplied(255, 255, 255, 36);
    visuals.selection.stroke = egui::Stroke::new(1.0, text::NORMAL);

    ctx.set_visuals(visuals);
    ctx.style_mut_of(egui::Theme::Dark, |style| {
        style.spacing.button_padding = egui::vec2(10.0, 6.0);
        style.spacing.item_spacing = egui::vec2(8.0, 8.0);
        style
            .text_styles
            .insert(egui::TextStyle::Body, egui::FontId::proportional(12.0));
        style
            .text_styles
            .insert(egui::TextStyle::Button, egui::FontId::proportional(11.0));
        style
            .text_styles
            .insert(egui::TextStyle::Monospace, egui::FontId::monospace(13.0));
    });
    let mut fonts = egui::FontDefinitions::default();
    let (proportional, monospace, mut semibold) = (Vec::new(), Vec::new(), Vec::new());
    #[cfg(windows)]
    let (mut proportional, mut monospace) = (proportional, monospace);
    // Bold and italic terminal faces, indexed by `TerminalStyle`. Slot 0 is
    // the plain face, which is the monospace family itself.
    let mut terminal_faces: [Vec<String>; 4] = Default::default();
    #[cfg(windows)]
    if let Some(windows) = std::env::var_os("WINDIR") {
        let directory = std::path::Path::new(&windows).join("Fonts");
        // Order is the priority order within each family. The terminal chain
        // is the renderer's `Consolas, "Cascadia Mono", monospace` — Cascadia
        // carries the box-drawing and braille that a TUI agent paints its
        // frames and spinners with and Consolas does not, and Segoe UI Symbol
        // backs up the rest. Without them those characters come out as tofu.
        let mut load = |file: &str, name: &str| -> Option<String> {
            let bytes = std::fs::read(directory.join(file)).ok()?;
            fonts
                .font_data
                .insert(name.into(), egui::FontData::from_owned(bytes).into());
            Some(name.to_owned())
        };
        proportional.extend(load("segoeui.ttf", "Segoe UI"));
        semibold.extend(load("seguisb.ttf", "Segoe UI Semibold"));
        for (file, name) in [
            ("consola.ttf", "Consolas"),
            ("CascadiaMono.ttf", "Cascadia Mono"),
            ("seguisym.ttf", "Segoe UI Symbol"),
        ] {
            monospace.extend(load(file, name));
        }
        for (file, name, style) in [
            ("consolab.ttf", "Consolas Bold", TerminalStyle::Bold),
            ("consolai.ttf", "Consolas Italic", TerminalStyle::Italic),
            (
                "consolaz.ttf",
                "Consolas Bold Italic",
                TerminalStyle::BoldItalic,
            ),
        ] {
            let face = load(file, name);
            terminal_faces[style as usize].extend(face);
        }
    }
    // Semibold falls back to the regular face, and every family keeps egui's
    // own fonts as its tail. Looking up a family egui has never heard of
    // panics, so the semibold family is defined even with no font to put in it.
    semibold.extend(proportional.iter().cloned());
    let mut families = vec![
        (egui::FontFamily::Proportional, proportional),
        (egui::FontFamily::Monospace, monospace.clone()),
        (semibold_family(), semibold),
    ];
    // Each styled terminal face falls back to the plain monospace chain, so a
    // glyph only Cascadia has still renders where Consolas Bold lacks it.
    for style in [
        TerminalStyle::Bold,
        TerminalStyle::Italic,
        TerminalStyle::BoldItalic,
    ] {
        let mut names = std::mem::take(&mut terminal_faces[style as usize]);
        names.extend(monospace.iter().cloned());
        families.push((style.family(), names));
    }
    for (family, mut preferred) in families {
        let installed = fonts.families.entry(family).or_default();
        preferred.append(installed);
        *installed = preferred;
    }
    ctx.set_fonts(fonts);
}

/// The four faces a terminal cell can ask for.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TerminalStyle {
    Plain = 0,
    Bold = 1,
    Italic = 2,
    BoldItalic = 3,
}

impl TerminalStyle {
    pub fn new(bold: bool, italic: bool) -> Self {
        match (bold, italic) {
            (false, false) => Self::Plain,
            (true, false) => Self::Bold,
            (false, true) => Self::Italic,
            (true, true) => Self::BoldItalic,
        }
    }

    fn family(self) -> egui::FontFamily {
        match self {
            Self::Plain => egui::FontFamily::Monospace,
            Self::Bold => egui::FontFamily::Name("mono-bold".into()),
            Self::Italic => egui::FontFamily::Name("mono-italic".into()),
            Self::BoldItalic => egui::FontFamily::Name("mono-bold-italic".into()),
        }
    }

    pub fn font(self, size: f32) -> egui::FontId {
        egui::FontId::new(size, self.family())
    }
}

fn semibold_family() -> egui::FontFamily {
    egui::FontFamily::Name("semibold".into())
}

/// The weight `font-semibold` gives an active tab or a section caption.
pub fn semibold(size: f32) -> egui::FontId {
    egui::FontId::new(size, semibold_family())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn controls_use_the_reference_palette_and_geometry() {
        let ctx = egui::Context::default();
        apply(&ctx);
        let style = ctx.style_of(egui::Theme::Dark);
        assert_eq!(
            style.visuals.widgets.inactive.weak_bg_fill,
            monochrome::SURFACE
        );
        assert_eq!(
            style.visuals.widgets.hovered.weak_bg_fill,
            monochrome::RAISED
        );
        assert_eq!(
            style.visuals.widgets.inactive.corner_radius,
            egui::CornerRadius::ZERO
        );
        assert_eq!(style.text_styles[&egui::TextStyle::Button].size, 11.0);
    }

    fn tokens_source() -> Option<String> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../src/renderer/src/ui/tokens.ts");
        std::fs::read_to_string(path).ok()
    }

    fn hex(color: Color32) -> String {
        format!("#{:02x}{:02x}{:02x}", color.r(), color.g(), color.b())
    }

    /// The native app must not drift into its own palette. Every colour here is
    /// checked against the file the renderer reads, so a change in either place
    /// fails a test rather than producing two OrcSpaces that look different.
    #[test]
    fn the_palette_matches_the_renderers_tokens() {
        let Some(source) = tokens_source() else {
            // Checked out without the renderer: nothing to contradict.
            return;
        };
        let lowered = source.to_lowercase();

        for (name, color) in [
            ("base", monochrome::BASE),
            ("terminalHeader", monochrome::TERMINAL_HEADER),
            ("surface", monochrome::SURFACE),
            ("elevated", monochrome::ELEVATED),
            ("raised", monochrome::RAISED),
            ("hairline faint", hairline::FAINT),
            ("text dim", text::DIM),
            ("text faint", text::FAINT),
            ("danger", status::DANGER),
            ("ok", status::OK),
        ] {
            assert!(
                lowered.contains(&hex(color)),
                "{name} is {} here but that value is not in tokens.ts",
                hex(color)
            );
        }
    }

    #[test]
    fn the_rail_and_sidebar_widths_match_the_tokens() {
        let Some(source) = tokens_source() else {
            return;
        };
        assert!(source.contains("railWidth: '56px'"));
        assert!(source.contains("sidebarExpanded: '200px'"));
    }

    #[test]
    fn the_widget_chrome_matches_the_frame_component() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../src/renderer/src/components/WidgetFrame.tsx");
        let Ok(source) = std::fs::read_to_string(path) else {
            return;
        };
        assert_eq!(geometry::WIDGET_RADIUS, 0.0);
        assert!(
            source.contains("h-[34px]"),
            "the header height moved; this draws {}",
            geometry::HEADER_HEIGHT
        );
    }

    /// The chrome is hueless on purpose: coloured terminal output has to be the
    /// only colour on screen.
    #[test]
    fn the_greys_are_actually_grey() {
        for color in [
            monochrome::BASE,
            monochrome::TERMINAL_HEADER,
            monochrome::SURFACE,
            monochrome::ELEVATED,
            monochrome::RAISED,
        ] {
            assert_eq!(color.r(), color.g(), "{color:?} has a tint");
            assert_eq!(color.g(), color.b(), "{color:?} has a tint");
        }
    }

    #[test]
    fn the_greys_ascend() {
        let ladder = [
            monochrome::BASE,
            monochrome::TERMINAL_HEADER,
            monochrome::SURFACE,
            monochrome::ELEVATED,
            monochrome::RAISED,
        ];
        for pair in ladder.windows(2) {
            assert!(
                pair[0].r() < pair[1].r(),
                "the surface ladder must get lighter, not darker: {:?} then {:?}",
                pair[0],
                pair[1]
            );
        }
    }
}
