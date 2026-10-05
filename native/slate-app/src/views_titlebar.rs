//! TitleBar — the shell's fixed 40px top strip (`title-bar-shell`).
//!
//! In the shipped bundle (`index-*.js`, the `TitleBar` component) the bar
//! was a three-column grid — `minmax(0,1fr) auto minmax(0,1fr)`, `h-10`
//! with `pl-2 pr-0`, `Te.surface` over a `Te.raised` bottom hairline —
//! holding:
//!
//! - **left**: the canvas-history pill (`title-bar-history-switch`:
//!   Undo/Redo, disabled as `text-white/25`), a code-view-only sidebar
//!   toggle inside `title-bar-view-switch`, a transient
//!   `orcspace:title-flash` status text (`role="status"`, 13px medium),
//!   then a `WebkitAppRegion: drag` spacer;
//! - **center**: the Workspace View `tablist` — Canvas | Code | Overview;
//! - **right**: another drag spacer, "Flip terminals" (canvas/code only),
//!   the Arrange menu, the Git pill (`title-bar-git`: branch + dirty dot
//!   + checkout panel), an `h-4 w-px` divider, and — non-macOS only, the
//!   `!vt` guard — minimize, maximize/restore and close, each a `jr`
//!   button (`h-10 w-[46px]`, close hovering `#e04343` → white).
//!
//! This port keeps the grid, the surface/hairline chrome, the divider and
//! the window controls; the rest is adapted to what this build can back:
//!
//! - **View tabs** — Slate is canvas-only, so the centre slot carries the
//!   workspace folder's name instead: the title a native title bar shows.
//! - **Arrange** — already ported, as the status bar's `arrange:` chip.
//! - **Undo/Redo, Flip terminals, Git pill** — `CanvasView::
//!   titlebar_command` only takes the five actions below; dead buttons
//!   are worse than none. `undo()`/`undo_stack`/`redo_stack` exist on
//!   `CanvasView` for when the command gains those arms.
//! - **presence** — the count is `snapshots.len()` (live terminals); the
//!   original's closest kin was the git dirty dot, so this renders the
//!   same way — a status dot + dim count — and hides at `0`.
//!
//! Every control dispatches through `CanvasView::titlebar_command`
//! (`cx.listener`, `json!({})` payloads): "sidebar" toggles
//! `prefs.sidebar_open`, "settings" opens the settings modal, "minimize"
//! → `window.minimize_window()`, "maximize" → `window.zoom_window()` — a
//! toggle, the original's `toggleMaximize` — and "close" → `cx.quit()`.
//! The controls row is compiled out on macOS, the original's `!vt` guard
//! (the traffic lights own that corner there, and the bar's left padding
//! grows to 78px to clear them). Gpui always answers minimize/zoom/close
//! on Linux; a platform that can't can gate inside `titlebar_command` via
//! `window.window_controls()`.
//!
//! The spacers and title are the `WebkitAppRegion: drag` areas: press
//! calls `window.start_window_move()` (the `_NET_WM_MOVERESIZE` /
//! `xdg_toplevel.move` path), right-press opens the native window menu
//! where the platform has one. Every handler stops propagation — a press
//! on the bar must never reach the canvas's pan/draw handlers.

use gpui::*;
use serde_json::json;
#[cfg(not(target_os = "macos"))]
use slate_app::canvas::TITLE_BAR_HEIGHT;
use slate_app::theme;

/// `jr` — a window control is the full bar height and 46px wide.
#[cfg(not(target_os = "macos"))]
const CONTROL_W: f32 = 46.0;
/// The Close hover — the shell's literal `#e04343`, never a theme token.
#[cfg(not(target_os = "macos"))]
const CLOSE_HOVER: u32 = 0xE04343;
/// `en` — the bordered pill wrap: `h-[30px] … p-[3px]` on `Te.base`.
const PILL_H: f32 = 30.0;
/// `Ft` — pill buttons were `h-[24px]` inside the wrap.
const BUTTON_H: f32 = 24.0;

/// `WebkitAppRegion: drag` — dead space that moves the window. A left
/// press hands the drag to the compositor; a right press asks for the
/// platform's title-bar menu (`window_controls().window_menu` gates it —
/// X11 reports one, minimal Wayland compositors may not).
fn drag_space(cx: &mut Context<crate::canvas_view::CanvasView>) -> Div {
    div()
        .h_full()
        .flex_1()
        .min_w(px(8.0))
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(|_this, _event: &MouseDownEvent, window, cx| {
                cx.stop_propagation();
                window.start_window_move();
            }),
        )
        .on_mouse_down(
            MouseButton::Right,
            cx.listener(|_this, event: &MouseDownEvent, window, cx| {
                cx.stop_propagation();
                if window.window_controls().window_menu {
                    window.show_window_menu(event.position);
                }
            }),
        )
}

/// `Ft` — the bar's pill button: 24px tall, rounded, dim until hover.
/// One `action` verb, dispatched with the contract's empty payload.
fn action_button(
    glyph: &'static str,
    action: &'static str,
    cx: &mut Context<crate::canvas_view::CanvasView>,
) -> Div {
    div()
        .h(px(BUTTON_H))
        .min_w(px(30.0))
        .px_2()
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded_full()
        .text_size(px(12.0))
        .font_weight(FontWeight::MEDIUM)
        .text_color(rgb(theme::hex(theme::text::DIM)))
        .cursor_pointer()
        .hover(|el| {
            el.bg(rgb(theme::hex(theme::monochrome::RAISED)))
                .text_color(rgb(theme::hex(theme::text::NORMAL)))
        })
        .child(glyph)
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(move |this, _event, window, cx| {
                cx.stop_propagation();
                this.titlebar_command(action, json!({}), window, cx);
            }),
        )
}

/// `jr` — a window-control cell: `h-10 w-[46px]`, glyph centred, the
/// faint-on-raised hover; `danger` paints the shell's red close hover.
#[cfg(not(target_os = "macos"))]
fn window_button(
    glyph: &'static str,
    action: &'static str,
    danger: bool,
    cx: &mut Context<crate::canvas_view::CanvasView>,
) -> Div {
    div()
        .h(px(TITLE_BAR_HEIGHT))
        .w(px(CONTROL_W))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(13.0))
        .text_color(rgb(theme::hex(theme::text::FAINT)))
        .cursor_pointer()
        .hover(move |el| {
            if danger {
                el.bg(rgb(CLOSE_HOVER)).text_color(rgb(0xFFFFFF))
            } else {
                el.bg(rgb(theme::hex(theme::monochrome::RAISED)))
                    .text_color(rgb(theme::hex(theme::text::NORMAL)))
            }
        })
        .child(glyph)
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(move |this, _event, window, cx| {
                cx.stop_propagation();
                this.titlebar_command(action, json!({}), window, cx);
            }),
        )
}

/// The bar. `workspace_dir` is `workspace::current()` — its basename is
/// the centre title, the full path only standing in when the basename is
/// empty (e.g. `/`). `presence_count` is the live terminal/agent count
/// the caller knows cheaply; `0` hides the badge entirely.
pub fn titlebar_pane(
    workspace_dir: &std::path::Path,
    presence_count: usize,
    cx: &mut Context<crate::canvas_view::CanvasView>,
) -> impl IntoElement {
    let workspace_name = workspace_dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| {
            let full = workspace_dir.to_string_lossy().into_owned();
            if full.is_empty() {
                "Slate".to_owned()
            } else {
                full
            }
        });

    // `title-bar-shell`: grid 1fr|auto|1fr → flex with equal flex-1
    // sides, which centres the middle column the same way. `pl-2`, macOS
    // grows it to 78px for the traffic lights (the bundle's `vt` branch).
    let bar = div()
        .size_full()
        .flex()
        .flex_row()
        .items_center()
        .overflow_hidden()
        .bg(rgb(theme::hex(theme::monochrome::SURFACE)))
        .border_b_1()
        .border_color(rgb(theme::hex(theme::hairline::SOFT)))
        .pl(px(if cfg!(target_os = "macos") { 78.0 } else { 8.0 }))
        // A press anywhere on the strip that a child didn't claim never
        // reaches the canvas's pan/draw/select handlers.
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(|_this, _event, _window, cx| {
                cx.stop_propagation();
            }),
        );

    // Left: the shell's `en` pill wrap (h-30, base bg, raised ring, 3px
    // pad). It held the history switch; here it holds the sidebar toggle —
    // the only left-side chrome the command surface supports.
    let left = div()
        .flex_1()
        .min_w_0()
        .h_full()
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .child(
            div()
                .h(px(PILL_H))
                .flex()
                .flex_row()
                .items_center()
                .rounded_full()
                .border_1()
                .border_color(rgb(theme::hex(theme::monochrome::RAISED)))
                .bg(rgb(theme::hex(theme::monochrome::BASE)))
                .px(px(3.0))
                .child(action_button("◧", "sidebar", cx)),
        )
        .child(drag_space(cx));

    // Centre: the `role="status"` slot — the workspace name instead of the
    // original's transient flash text and view tabs. 13px medium, title
    // colour, and it drags like a native title bar.
    let center = div()
        .flex_none()
        .min_w_0()
        .max_w(px(400.0))
        .flex()
        .items_center()
        .overflow_hidden()
        .child(
            div()
                .text_size(px(13.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(rgb(theme::hex(theme::text::NORMAL)))
                .truncate()
                .child(workspace_name),
        )
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(|_this, _event, window, cx| {
                cx.stop_propagation();
                window.start_window_move();
            }),
        );

    // Right: drag space, live count, settings, divider, window controls.
    let mut right = div()
        .flex_1()
        .min_w_0()
        .h_full()
        .flex()
        .flex_row()
        .items_center()
        .justify_end()
        .child(drag_space(cx));

    if presence_count > 0 {
        right = right.child(
            div()
                .flex_none()
                .h(px(BUTTON_H))
                .px_2()
                .flex()
                .flex_row()
                .items_center()
                .gap_1()
                .child(
                    div()
                        .w(px(6.0))
                        .h(px(6.0))
                        .rounded_full()
                        .bg(rgb(theme::hex(theme::status::OK))),
                )
                .child(
                    div()
                        .text_size(px(11.0))
                        .text_color(rgb(theme::hex(theme::text::FAINT)))
                        .child(format!("{presence_count} live")),
                ),
        );
    }

    right = right.child(action_button("⚙", "settings", cx));

    // `!vt` — window controls exist only off macOS, flush to the right
    // edge (`pr-0`). Separator: `mx-0.5 h-4 w-px bg-line-soft/80`.
    #[cfg(not(target_os = "macos"))]
    {
        right = right
            .child(
                div()
                    .mx(px(2.0))
                    .h(px(16.0))
                    .w(px(1.0))
                    .flex_none()
                    .bg(rgba((theme::hex(theme::hairline::SOFT) << 8) | 0xCC)),
            )
            .child(window_button("–", "minimize", false, cx))
            .child(window_button("□", "maximize", false, cx))
            .child(window_button("×", "close", true, cx));
    }

    bar.child(left).child(center).child(right)
}
