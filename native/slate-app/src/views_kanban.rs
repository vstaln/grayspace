//! Kanban pane — the read half of the old Electron `KanbanWidget`.
//!
//! The original did not have its own store: it read `planner.list()` and
//! grouped `PlanItem`s into Todo / Doing / Done columns by `status` (falling
//! back to `done ? done : todo`). Same data path here: the planner snapshot
//! plus journal replay, exactly as `views_planner` loads it.
//!
//! One wrinkle: the typed `planner::PlanItem` never adopted `status` — the
//! field exists in the Electron store's JSON and in `plan.create` /
//! `plan.update` / `plan.toggle` payloads, but the native reducer ignores
//! it. To keep the Doing column honest this pane overlays statuses itself:
//! `status` fields are read from the raw `workspace-planner.json` items, then
//! journal entries after `snapshotSeq` are replayed with the same rules
//! `PlannerStore.reduce`'s `resolveStatus` used — an explicit `status` wins
//! a same-call `done`, and `done`/`toggle` patches translate to a column.

use gpui::prelude::FluentBuilder;
use gpui::*;
use serde_json::{json, Value};
use slate_app::theme;
use std::collections::HashMap;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Column {
    Todo,
    Doing,
    Done,
}

impl Column {
    /// The `status` string the Electron store persisted for the column.
    fn key(self) -> &'static str {
        match self {
            Column::Todo => "todo",
            Column::Doing => "doing",
            Column::Done => "done",
        }
    }

    /// Click cycles Todo → Doing → Done → Todo, the widget's advance-card
    /// affordance.
    fn next(self) -> Column {
        match self {
            Column::Todo => Column::Doing,
            Column::Doing => Column::Done,
            Column::Done => Column::Todo,
        }
    }
}

pub struct Card {
    pub id: String,
    pub title: String,
    pub project: Option<String>,
    pub column: Column,
    pub order: f64,
}

fn parse_status(value: Option<&Value>) -> Option<Column> {
    match value?.as_str()? {
        "todo" => Some(Column::Todo),
        "doing" => Some(Column::Doing),
        "done" => Some(Column::Done),
        _ => None,
    }
}

/// `(done, column)` per item id, carried through the overlay replay so a
/// `plan.toggle`'s resolution (`!done` → done column, `done=false` → todo or
/// back to a doing it never left) behaves like the TypeScript reducer's.
#[derive(Clone, Copy)]
struct StatusBits {
    done: bool,
    column: Column,
}

/// The same rule `resolveStatus` applied in the Electron store.
fn resolve(
    patch_done: Option<bool>,
    patch_status: Option<Column>,
    existing: Option<StatusBits>,
) -> StatusBits {
    if let Some(status) = patch_status {
        return StatusBits {
            done: status == Column::Done,
            column: status,
        };
    }
    if let Some(done) = patch_done {
        let column = if done {
            Column::Done
        } else {
            match existing.map(|bits| bits.column) {
                // A card pulled back out of Done lands on Todo only when it
                // has no remembered middle column — `doing` survives.
                Some(Column::Doing) => Column::Doing,
                _ => Column::Todo,
            }
        };
        return StatusBits { done, column };
    }
    existing.unwrap_or(StatusBits {
        done: false,
        column: Column::Todo,
    })
}

/// Raw `status`/`done` per id out of the snapshot file — the typed document
/// keeps the fields in `document["items"]` but does not expose them, so the
/// file is re-read rather than going through `PlannerDocument`.
fn snapshot_statuses(path: &std::path::Path) -> (HashMap<String, StatusBits>, u64) {
    let mut map = HashMap::new();
    let Ok(bytes) = std::fs::read(path) else {
        return (map, 0);
    };
    let Ok(document) = serde_json::from_slice::<Value>(&bytes) else {
        return (map, 0);
    };
    let snapshot_seq = document
        .get("snapshotSeq")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    for item in document
        .get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(id) = item.get("id").and_then(Value::as_str) else {
            continue;
        };
        let done = item.get("done").and_then(Value::as_bool).unwrap_or(false);
        let column = parse_status(item.get("status")).unwrap_or(if done {
            Column::Done
        } else {
            Column::Todo
        });
        map.insert(id.to_owned(), StatusBits { done, column });
    }
    (map, snapshot_seq)
}

/// Replay only the status-bearing journal entries the snapshot predates —
/// `seq <= snapshotSeq` is already folded into the file, which is exactly
/// the check `PlannerDocument::apply` makes. `statuses` is the map the
/// snapshot read seeded, so an update to a pre-snapshot card resolves
/// against its on-file column rather than starting blank.
fn journal_statuses(
    log: &slate_app::journal_log::JournalLog,
    after: u64,
    statuses: &mut HashMap<String, StatusBits>,
) {
    for entry in log.entries() {
        if entry.phase != "commit" || entry.seq <= after {
            continue;
        }
        let empty = Value::Object(Default::default());
        let payload = entry.payload.as_ref().unwrap_or(&empty);
        let target = entry.target.strip_prefix("plan:").unwrap_or(&entry.target);
        match entry.entry_type.as_str() {
            "plan.create" => {
                let id = if target == "new" {
                    payload
                        .get("id")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("plan-{}-{}", entry.at, entry.seq))
                } else {
                    target.to_owned()
                };
                if id.is_empty() {
                    continue;
                }
                let bits = resolve(
                    payload.get("done").and_then(Value::as_bool),
                    parse_status(payload.get("status")),
                    None,
                );
                statuses.insert(id, bits);
            }
            "plan.update" | "plan.toggle" => {
                let Some(existing) = statuses.get(target).copied() else {
                    // Not in the snapshot and never created in the tail —
                    // the typed fold has nothing to show for it either.
                    continue;
                };
                let patch_done = match payload.get("done").and_then(Value::as_bool) {
                    Some(done) => Some(done),
                    None if entry.entry_type == "plan.toggle" => Some(!existing.done),
                    None => None,
                };
                let bits = resolve(
                    patch_done,
                    parse_status(payload.get("status")),
                    Some(existing),
                );
                statuses.insert(target.to_owned(), bits);
            }
            "plan.delete" => {
                statuses.remove(target);
            }
            _ => {}
        }
    }
}

/// Cards grouped by column, each column ordered by `order` like the widget.
/// `(Todo, Doing, Done)` — the column order the original's COLUMNS fixed.
pub fn kanban_columns() -> ([Vec<Card>; 3], Option<String>) {
    let dir = slate_app::ipc::user_data_dir();
    let log = match slate_app::journal_log::JournalLog::open(dir.join("command-journal.ndjson")) {
        Ok(log) => log,
        Err(error) => return ([Vec::new(), Vec::new(), Vec::new()], Some(error)),
    };

    let planner_path = dir.join("workspace-planner.json");

    // Statuses come first, read straight from the raw snapshot — the typed
    // fold discards `status`, and `PlannerDocument::recover` would fold the
    // journal tail into the file (bumping `snapshotSeq`) before persisting
    // only the fields it knows, which would lose every status the tail set.
    // The pane stays strictly read-only instead: statuses from snapshot +
    // journal overlay, items from `PlannerDocument::open` + the pure
    // `planner::reduce` fold over the same tail.
    let (mut statuses, snapshot_seq) = snapshot_statuses(&planner_path);
    journal_statuses(&log, snapshot_seq, &mut statuses);

    let today = slate_app::planner::today_utc();
    let document = match slate_app::planner_document::PlannerDocument::open(&planner_path) {
        Ok(document) => document,
        Err(error) => return ([Vec::new(), Vec::new(), Vec::new()], Some(error)),
    };
    let mut items = document.items.clone();
    for entry in log.entries() {
        if entry.phase != "commit" || entry.seq <= snapshot_seq {
            continue;
        }
        match slate_app::planner::reduce(&items, entry, &today) {
            Ok(next) => items = next,
            Err(error) => return ([Vec::new(), Vec::new(), Vec::new()], Some(error.0)),
        }
    }

    let mut columns: [Vec<Card>; 3] = [Vec::new(), Vec::new(), Vec::new()];
    for (_, item) in items.iter() {
        let column = statuses
            .get(&item.id)
            .map(|bits| bits.column)
            .unwrap_or(if item.done {
                Column::Done
            } else {
                Column::Todo
            });
        columns[column as usize].push(Card {
            id: item.id.clone(),
            title: item.title.clone(),
            project: item.project.clone(),
            column,
            order: item.order,
        });
    }
    for cards in &mut columns {
        cards.sort_by(|a, b| {
            a.order
                .partial_cmp(&b.order)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }
    (columns, None)
}

fn card_view<'a>(
    card: &'a Card,
    widget_id: &str,
    overrides: &serde_json::Map<String, Value>,
    cx: &mut Context<crate::canvas_view::CanvasView>,
) -> impl IntoElement + 'a {
    let mut el = div()
        .flex()
        .flex_col()
        .rounded_md()
        .border_1()
        .border_color(rgb(theme::hex(theme::hairline::SOFT)))
        .bg(rgb(theme::hex(theme::monochrome::ELEVATED)))
        .px_2()
        .py_1()
        .cursor_pointer()
        .child(
            div()
                .text_xs()
                .text_color(rgb(theme::hex(if card.column == Column::Done {
                    theme::text::FAINT
                } else {
                    theme::text::NORMAL
                })))
                .when(card.column == Column::Done, |el| el.line_through())
                .child(card.title.clone()),
        );
    if let Some(project) = &card.project {
        el = el.child(
            div()
                .text_xs()
                .text_color(rgb(theme::hex(theme::text::FAINT)))
                .truncate()
                .child(project.clone()),
        );
    }
    // Click advances the card Todo → Doing → Done → Todo. The move persists
    // as a per-card column override in the widget's journaled `state` (the
    // typed planner fold carries no `status`, so widget state is the durable
    // carrier), and `plan_move` is emitted alongside so the command bus can
    // journal a real `plan.update` status patch when that op is wired.
    let widget_id = widget_id.to_owned();
    let card_id = card.id.clone();
    let next = card.column.next();
    let mut merged = overrides.clone();
    merged.insert(card_id.clone(), json!(next.key()));
    let set_action = json!({ "op": "set", "state": { "overrides": merged } });
    let move_action = json!({ "op": "plan_move", "id": card_id, "status": next.key() });
    el.on_mouse_down(
        MouseButton::Left,
        cx.listener(move |this, _event, _window, cx| {
            this.widget_command(&widget_id, set_action.clone(), cx);
            this.widget_command(&widget_id, move_action.clone(), cx);
        }),
    )
}

fn column_view<'a>(
    label: &'a str,
    key: &'a str,
    cards: &'a [Card],
    collapsed: bool,
    (collapsed_map, overrides): (
        &'a serde_json::Map<String, Value>,
        &'a serde_json::Map<String, Value>,
    ),
    widget_id: &'a str,
    cx: &mut Context<crate::canvas_view::CanvasView>,
) -> impl IntoElement + 'a {
    let wid = widget_id.to_owned();
    let mut next_collapsed = collapsed_map.clone();
    next_collapsed.insert(key.to_owned(), json!(!collapsed));
    let collapse_action = json!({ "op": "set", "state": { "collapsed": next_collapsed } });
    let col = div()
        .flex()
        .flex_col()
        .flex_1()
        .min_w_0()
        .rounded_md()
        .border_1()
        .border_color(rgb(theme::hex(theme::hairline::SOFT)))
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .justify_between()
                .px_2()
                .py_1()
                .cursor_pointer()
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |this, _event, _window, cx| {
                        this.widget_command(&wid, collapse_action.clone(), cx);
                    }),
                )
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap_1()
                        .child(
                            div()
                                .text_xs()
                                .text_color(rgb(theme::hex(theme::text::FAINT)))
                                .child(if collapsed { "▸" } else { "▾" }),
                        )
                        .child(
                            div()
                                .text_xs()
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(rgb(theme::hex(theme::text::DIM)))
                                .child(label.to_owned()),
                        ),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(rgb(theme::hex(theme::text::FAINT)))
                        .child(cards.len().to_string()),
                ),
        );
    if collapsed {
        return col;
    }
    let mut body = div()
        .id(format!("slate-kanban-col-{}-{}", widget_id, key))
        .flex()
        .flex_col()
        .gap_1()
        .px_1()
        .pb_1()
        .flex_1()
        .min_h_0()
        .overflow_y_scroll();
    for card in cards {
        body = body.child(card_view(card, widget_id, overrides, cx));
    }
    col.child(body)
}

pub fn kanban_pane(
    widget: &slate_app::projection::Widget,
    cx: &mut Context<crate::canvas_view::CanvasView>,
) -> impl IntoElement {
    let (columns, error) = kanban_columns();
    let state = widget.state.as_ref();
    let overrides = state
        .and_then(|s| s.get("overrides"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let collapsed_map = state
        .and_then(|s| s.get("collapsed"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    // Journal-derived columns first, then per-card overrides win — a card
    // moved by hand lands in its state column until a planner write disagrees.
    let mut grouped: [Vec<Card>; 3] = [Vec::new(), Vec::new(), Vec::new()];
    for cards in columns {
        for mut card in cards {
            if let Some(column) = parse_status(overrides.get(&card.id)) {
                card.column = column;
            }
            grouped[card.column as usize].push(card);
        }
    }

    let mut root = div().flex().flex_col().gap_1().size_full();
    if let Some(error) = &error {
        root = root.child(
            div()
                .text_sm()
                .text_color(rgb(theme::hex(theme::status::DANGER)))
                .child(format!("kanban: {error}")),
        );
    }
    if grouped.iter().all(Vec::is_empty) && error.is_none() {
        root = root.child(
            div()
                .text_sm()
                .text_color(rgb(theme::hex(theme::text::FAINT)))
                .child("No cards yet — add them to the planner"),
        );
    }
    let is_collapsed = |key: &str| {
        collapsed_map
            .get(key)
            .and_then(Value::as_bool)
            .unwrap_or(false)
    };
    root.child(
        div()
            .flex()
            .flex_row()
            .gap_2()
            .flex_1()
            .min_h_0()
            .child(column_view(
                "Todo",
                "todo",
                &grouped[0],
                is_collapsed("todo"),
                (&collapsed_map, &overrides),
                &widget.id,
                cx,
            ))
            .child(column_view(
                "Doing",
                "doing",
                &grouped[1],
                is_collapsed("doing"),
                (&collapsed_map, &overrides),
                &widget.id,
                cx,
            ))
            .child(column_view(
                "Done",
                "done",
                &grouped[2],
                is_collapsed("done"),
                (&collapsed_map, &overrides),
                &widget.id,
                cx,
            )),
    )
}
