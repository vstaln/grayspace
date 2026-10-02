use rgpui::*;

pub fn snapshot_text(id: &str, output: &str, alive: bool) -> String {
    format!(
        "{} [{}]\n{}",
        id,
        if alive { "live" } else { "exited" },
        output
    )
}

pub fn terminal_pane(snapshots: &[crate::engine::TerminalSnapshot]) -> impl IntoElement {
    let mut col = div().flex().flex_col().gap_2();
    for s in snapshots {
        col = col.child(
            div()
                .p_2()
                .rounded_md()
                .bg(rgb(0x121212))
                .text_sm()
                .text_color(rgb(0xb9b9be))
                .child(snapshot_text(&s.id, &s.output, s.alive)),
        );
    }
    div().flex_1().flex().flex_col().child(col)
}
