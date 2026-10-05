//! The Browser tab: a single fixed-URL pane on the vendored wry element.
//!
//! Address-bar input + multi-tab are explicitly out for 0.0.1 — one tab,
//! one URL. The vendored element keeps its guarantees (400x300 fallback,
//! >1px guard, Logical bounds, per-id create-once/move-later, X11 child
//! > thread); Wayland renders a separate GTK window (accepted per spec).

use gpui::*;

pub struct BrowserState {
    pub url: String,
    pub id: usize,
}

impl Default for BrowserState {
    fn default() -> Self {
        Self::new("https://example.com", crate::next_webview_id())
    }
}

impl BrowserState {
    pub fn new(url: impl Into<String>, id: usize) -> Self {
        Self {
            url: url.into(),
            id,
        }
    }

    pub fn render(&self, cx: &mut Context<crate::canvas_view::CanvasView>) -> impl IntoElement {
        use gpui::Styled as _;
        // One fixed URL and no address bar: nothing here writes pane state,
        // so the context is accepted for signature uniformity but unused.
        let _ = cx;
        // Same contract as the vendored element: drain externally-closed ids
        // every render so stale entries never linger in the model.
        for closed in crate::drain_closed_webviews() {
            if closed == self.id {
                // The window manager closed our pane; the next paint recreates
                // it per-id create-once/move-later from the same URL.
            }
        }
        div().size_full().flex().flex_col().child(
            crate::webview_element(self.id, self.url.clone())
                .w(px(1100.))
                .h(px(700.))
                .flex_1(),
        )
    }
}
