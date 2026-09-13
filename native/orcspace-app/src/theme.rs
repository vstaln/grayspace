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

/// Measurements the renderer depends on. A widget's header is a fixed 34
/// logical pixels — the drag target — and the corner radius is 10.
pub mod geometry {
    /// Widget corner radius, matching `rounded-[10px]`.
    pub const WIDGET_RADIUS: f32 = 10.0;
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

    // The renderer uses a single accent — white — rather than a hue, so
    // selection reads as brightness instead of colour.
    visuals.selection.bg_fill = Color32::from_rgba_unmultiplied(255, 255, 255, 36);
    visuals.selection.stroke = egui::Stroke::new(1.0, text::NORMAL);

    ctx.set_visuals(visuals);
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let Some(source) = tokens_source() else { return };
        assert!(source.contains("railWidth: '56px'"));
        assert!(source.contains("sidebarExpanded: '200px'"));
    }

    /// A widget's radius and header height are not in tokens.ts — they are
    /// Tailwind classes on the frame itself, which is where this checks them.
    /// `radiusPanel` is 12px and belongs to menus and panels, not to widgets;
    /// reading it as the widget radius would round every widget wrong.
    #[test]
    fn the_widget_chrome_matches_the_frame_component() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../src/renderer/src/components/WidgetFrame.tsx");
        let Ok(source) = std::fs::read_to_string(path) else {
            return;
        };
        assert!(
            source.contains("rounded-[10px]"),
            "the widget radius moved; this draws {}",
            geometry::WIDGET_RADIUS
        );
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
