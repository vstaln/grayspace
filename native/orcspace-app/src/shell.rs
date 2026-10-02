use rgpui::*;
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT_WV_ID: AtomicUsize = AtomicUsize::new(1);

const TABS: [&str; 5] = ["Terminal", "Planner", "Files", "Browser", "Orchestration"];

pub struct RootView {
    focus: FocusHandle,
    active: usize,
    #[allow(dead_code)]
    browser_url: String,
    #[allow(dead_code)]
    browser_id: usize,
}

impl Focusable for RootView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl RootView {
    pub fn new(cx: &mut Context<Self>) -> Self {
        Self {
            focus: cx.focus_handle(),
            active: 0,
            browser_url: "https://example.com".into(),
            browser_id: NEXT_WV_ID.fetch_add(1, Ordering::Relaxed),
        }
    }
}

impl Render for RootView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mut strip = div()
            .h(px(32.))
            .flex()
            .flex_row()
            .items_center()
            .gap_2()
            .px_2()
            .bg(rgb(0x181825));
        for (i, label) in TABS.iter().enumerate() {
            let mine = i == self.active;
            strip = strip.child(
                div()
                    .id(("grayspace-tab", i))
                    .px_2()
                    .py_1()
                    .rounded_md()
                    .cursor_pointer()
                    .text_sm()
                    .text_color(if mine { rgb(0xffffff) } else { rgb(0xa6adc8) })
                    .bg(if mine { rgb(0x45475a) } else { rgb(0x00000000) })
                    .child(label.to_string())
                    .on_click(cx.listener(move |this: &mut Self, _, _, cx| {
                        this.active = i;
                        cx.notify();
                    })),
            );
        }
        div().size_full().flex().flex_col().child(strip).child(
            div().flex_1().p_2().text_color(rgb(0xa6adc8)).text_sm().child(
                // Task 4 replaces each string with the real rgpui view.
                match self.active {
                    0 => "Terminal — engine snapshots render here (Task 4)",
                    1 => "Planner — PlannerDocument items render here (Task 4)",
                    2 => "Files — workspace browser renders here (Task 4)",
                    3 => "Browser — wry child renders here (Task 5)",
                    _ => "Orchestration — runs/tasks/dispatches render here (Task 4)",
                }
                .to_string(),
            ),
        )
    }
}
