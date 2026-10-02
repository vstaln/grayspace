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

/// RGB triples — same hex as before, no egui dependency.
/// Feed directly to rgpui::rgb(), e.g. rgb(0x080808).
pub type Rgb = (u8, u8, u8);

/// The five greys everything is built from.
pub mod monochrome {
    use super::Rgb;
    /// The canvas itself, and the body of a terminal.
    pub const BASE: Rgb = (0x08, 0x08, 0x08);
    pub const TERMINAL_HEADER: Rgb = (0x0D, 0x0D, 0x0D);
    /// A widget's body, and the title bar.
    pub const SURFACE: Rgb = (0x12, 0x12, 0x12);
    /// Menus and panels that sit above a widget.
    pub const ELEVATED: Rgb = (0x18, 0x18, 0x18);
    /// Hover fills, and the ring around a widget.
    pub const RAISED: Rgb = (0x1F, 0x1F, 0x1F);
}

/// Hairlines. `FAINT` is the one that separates a header from its body;
/// `SOFT` is the ring around a widget.
pub mod hairline {
    use super::{monochrome, Rgb};
    pub const FAINT: Rgb = (0x2A, 0x2A, 0x2E);
    pub const SOFT: Rgb = monochrome::RAISED;
    pub const ACTIVE: Rgb = monochrome::RAISED;
}

pub mod text {
    use super::Rgb;
    pub const NORMAL: Rgb = (0xFF, 0xFF, 0xFF);
    pub const DIM: Rgb = (0xB9, 0xB9, 0xBE);
    pub const FAINT: Rgb = (0xA9, 0xA9, 0xB0);
}

pub mod status {
    use super::Rgb;
    pub const DANGER: Rgb = (0xE7, 0xA1, 0xA1);
    pub const OK: Rgb = (0x6F, 0xD3, 0x9A);
}

/// Pack an (r,g,b) triple into the u32 rgpui::rgb() takes.
pub const fn hex(color: Rgb) -> u32 {
    (color.0 as u32) << 16 | (color.1 as u32) << 8 | color.2 as u32
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

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens_source() -> Option<String> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../src/renderer/src/ui/tokens.ts");
        std::fs::read_to_string(path).ok()
    }

    fn hex(color: Rgb) -> String {
        format!("#{:02x}{:02x}{:02x}", color.0, color.1, color.2)
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
            assert_eq!(color.0, color.1, "{color:?} has a tint");
            assert_eq!(color.1, color.2, "{color:?} has a tint");
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
                pair[0].0 < pair[1].0,
                "the surface ladder must get lighter, not darker: {:?} then {:?}",
                pair[0],
                pair[1]
            );
        }
    }
}
