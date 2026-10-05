//! Reordering every canvas widget the way the TitleBar's arrange menu did.
//!
//! Ports `src/renderer/src/lib/canvasLayout.ts`: Grid deals equal cells,
//! Tiny lays fixed 300×200 cards as many per row as fit, Focus gives one
//! widget a large column and stacks the rest beside it, and Free restores
//! the pre-arrange snapshot — it has no geometry, so `layout` returns an
//! empty vec for it and the caller replays what it saved.
//!
//! Pure geometry only: the caller diffs the returned rects into journaled
//! `widget.update`s (with `maximized: false`, as the renderer's arrange
//! update did). Nothing is filtered out here — the original arranged
//! maximized widgets too (the update un-maximized them), and Slate widgets
//! carry no minimized flag.

use crate::canvas::{
    clamp_widget_size, title_bar_world_y, Vec2, MIN_WIDGET_H, MIN_WIDGET_W, TITLE_BAR_HEIGHT,
};
use crate::projection::{Camera, CanvasState, Widget};

/// One arranged widget: `(id, x, y, w, h)` in world units, all rounded.
pub type Arranged = (String, f64, f64, f64, f64);

/// canvasLayout.ts `GAP` — world units between tiles and around the area's
/// edge (`ct` in the shipped bundle).
const GAP: f64 = 16.0;

/// canvasLayout.ts `TINY_W` — the fixed card width Tiny mode tiles (`oa`).
const TINY_W: f64 = 300.0;

/// canvasLayout.ts `TINY_H` — the fixed card height Tiny mode tiles, and the
/// floor Focus gives each side-stacked widget (`ia`).
const TINY_H: f64 = 200.0;

/// canvasLayout.ts `FOCUS_RATIO` — the share of the arrange area's width the
/// focused widget's column takes in Focus mode (`su`).
const FOCUS_RATIO: f64 = 0.7;

/// App.tsx `DOCK_H` — the bottom dock strip the arrange area stops above;
/// the viewport height loses `TITLE_BAR_HEIGHT + DOCK_H` before tiling (`ya`).
const DOCK_H: f64 = 88.0;

/// The shell's canvas arrange modes — `eu` in the bundle, persisted as the
/// `orcspace-arrange-mode` string. This is the canvas menu (`Vd`), not the
/// Code view's `auto/grid/columns/rows/focus` — that one is `code_layout`.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArrangeMode {
    /// `free` — back to where the user dragged them. The default.
    #[default]
    Free,
    /// `grid` — equal tiles in a square-ish grid.
    Grid,
    /// `tiny` — fixed 300×200 cards, as many per row as fit.
    Tiny,
    /// `focus` — one widget large on the left, the rest stacked beside it.
    Focus,
}

impl ArrangeMode {
    /// Menu order in the renderer (`Vd`): the computed modes first, Free last.
    pub const ALL: [Self; 4] = [Self::Grid, Self::Tiny, Self::Focus, Self::Free];

    pub fn label(self) -> &'static str {
        match self {
            Self::Grid => "Grid",
            Self::Tiny => "Tiny",
            Self::Focus => "Focus",
            Self::Free => "Free",
        }
    }

    /// The TitleBar menu's one-line hint for the mode.
    pub fn hint(self) -> &'static str {
        match self {
            Self::Grid => "Equal tiles in a square grid",
            Self::Tiny => "Small tiles, as many per row as fit",
            Self::Focus => "Active widget large, the rest beside it",
            Self::Free => "Back to where you dragged them",
        }
    }
}

/// App.tsx's arrange handler — the world-space rect the widgets tile into:
/// the visible region under the title bar and above the dock. `viewport` is
/// the canvas view size in *screen* px (`mainSize` in the renderer); the
/// camera divides it into world units here, so `layout`'s caller never does.
///
/// Bundle: `{ x: -cam.x/zoom, y: (40 - cam.y)/zoom, w: vw/zoom,
/// h: max(0, vh - 40 - 88)/zoom }` — the same `title_bar_world_y` canvas.rs
/// already ports for the top edge.
fn arrange_area(camera: &Camera, viewport: Vec2) -> (f64, f64, f64, f64) {
    // `je.zoom || 1`: a falsy zoom (0, NaN) means 1, not a divide-by-zero.
    let zoom = if camera.zoom == 0.0 || camera.zoom.is_nan() {
        1.0
    } else {
        camera.zoom
    };
    (
        -camera.x / zoom,
        title_bar_world_y(camera.y, zoom),
        viewport.x as f64 / zoom,
        (viewport.y as f64 - TITLE_BAR_HEIGHT as f64 - DOCK_H).max(0.0) / zoom,
    )
}

/// canvasLayout.ts `er` — one widget's rect: the size is kind-clamped, the
/// position is not, and every emitted field is rounded to a whole world unit.
fn rect_for(widget: &Widget, x: f64, y: f64, w: f64, h: f64) -> Arranged {
    let (w, h) = clamp_widget_size(widget.kind.as_deref(), w, h);
    (
        widget.id.clone(),
        x.round(),
        y.round(),
        w.round(),
        h.round(),
    )
}

/// canvasLayout.ts `la` — `widgets` into `cols` columns of `cell` size,
/// GAP-inset from the origin and GAP-pitched. The pitch uses the unclamped
/// cell size; `rect_for` clamps only the size each widget is emitted with.
fn tile(
    widgets: &[&Widget],
    origin: (f64, f64),
    cols: usize,
    cell_w: f64,
    cell_h: f64,
) -> Vec<Arranged> {
    widgets
        .iter()
        .enumerate()
        .map(|(i, widget)| {
            let col = (i % cols) as f64;
            let row = (i / cols) as f64;
            rect_for(
                widget,
                origin.0 + GAP + col * (cell_w + GAP),
                origin.1 + GAP + row * (cell_h + GAP),
                cell_w,
                cell_h,
            )
        })
        .collect()
}

/// canvasLayout.ts's arrange entry — every widget gets a rect in world units.
///
/// Order is the original's: widgets sort by `z` ascending (stable, so ties
/// keep insertion order) and tile in that order; Focus emits the big widget
/// first, then the stack in z order.
///
/// `focused` is the widget Focus enlarges; `None` — or an id not on the
/// canvas — falls back to the topmost, the last in z order, matching the
/// original's `sorted.find(w => w.id === focused) ?? sorted[len - 1]`.
///
/// `Free` computes nothing — it is the put-them-back mode, so this returns
/// an empty vec and the caller restores the snapshot it saved before the
/// last arrange (the renderer's `orcspace-arrange-free-layout` map).
pub fn layout(
    mode: ArrangeMode,
    canvas: &CanvasState,
    viewport: Vec2,
    focused: Option<&str>,
) -> Vec<Arranged> {
    let (ax, ay, aw, ah) = arrange_area(&canvas.camera, viewport);
    if mode == ArrangeMode::Free || canvas.widgets.is_empty() || aw <= 0.0 || ah <= 0.0 {
        return Vec::new();
    }

    // The z pass: ascending z, stable — the renderer's
    // `slice().sort((a, b) => a.z - b.z)`.
    let mut sorted: Vec<&Widget> = canvas.widgets.values().collect();
    sorted.sort_by(|a, b| a.z.partial_cmp(&b.z).unwrap_or(std::cmp::Ordering::Equal));
    let origin = (ax, ay);

    match mode {
        ArrangeMode::Free => Vec::new(),
        ArrangeMode::Tiny => {
            // `tiny`: fixed 300×200 cards, `max(1, floor((w - GAP)/(300 + GAP)))`
            // columns — extra rows run past the bottom, as the original let them.
            let cols = ((aw - GAP) / (TINY_W + GAP)).floor().max(1.0) as usize;
            tile(&sorted, origin, cols, TINY_W, TINY_H)
        }
        ArrangeMode::Focus => {
            // `focus`: the focused (or topmost) widget takes ~70% of the width
            // on the left; the rest split the side column's height evenly.
            let main = sorted
                .iter()
                .copied()
                .find(|w| Some(w.id.as_str()) == focused)
                .unwrap_or_else(|| *sorted.last().unwrap());
            let rest: Vec<&Widget> = sorted.iter().copied().filter(|w| w.id != main.id).collect();
            let inner_w = aw - GAP * 2.0;
            let inner_h = ah - GAP * 2.0;
            if rest.is_empty() {
                return vec![rect_for(main, ax + GAP, ay + GAP, inner_w, inner_h)];
            }
            let main_w = ((inner_w - GAP) * FOCUS_RATIO).round().max(MIN_WIDGET_W);
            let side_w = (inner_w - GAP - main_w).max(MIN_WIDGET_W);
            let side_h = ((inner_h - GAP * (rest.len() as f64 - 1.0)) / rest.len() as f64)
                .floor()
                .max(TINY_H);
            // The side column's x uses the pre-clamp main width, as `er`'s
            // caller did — kind caps shrink the emitted size, never the pitch.
            let side_x = ax + GAP + main_w + GAP;
            let mut out = Vec::with_capacity(rest.len() + 1);
            out.push(rect_for(main, ax + GAP, ay + GAP, main_w, inner_h));
            out.extend(rest.iter().enumerate().map(|(i, widget)| {
                rect_for(
                    widget,
                    side_x,
                    ay + GAP + i as f64 * (side_h + GAP),
                    side_w,
                    side_h,
                )
            }));
            out
        }
        ArrangeMode::Grid => {
            // `grid`: `ceil(sqrt(n))` columns, rows to fit, cells splitting
            // the area evenly after a GAP per column/row plus the edge inset.
            let cols = (sorted.len() as f64).sqrt().ceil().max(1.0) as usize;
            let rows = sorted.len().div_ceil(cols) as f64;
            let cell_w = ((aw - GAP * (cols as f64 + 1.0)) / cols as f64)
                .floor()
                .max(MIN_WIDGET_W);
            let cell_h = ((ah - GAP * (rows + 1.0)) / rows).floor().max(MIN_WIDGET_H);
            tile(&sorted, origin, cols, cell_w, cell_h)
        }
    }
}
