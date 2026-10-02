use rgpui::*;

fn load_orchestration_store() -> orcspace_app::orchestration::OrchestrationStore {
    let path = orcspace_app::ipc::user_data_dir().join("orchestration.json");
    match std::fs::read(&path) {
        Ok(bytes) => match serde_json::from_slice::<serde_json::Value>(&bytes) {
            Ok(value) if value.is_object() => {
                orcspace_app::orchestration::OrchestrationStore::load(&value)
            }
            Ok(_) | Err(_) => orcspace_app::orchestration::OrchestrationStore::new(),
        },
        Err(_) => orcspace_app::orchestration::OrchestrationStore::new(),
    }
}
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT_WV_ID: AtomicUsize = AtomicUsize::new(1);

const TABS: [&str; 5] = ["Terminal", "Planner", "Files", "Browser", "Orchestration"];

pub struct RootView {
    focus: FocusHandle,
    active: usize,
    manager: crate::engine::TerminalManager,
    snapshots: Vec<crate::engine::TerminalSnapshot>,
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
    pub fn new(manager: crate::engine::TerminalManager, cx: &mut Context<Self>) -> Self {
        let snapshots = manager.snapshots();
        // 250ms refresh: same non-blocking drain the egui loop used.
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(250))
                    .await;
                let alive = this
                    .update(cx, |view, cx| {
                        view.snapshots = view.manager.snapshots();
                        let _ = view.manager.drain_events();
                        cx.notify();
                    })
                    .is_ok();
                if !alive {
                    break;
                }
            }
        })
        .detach();
        Self {
            focus: cx.focus_handle(),
            active: 0,
            manager,
            snapshots,
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
                match self.active {
                    0 => crate::views_terminal::terminal_pane(&self.snapshots).into_any_element(),
                    1 => crate::views_planner::planner_pane().into_any_element(),
                    2 => crate::views_files::files_pane(&std::env::current_dir().unwrap_or_default())
                        .into_any_element(),
                    3 => div()
                        .flex_1()
                        .text_color(rgb(0xa6adc8))
                        .text_sm()
                        .child("Browser — wry child renders here (Task 5)")
                        .into_any_element(),
                    _ => {
                        let store = load_orchestration_store();
                        crate::views_orchestration::orchestration_pane(&store).into_any_element()
                    }
                },
            ),
        )
    }
}
