use rgpui::*;

pub fn orchestration_rows(store: &grayspace_app::orchestration::OrchestrationStore) -> Vec<String> {
    let mut rows = Vec::new();
    let runs = store.list_runs();
    rows.push(format!("runs: {}", runs.len()));
    for run in runs.iter().take(20) {
        rows.push(format!("· {} {}", run.id, if run.closed_at.is_some() { "closed" } else { "open" }));
    }
    let tasks = store.list_tasks(None, None, false);
    rows.push(format!("tasks: {}", tasks.len()));
    for task in tasks.iter().take(20) {
        rows.push(format!("· {} [{}]", task.title, task.status));
    }
    rows
}

pub fn orchestration_pane(store: &grayspace_app::orchestration::OrchestrationStore) -> impl IntoElement {
    let mut col = div().flex().flex_col().gap_1();
    for row in orchestration_rows(store) {
        col = col.child(div().text_sm().text_color(rgb(0xb9b9be)).child(row));
    }
    div().flex_1().flex().flex_col().child(col)
}
