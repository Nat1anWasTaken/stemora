//! Simple in-memory sliding-window rate limiter.

use std::collections::{HashMap, VecDeque};
use std::hash::Hash;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct RateLimiter<K> {
    max: usize,
    window: Duration,
    hits: Mutex<HashMap<K, VecDeque<Instant>>>,
}

impl<K: Hash + Eq + Clone> RateLimiter<K> {
    pub fn new(max: usize, window: Duration) -> Self {
        Self {
            max,
            window,
            hits: Mutex::new(HashMap::new()),
        }
    }

    /// Records a hit and returns true if allowed.
    pub fn check(&self, key: &K) -> bool {
        self.check_at(key, Instant::now())
    }

    pub fn check_at(&self, key: &K, now: Instant) -> bool {
        let mut map = self.hits.lock().unwrap();
        // Opportunistic cleanup so the map cannot grow without bound.
        if map.len() > 10_000 {
            map.retain(|_, q| {
                q.back()
                    .is_some_and(|t| now.duration_since(*t) < self.window)
            });
        }
        let q = map.entry(key.clone()).or_default();
        while q
            .front()
            .is_some_and(|t| now.saturating_duration_since(*t) >= self.window)
        {
            q.pop_front();
        }
        if q.len() >= self.max {
            return false;
        }
        q.push_back(now);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_after_max_and_recovers() {
        let rl = RateLimiter::new(3, Duration::from_secs(600));
        let t0 = Instant::now();
        for _ in 0..3 {
            assert!(rl.check_at(&"u1", t0));
        }
        assert!(!rl.check_at(&"u1", t0 + Duration::from_secs(1)));
        assert!(rl.check_at(&"u2", t0), "other keys are independent");
        assert!(rl.check_at(&"u1", t0 + Duration::from_secs(601)));
    }

    #[test]
    fn sliding_window() {
        let rl = RateLimiter::new(2, Duration::from_secs(10));
        let t0 = Instant::now();
        assert!(rl.check_at(&1, t0));
        assert!(rl.check_at(&1, t0 + Duration::from_secs(6)));
        assert!(!rl.check_at(&1, t0 + Duration::from_secs(9)));
        assert!(rl.check_at(&1, t0 + Duration::from_secs(11)));
    }
}
