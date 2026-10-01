//! Admission control: the token bucket must allow and refuse exactly what the
//! TypeScript allows and refuses, and the scheduler must pick the same task.

use orcspace_app::queue::{ActorRateLimiter, Priority, QueuedTask, Scheduler, GLOBAL_LANE};
use serde_json::Value;

#[test]
fn the_token_bucket_matches_typescript() {
    let data: Value = serde_json::from_str(include_str!("fixtures/queue-admission.json"))
        .expect("fixture parses");
    let capacity = data["capacity"].as_f64().unwrap();
    let refill = data["refillPerSec"].as_f64().unwrap();
    let mut limiter = ActorRateLimiter::new(capacity, refill);

    for (index, step) in data["bucketSteps"].as_array().unwrap().iter().enumerate() {
        let at = step["at"].as_i64().unwrap();
        let actor = step["actor"].as_str().unwrap();
        let tokens = step["tokens"].as_f64().unwrap();
        let expected = step["allowed"].as_bool().unwrap();

        // The fixture resets alice's bucket before its last step; replaying that
        // here keeps the two timelines aligned.
        if index == data["bucketSteps"].as_array().unwrap().len() - 1 {
            limiter.reset(Some("alice"));
        }

        assert_eq!(
            limiter.try_consume(actor, tokens, at),
            expected,
            "step {index}: {actor} asking for {tokens} at {at}ms"
        );
    }
}

fn task(id: &str, priority: Priority, lanes: &[&str], enqueued_at: i64) -> QueuedTask {
    QueuedTask {
        id: id.to_owned(),
        priority,
        actor_id: "alice".to_owned(),
        lanes: lanes.iter().map(|l| (*l).to_owned()).collect(),
        enqueued_at,
    }
}

#[test]
fn higher_priority_runs_first() {
    let scheduler = Scheduler::default();
    let tasks = vec![
        task("low", Priority::Low, &["a"], 0),
        task("high", Priority::High, &["b"], 0),
        task("normal", Priority::Normal, &["c"], 0),
    ];
    let picked = scheduler.pick_next(&tasks, &[], 0).unwrap();
    assert_eq!(tasks[picked].id, "high");
}

#[test]
fn equal_priority_stays_fifo() {
    let scheduler = Scheduler::default();
    let tasks = vec![
        task("second", Priority::Normal, &["b"], 100),
        task("first", Priority::Normal, &["a"], 50),
    ];
    let picked = scheduler.pick_next(&tasks, &[], 200).unwrap();
    assert_eq!(
        tasks[picked].id, "first",
        "the earlier arrival wins the tie"
    );
}

/// Without ageing, a steady stream of high-priority work would starve low
/// work forever.
#[test]
fn waiting_past_the_promotion_window_moves_a_task_up_a_band() {
    let scheduler = Scheduler::default();
    let old_low = task("old-low", Priority::Low, &["a"], 0);
    let fresh_normal = task("fresh-normal", Priority::Normal, &["b"], 10_000);
    let tasks = vec![fresh_normal, old_low];

    // Before the window, normal outranks low.
    let picked = scheduler.pick_next(&tasks, &[], 1_000).unwrap();
    assert_eq!(tasks[picked].id, "fresh-normal");

    // The low task has now waited 10s; promoted to normal it wins on age.
    let picked = scheduler.pick_next(&tasks, &[], 10_000).unwrap();
    assert_eq!(tasks[picked].id, "old-low");
}

#[test]
fn a_task_whose_lane_is_busy_is_skipped() {
    let scheduler = Scheduler::default();
    let tasks = vec![
        task("blocked", Priority::High, &["terminal:t1"], 0),
        task("free", Priority::Low, &["terminal:t2"], 0),
    ];
    let busy = vec!["terminal:t1".to_owned()];
    let picked = scheduler.pick_next(&tasks, &busy, 0).unwrap();
    assert_eq!(
        tasks[picked].id, "free",
        "a busy lane must not be entered even by higher-priority work"
    );
}

#[test]
fn a_task_naming_no_lane_takes_the_global_one() {
    let scheduler = Scheduler::default();
    let tasks = vec![task("global", Priority::High, &[], 0)];
    assert_eq!(tasks[0].lanes_or_global(), vec![GLOBAL_LANE.to_owned()]);

    let busy = vec![GLOBAL_LANE.to_owned()];
    assert!(
        scheduler.pick_next(&tasks, &busy, 0).is_none(),
        "laneless tasks exclude each other"
    );
}

#[test]
fn nothing_is_picked_when_every_lane_is_busy() {
    let scheduler = Scheduler::default();
    let tasks = vec![
        task("a", Priority::High, &["x"], 0),
        task("b", Priority::Normal, &["x"], 0),
    ];
    assert!(scheduler.pick_next(&tasks, &["x".to_owned()], 0).is_none());
}

#[test]
fn the_queue_reports_full_at_its_limit() {
    let scheduler = Scheduler {
        max_queue_length: 3,
        age_promote_ms: 5_000,
    };
    assert!(!scheduler.is_full(2));
    assert!(
        scheduler.is_full(3),
        "at the limit a further enqueue is backpressure"
    );
}
