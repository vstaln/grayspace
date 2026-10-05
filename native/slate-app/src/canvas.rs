//! Drawing the canvas the way Slate draws it.
//!
//! Replaces a decorative placeholder. What matters here is that the chrome is
//! the *same* chrome: the palette comes from `theme`, which is pinned against
//! the renderer's tokens, and the widget frame reproduces what
//! `WidgetFrame.tsx` builds — a 10px-rounded body on `surface`, a 34px header
//! separated by a hairline, a one-pixel ring that brightens when the widget is
//! active.
//!
//! The camera model matches the renderer's too: a world-space position scaled
//! and translated to screen, so a canvas saved by either implementation opens
//! in the same place at the same zoom.

use crate::projection::{Camera, CanvasState, Widget};
use crate::theme::{geometry, status, text, Rgb};

/// Minimal 2D geometry — replaces egui's Pos2/Rect/Vec2 at this boundary.
/// Same semantics (y-down, inclusive contains), so the camera maths and its
/// tests are unchanged; only the egui painters are gone.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Pos2 {
    pub x: f32,
    pub y: f32,
}

impl Pos2 {
    pub const ZERO: Self = Self { x: 0.0, y: 0.0 };

    pub const fn new(x: f32, y: f32) -> Self {
        Self { x, y }
    }
}

impl std::ops::Sub for Pos2 {
    type Output = Vec2;

    fn sub(self, other: Self) -> Vec2 {
        Vec2 {
            x: self.x - other.x,
            y: self.y - other.y,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Vec2 {
    pub x: f32,
    pub y: f32,
}

impl Vec2 {
    pub const fn new(x: f32, y: f32) -> Self {
        Self { x, y }
    }

    pub const fn splat(v: f32) -> Self {
        Self { x: v, y: v }
    }

    pub fn length(self) -> f32 {
        self.x.hypot(self.y)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub min: Pos2,
    pub max: Pos2,
}

impl Rect {
    pub fn from_min_size(min: Pos2, size: Vec2) -> Self {
        Self {
            min,
            max: Pos2::new(min.x + size.x, min.y + size.y),
        }
    }

    pub fn from_min_max(min: Pos2, max: Pos2) -> Self {
        Self { min, max }
    }

    pub fn width(self) -> f32 {
        self.max.x - self.min.x
    }

    pub fn height(self) -> f32 {
        self.max.y - self.min.y
    }

    pub fn left(self) -> f32 {
        self.min.x
    }

    pub fn right(self) -> f32 {
        self.max.x
    }

    pub fn top(self) -> f32 {
        self.min.y
    }

    pub fn bottom(self) -> f32 {
        self.max.y
    }

    pub fn center(self) -> Pos2 {
        Pos2::new(
            (self.min.x + self.max.x) / 2.0,
            (self.min.y + self.max.y) / 2.0,
        )
    }

    pub fn contains(self, p: Pos2) -> bool {
        self.min.x <= p.x && p.x <= self.max.x && self.min.y <= p.y && p.y <= self.max.y
    }

    pub fn contains_rect(self, other: Self) -> bool {
        self.min.x <= other.min.x
            && other.max.x <= self.max.x
            && self.min.y <= other.min.y
            && other.max.y <= self.max.y
    }

    pub fn intersects(self, other: Self) -> bool {
        self.min.x < other.max.x
            && other.min.x < self.max.x
            && self.min.y < other.max.y
            && other.min.y < self.max.y
    }

    pub fn intersect(self, other: Self) -> Self {
        Self {
            min: Pos2::new(self.min.x.max(other.min.x), self.min.y.max(other.min.y)),
            max: Pos2::new(self.max.x.min(other.max.x), self.max.y.min(other.max.y)),
        }
    }

    pub fn is_positive(self) -> bool {
        self.min.x < self.max.x && self.min.y < self.max.y
    }

    pub fn expand2(self, margin: Vec2) -> Self {
        Self {
            min: Pos2::new(self.min.x - margin.x, self.min.y - margin.y),
            max: Pos2::new(self.max.x + margin.x, self.max.y + margin.y),
        }
    }
}

/// The renderer clamps zoom to this range (`sanitizeCamera`), so a canvas
/// written here cannot open out of range there.
pub const MIN_ZOOM: f32 = 0.2;
pub const MAX_ZOOM: f32 = 4.0;

/// types.ts `MIN_W`/`MIN_H` — the floor every resize and spawn respects.
pub const MIN_WIDGET_W: f64 = 280.0;
pub const MIN_WIDGET_H: f64 = 160.0;

/// types.ts `WIDGET_MAX_SIZE` — the per-kind ceiling. Kinds not listed have
/// no cap, so a missing entry means no bound, not a default.
fn max_widget_size(kind: Option<&str>) -> (f64, f64) {
    match kind {
        Some("files") => (760.0, 620.0),
        Some("orchestration") => (760.0, 720.0),
        _ => (f64::INFINITY, f64::INFINITY),
    }
}

/// types.ts `clampWidgetSize`: floor at the widget minimums, ceiling at the
/// kind's cap. Callers must clamp the size FIRST and derive x/y from the
/// clamped result — deriving the position from the unclamped size and only
/// then applying the cap is the documented Electron bug that let a capped
/// widget's anchored corner keep travelling on west/north drags and slid
/// the whole widget across the canvas.
pub fn clamp_widget_size(kind: Option<&str>, w: f64, h: f64) -> (f64, f64) {
    let (max_w, max_h) = max_widget_size(kind);
    (w.clamp(MIN_WIDGET_W, max_w), h.clamp(MIN_WIDGET_H, max_h))
}

/// types.ts `NON_MAXIMIZABLE`: orchestration's fleet UI does not want the
/// fullscreen treatment, so its header draws a disabled maximize button.
pub fn non_maximizable(kind: Option<&str>) -> bool {
    kind == Some("orchestration")
}

/// The floating title bar's height in screen px (`TITLE_BAR_HEIGHT` in
/// App.tsx): widgets never park their top edge under it.
pub const TITLE_BAR_HEIGHT: f32 = 40.0;

/// App.tsx `titleBarWorldY` — the world-y of the title band's bottom edge
/// for this camera.
pub fn title_bar_world_y(camera_y: f64, zoom: f64) -> f64 {
    (TITLE_BAR_HEIGHT as f64 - camera_y) / zoom.max(0.0001)
}

/// App.tsx `clampToVisibleWorld`: a spawn point clamped into the visible
/// world so a fresh widget never opens fully off-screen. `point` is the
/// desired top-left in world units, `viewport` the screen size in px.
/// Margins are 32/zoom px of breathing room, and the top edge also stays
/// below the title band (`titleBarWorldY`), whichever is lower.
pub fn clamp_to_visible_world(
    camera: &Camera,
    viewport: Vec2,
    point: Pos2,
    w: f64,
    h: f64,
) -> Pos2 {
    let zoom = (camera.zoom as f32).max(0.0001);
    let margin = 32.0 / zoom;
    let min_x = (-camera.x as f32) / zoom + margin;
    let min_y =
        ((-camera.y as f32) / zoom + margin).max(title_bar_world_y(camera.y, zoom as f64) as f32);
    let max_x = (viewport.x - camera.x as f32) / zoom
        - margin
        - (w as f32).min(viewport.x / zoom - margin * 2.0);
    let max_y = (viewport.y - camera.y as f32) / zoom
        - margin
        - (h as f32).min(viewport.y / zoom - margin * 2.0);
    Pos2::new(
        if max_x >= min_x {
            point.x.clamp(min_x, max_x)
        } else {
            min_x
        },
        if max_y >= min_y {
            point.y.clamp(min_y, max_y)
        } else {
            min_y
        },
    )
}

/// World-space grid pitch, before zoom.
#[allow(dead_code)]
const GRID_PITCH: f32 = 48.0;

/// Maps between world coordinates — what is stored — and screen pixels.
#[derive(Debug, Clone, Copy)]
pub struct View {
    pub camera_x: f32,
    pub camera_y: f32,
    pub zoom: f32,
    pub origin: Pos2,
}

impl View {
    pub fn new(camera: &Camera, origin: Pos2) -> Self {
        Self {
            camera_x: camera.x as f32,
            camera_y: camera.y as f32,
            zoom: (camera.zoom as f32).clamp(MIN_ZOOM, MAX_ZOOM),
            origin,
        }
    }

    /// `translate(camera) scale(zoom)`, the same order the renderer applies in
    /// its transform — scaling first and translating after would move a widget
    /// by the camera offset *times* the zoom.
    pub fn to_screen(&self, world: Pos2) -> Pos2 {
        Pos2::new(
            self.origin.x + self.camera_x + world.x * self.zoom,
            self.origin.y + self.camera_y + world.y * self.zoom,
        )
    }

    pub fn to_world(&self, screen: Pos2) -> Pos2 {
        Pos2::new(
            (screen.x - self.origin.x - self.camera_x) / self.zoom,
            (screen.y - self.origin.y - self.camera_y) / self.zoom,
        )
    }

    pub fn widget_rect(&self, widget: &Widget) -> Rect {
        let top_left = self.to_screen(Pos2::new(widget.x as f32, widget.y as f32));
        Rect::from_min_size(
            top_left,
            Vec2::new(widget.w as f32 * self.zoom, widget.h as f32 * self.zoom),
        )
    }
}

/// Whether a widget can be skipped this frame.
///
/// The renderer keeps three screens of margin rather than culling at the
/// viewport edge, because unmounting a terminal there tears down its pty and
/// replays its scrollback on the way back — so an ordinary pan would rebuild
/// every terminal it passed. Nothing is torn down here, but the margin is kept
/// so the two agree about what is on screen.
pub fn is_visible(rect: Rect, viewport: Rect) -> bool {
    let margin = Vec2::new(viewport.width() * 3.0, viewport.height() * 3.0);
    viewport.expand2(margin).intersects(rect)
}

pub struct CanvasFrame<'a> {
    pub state: &'a CanvasState,
    pub active_widget: Option<&'a str>,
}

/// Rough character-count elide. A renderer can measure text exactly; without
/// one a widget title is short enough that the approximation never visibly
/// overflows.
#[allow(dead_code)]
fn elide(title: &str, width: f32, font_size: f32) -> String {
    let usable = (width - 20.0).max(0.0);
    let per_char = font_size * 0.55;
    let fits = if per_char > 0.0 {
        (usable / per_char) as usize
    } else {
        0
    };
    if title.chars().count() <= fits {
        return title.to_owned();
    }
    if fits <= 1 {
        return String::new();
    }
    let head: String = title.chars().take(fits - 1).collect();
    format!("{head}…")
}

/// Status text for the corner readout.
pub fn zoom_label(view: &View) -> String {
    format!("{:.0}%", view.zoom * 100.0)
}

/// The colour a run's state should read as, so the two implementations agree
/// about what "failed" looks like.
pub fn outcome_color(outcome: Option<&str>) -> Rgb {
    match outcome {
        Some("succeeded") => status::OK,
        Some("failed") => status::DANGER,
        _ => text::DIM,
    }
}

pub fn widget_at<'a>(state: &'a CanvasState, view: &View, pointer: Pos2) -> Option<&'a Widget> {
    state
        .widgets
        .values()
        .filter(|widget| view.widget_rect(widget).contains(pointer))
        .max_by(|a, b| a.z.total_cmp(&b.z))
}

#[derive(Debug, PartialEq)]
pub enum DragTarget {
    Pan,
    Widget(String),
    Content,
}

pub fn drag_target(state: &CanvasState, view: &View, pointer: Pos2) -> DragTarget {
    match widget_at(state, view, pointer) {
        None => DragTarget::Pan,
        Some(widget) => {
            let rect = view.widget_rect(widget);
            if !widget.maximized && pointer.y < rect.top() + geometry::HEADER_HEIGHT * view.zoom {
                DragTarget::Widget(widget.id.clone())
            } else {
                DragTarget::Content
            }
        }
    }
}

pub fn zoom_at(camera: &mut Camera, origin: Pos2, pointer: Pos2, factor: f32) {
    if !factor.is_finite() || factor <= 0.0 {
        return;
    }
    let old = View::new(camera, origin);
    let world = old.to_world(pointer);
    let zoom = (old.zoom * factor).clamp(MIN_ZOOM, MAX_ZOOM);
    camera.zoom = zoom as f64;
    camera.x = (pointer.x - origin.x - world.x * zoom) as f64;
    camera.y = (pointer.y - origin.y - world.y * zoom) as f64;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pointer_anchored_zoom_preserves_world_position_at_both_limits() {
        let origin = Pos2::new(56.0, 40.0);
        let pointer = Pos2::new(713.0, 492.0);
        let mut camera = Camera {
            x: -321.0,
            y: 87.0,
            zoom: 1.3,
        };
        let world = View::new(&camera, origin).to_world(pointer);
        for factor in [1.2, 100.0, 0.0001, 2.0] {
            zoom_at(&mut camera, origin, pointer, factor);
            let actual = View::new(&camera, origin).to_screen(world);
            assert!((actual - pointer).length() < 0.001);
            assert!((MIN_ZOOM as f64..=MAX_ZOOM as f64).contains(&camera.zoom));
        }
    }

    #[test]
    fn invalid_zoom_gestures_do_not_corrupt_saved_camera() {
        let mut camera = Camera {
            x: 12.0,
            y: 34.0,
            zoom: 1.0,
        };
        for factor in [f32::NAN, f32::INFINITY, 0.0, -1.0] {
            zoom_at(&mut camera, Pos2::ZERO, Pos2::ZERO, factor);
            assert_eq!((camera.x, camera.y, camera.zoom), (12.0, 34.0, 1.0));
        }
    }

    fn view(zoom: f64, x: f64, y: f64) -> View {
        View::new(&Camera { x, y, zoom }, Pos2::ZERO)
    }

    #[test]
    fn a_world_point_round_trips_through_the_screen() {
        let view = view(1.7, -320.0, 88.5);
        let world = Pos2::new(1234.5, -67.25);
        let back = view.to_world(view.to_screen(world));
        assert!((back.x - world.x).abs() < 0.001, "{back:?}");
        assert!((back.y - world.y).abs() < 0.001, "{back:?}");
    }

    /// Translate then scale. The other order moves a widget by the camera
    /// offset multiplied by the zoom, which looks like drift that gets worse
    /// the further you zoom in.
    #[test]
    fn the_camera_offset_is_not_scaled_by_the_zoom() {
        let at_one = view(1.0, 100.0, 0.0).to_screen(Pos2::ZERO);
        let at_two = view(2.0, 100.0, 0.0).to_screen(Pos2::ZERO);
        assert_eq!(at_one.x, at_two.x, "the origin must not move when zooming");
    }

    #[test]
    fn zoom_is_clamped_to_the_range_the_renderer_accepts() {
        assert_eq!(view(99.0, 0.0, 0.0).zoom, MAX_ZOOM);
        assert_eq!(view(0.001, 0.0, 0.0).zoom, MIN_ZOOM);
    }

    #[test]
    fn panning_moves_the_camera_and_zooming_stays_in_range() {
        let mut camera = Camera {
            x: 0.0,
            y: 0.0,
            zoom: 1.0,
        };
        for _ in 0..100 {
            camera.zoom = (camera.zoom * 2.0).min(MAX_ZOOM as f64);
        }
        assert_eq!(camera.zoom, MAX_ZOOM as f64);
    }

    /// Three screens of margin, matching the renderer — culling at the edge is
    /// what made an ordinary pan rebuild every terminal it passed.
    #[test]
    fn culling_keeps_three_screens_of_margin() {
        let viewport = Rect::from_min_size(Pos2::ZERO, Vec2::new(1000.0, 800.0));

        let just_offscreen = Rect::from_min_size(Pos2::new(1100.0, 0.0), Vec2::new(100.0, 100.0));
        assert!(is_visible(just_offscreen, viewport), "must stay mounted");

        let far_away = Rect::from_min_size(Pos2::new(9000.0, 0.0), Vec2::new(100.0, 100.0));
        assert!(!is_visible(far_away, viewport), "must be culled");
    }

    #[test]
    fn a_widget_rect_scales_with_the_zoom() {
        let widget = test_widget();
        let rect = view(2.0, 0.0, 0.0).widget_rect(&widget);
        assert_eq!(rect.width(), 1240.0);
        assert_eq!(rect.height(), 760.0);
        assert_eq!(rect.min, Pos2::new(200.0, 100.0));
    }

    fn test_widget() -> Widget {
        Widget {
            id: "w1".into(),
            title: "Terminal".into(),
            kind: Some("terminal".into()),
            x: 100.0,
            y: 50.0,
            w: 620.0,
            h: 380.0,
            z: 1.0,
            maximized: false,
            image_path: None,
            image_name: None,
            state: None,
            version: 1.0,
            updated_at: 0.0,
        }
    }

    #[test]
    fn drag_distinguishes_header_content_and_background_at_every_zoom() {
        let mut state = CanvasState::default();
        let widget = test_widget();
        state.widgets.insert(widget.id.clone(), widget);
        for zoom in [0.2, 1.0, 4.0] {
            let view = view(zoom, 57.0, -123.0);
            assert_eq!(
                drag_target(&state, &view, view.to_screen(Pos2::new(110.0, 60.0))),
                DragTarget::Widget("w1".into())
            );
            assert_eq!(
                drag_target(&state, &view, view.to_screen(Pos2::new(110.0, 150.0))),
                DragTarget::Content
            );
            assert_eq!(
                drag_target(&state, &view, view.to_screen(Pos2::ZERO)),
                DragTarget::Pan
            );
        }
    }

    #[test]
    fn picking_respects_z_order_and_last_painted_ties() {
        let mut state = CanvasState::default();
        let first = test_widget();
        let mut second = first.clone();
        second.id = "w2".into();
        state.widgets.insert(first.id.clone(), first);
        state.widgets.insert(second.id.clone(), second);
        let view = view(1.0, 0.0, 0.0);
        let pointer = Pos2::new(110.0, 60.0);
        assert_eq!(widget_at(&state, &view, pointer).unwrap().id, "w2");
        state.widgets.get_mut("w1").unwrap().z = 3.0;
        assert_eq!(widget_at(&state, &view, pointer).unwrap().id, "w1");
        state.widgets.get_mut("w1").unwrap().maximized = true;
        assert_eq!(drag_target(&state, &view, pointer), DragTarget::Content);
    }

    #[test]
    fn a_title_that_fits_is_left_alone() {
        assert_eq!(elide("Maks", 600.0, 12.0), "Maks");
    }

    #[test]
    fn a_long_title_is_elided_rather_than_overflowing() {
        let elided = elide(&"x".repeat(200), 120.0, 12.0);
        assert!(elided.ends_with('…'));
        assert!(elided.chars().count() < 200);
    }

    #[test]
    fn a_title_with_no_room_renders_nothing_rather_than_an_ellipsis() {
        assert_eq!(elide("anything", 18.0, 12.0), "");
    }

    #[test]
    fn outcomes_read_as_the_shared_status_colours() {
        assert_eq!(outcome_color(Some("succeeded")), status::OK);
        assert_eq!(outcome_color(Some("failed")), status::DANGER);
        assert_eq!(outcome_color(None), text::DIM);
    }

    #[test]
    fn the_zoom_label_is_a_whole_percentage() {
        assert_eq!(zoom_label(&view(1.0, 0.0, 0.0)), "100%");
        assert_eq!(zoom_label(&view(2.5, 0.0, 0.0)), "250%");
    }

    #[test]
    fn size_clamps_to_the_floor_and_the_per_kind_ceiling() {
        assert_eq!(
            clamp_widget_size(Some("terminal"), 10.0, 10.0),
            (MIN_WIDGET_W, MIN_WIDGET_H)
        );
        assert_eq!(
            clamp_widget_size(Some("files"), 5000.0, 5000.0),
            (760.0, 620.0)
        );
        assert_eq!(
            clamp_widget_size(Some("orchestration"), 5000.0, 5000.0),
            (760.0, 720.0)
        );
        // Uncapped kinds keep whatever size they grow to past the floor.
        assert_eq!(
            clamp_widget_size(Some("terminal"), 5000.0, 5000.0),
            (5000.0, 5000.0)
        );
        assert_eq!(clamp_widget_size(None, 5000.0, 5.0), (5000.0, MIN_WIDGET_H));
    }

    #[test]
    fn only_orchestration_refuses_to_maximize() {
        assert!(non_maximizable(Some("orchestration")));
        assert!(!non_maximizable(Some("terminal")));
        assert!(!non_maximizable(Some("files")));
        assert!(!non_maximizable(None));
    }

    #[test]
    fn spawn_clamp_keeps_widgets_inside_the_visible_world() {
        let camera = Camera {
            x: 0.0,
            y: 0.0,
            zoom: 1.0,
        };
        let viewport = Vec2::new(1200.0, 800.0);

        // Past the right edge: pulled back to the 32px margin.
        let p = clamp_to_visible_world(&camera, viewport, Pos2::new(5000.0, 5000.0), 680.0, 420.0);
        assert_eq!(p.x, 1200.0 - 32.0 - 680.0);
        assert_eq!(p.y, 800.0 - 32.0 - 420.0);

        // Above the canvas: dropped to the title band, below the plain margin.
        let p = clamp_to_visible_world(&camera, viewport, Pos2::new(100.0, -9000.0), 680.0, 420.0);
        assert_eq!(p.y, TITLE_BAR_HEIGHT);

        // An in-bounds point survives untouched.
        let p = clamp_to_visible_world(&camera, viewport, Pos2::new(200.0, 100.0), 680.0, 420.0);
        assert_eq!(p, Pos2::new(200.0, 100.0));
    }
}
