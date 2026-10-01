//! Admission control: a per-actor token bucket and the queue's scheduling
//! policy.
//!
//! Mirrors src/main/core/queue.ts. Two pieces, for different reasons:
//!
//! * `ActorRateLimiter` is ported whole — it is pure arithmetic over a clock.
//! * From `PriorityCommandQueue` only the *decision* is ported: which waiting
//!   task runs next. The surrounding machinery is promise-driven and specific
//!   to the JavaScript runtime, while the policy — priority, ageing, lane
//!   exclusion, FIFO tie-break — is what determines observable ordering and is
//!   what a Rust executor would have to reproduce.

use indexmap::IndexMap;

pub const DEFAULT_CAPACITY: f64 = 30.0;
pub const DEFAULT_REFILL_PER_SEC: f64 = 20.0;
pub const DEFAULT_MAX_QUEUE_LENGTH: usize = 500;
pub const DEFAULT_AGE_PROMOTE_MS: i64 = 5_000;

/// The lane a task takes when it names none: everything without an explicit
/// lane excludes everything else without one.
pub const GLOBAL_LANE: &str = "\u{0}global";

struct Bucket {
    tokens: f64,
    last_refill: i64,
}

pub struct ActorRateLimiter {
    buckets: IndexMap<String, Bucket>,
    capacity: f64,
    refill_per_sec: f64,
}

impl Default for ActorRateLimiter {
    fn default() -> Self {
        Self::new(DEFAULT_CAPACITY, DEFAULT_REFILL_PER_SEC)
    }
}

impl ActorRateLimiter {
    pub fn new(capacity: f64, refill_per_sec: f64) -> Self {
        Self {
            buckets: IndexMap::new(),
            capacity,
            refill_per_sec,
        }
    }

    /// A first-seen actor starts with a full bucket, so a burst at the start of
    /// a session is allowed — the limiter exists to bound a runaway loop, not to
    /// make the first command wait.
    pub fn try_consume(&mut self, actor_id: &str, tokens: f64, now: i64) -> bool {
        let capacity = self.capacity;
        let refill_per_sec = self.refill_per_sec;

        let bucket = match self.buckets.get_mut(actor_id) {
            // An existing bucket refills by the time since it was last touched.
            Some(bucket) => {
                let elapsed_sec = (now - bucket.last_refill) as f64 / 1000.0;
                bucket.tokens = capacity.min(bucket.tokens + elapsed_sec * refill_per_sec);
                bucket.last_refill = now;
                bucket
            }
            // A new one starts full and is not refilled on the same tick.
            None => self.buckets.entry(actor_id.to_owned()).or_insert(Bucket {
                tokens: capacity,
                last_refill: now,
            }),
        };

        if bucket.tokens >= tokens {
            bucket.tokens -= tokens;
            true
        } else {
            false
        }
    }

    pub fn reset(&mut self, actor_id: Option<&str>) {
        match actor_id {
            Some(actor_id) => {
                self.buckets.shift_remove(actor_id);
            }
            None => self.buckets.clear(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Priority {
    High,
    Normal,
    Low,
}

impl Priority {
    fn rank(self) -> i32 {
        match self {
            Priority::High => 0,
            Priority::Normal => 1,
            Priority::Low => 2,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct QueuedTask {
    pub id: String,
    pub priority: Priority,
    pub actor_id: String,
    /// Tasks sharing a lane are mutually exclusive. Empty means the global lane.
    pub lanes: Vec<String>,
    pub enqueued_at: i64,
}

impl QueuedTask {
    pub fn lanes_or_global(&self) -> Vec<String> {
        if self.lanes.is_empty() {
            vec![GLOBAL_LANE.to_owned()]
        } else {
            self.lanes.clone()
        }
    }
}

pub struct Scheduler {
    pub max_queue_length: usize,
    pub age_promote_ms: i64,
}

impl Default for Scheduler {
    fn default() -> Self {
        Self {
            max_queue_length: DEFAULT_MAX_QUEUE_LENGTH,
            age_promote_ms: DEFAULT_AGE_PROMOTE_MS,
        }
    }
}

impl Scheduler {
    /// Effective rank. A task that has waited past the promotion window moves up
    /// one band, which is what stops a steady stream of `high` work from
    /// starving `low` work forever.
    pub fn rank_of(&self, task: &QueuedTask, now: i64) -> i32 {
        let rank = task.priority.rank();
        let waited = now - task.enqueued_at;
        if waited >= self.age_promote_ms {
            (rank - 1).max(0)
        } else {
            rank
        }
    }

    /// Index of the task to run next, or `None` when every waiting task is
    /// blocked on a busy lane.
    ///
    /// Ties on rank break by enqueue time, so equal-priority work stays FIFO.
    /// The scan walks the high, normal and low buckets in that order, matching
    /// the TypeScript, which matters when two tasks tie on both rank and time.
    pub fn pick_next(
        &self,
        tasks: &[QueuedTask],
        busy_lanes: &[String],
        now: i64,
    ) -> Option<usize> {
        let mut best: Option<(usize, i32, i64)> = None;
        for band in [Priority::High, Priority::Normal, Priority::Low] {
            for (index, task) in tasks.iter().enumerate() {
                if task.priority != band {
                    continue;
                }
                if task
                    .lanes_or_global()
                    .iter()
                    .any(|lane| busy_lanes.contains(lane))
                {
                    continue;
                }
                let rank = self.rank_of(task, now);
                let at = task.enqueued_at;
                let better = match best {
                    None => true,
                    Some((_, best_rank, best_at)) => {
                        rank < best_rank || (rank == best_rank && at < best_at)
                    }
                };
                if better {
                    best = Some((index, rank, at));
                }
            }
        }
        best.map(|(index, _, _)| index)
    }

    pub fn is_full(&self, queued: usize) -> bool {
        queued >= self.max_queue_length
    }
}
