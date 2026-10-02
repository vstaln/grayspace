use rgpui::*;

pub fn planner_rows() -> Vec<String> {
    let dir = orcspace_app::ipc::user_data_dir();
    let log = orcspace_app::journal_log::JournalLog::open(dir.join("command-journal.ndjson"));
    let today = orcspace_app::planner::today_utc();
    let (items, error) = match log {
        Ok(log) => match orcspace_app::planner_document::PlannerDocument::recover(
            dir.join("workspace-planner.json"),
            &log,
            &today,
        ) {
            Ok(doc) => (doc.items.into_iter().map(|(_, i)| i).collect::<Vec<_>>(), None),
            Err(e) => (Vec::new(), Some(e)),
        },
        Err(e) => (Vec::new(), Some(e)),
    };
    // IndexMap iteration order is insertion order — kept, never sorted.
    let mut rows: Vec<String> = items
        .iter()
        .map(|item| {
            format!(
                "{} {}",
                if item.done { "[x]" } else { "[ ]" },
                item.title
            )
        })
        .collect();
    if let Some(e) = error {
        rows.insert(0, format!("planner: {e}"));
    }
    if rows.is_empty() {
        rows.push("No plans yet — create one from the CLI.".into());
    }
    rows
}

pub fn planner_pane() -> impl IntoElement {
    let mut col = div().flex().flex_col().gap_1();
    for row in planner_rows() {
        col = col.child(
            div()
                .text_sm()
                .text_color(rgb(0xb9b9be))
                .child(row),
        );
    }
    div().flex_1().flex().flex_col().child(col)
}
