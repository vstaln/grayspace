//! Optimistic-concurrency bookkeeping.
//!
//! Mirrors src/main/core/versioned.ts. A store keeps its own objects; this only
//! answers "what version is `note:abc` at right now", which is the one question
//! the command bus asks before accepting a write. A stale reader's `baseVersion`
//! then cannot match, and its write is rejected as a conflict rather than
//! silently overwriting someone else's.
//!
//! Overlays exist for speculative execution: a dry run bumps versions in its own
//! namespace so it can see its own writes without the base registry moving.

use std::collections::HashMap;

pub struct VersionRegistry {
    scheme: String,
    versions: HashMap<String, u64>,
    overlays: HashMap<String, HashMap<String, u64>>,
}

impl VersionRegistry {
    pub fn new(scheme: impl Into<String>) -> Self {
        Self {
            scheme: scheme.into(),
            versions: HashMap::new(),
            overlays: HashMap::new(),
        }
    }

    pub fn target(&self, id: &str) -> String {
        format!("{}:{}", self.scheme, id)
    }

    /// An overlay answers first when it knows the target, and falls through to
    /// the base otherwise — a speculative run sees its own writes over a
    /// consistent base.
    pub fn version_of(&self, target: &str, overlay_id: Option<&str>) -> Option<u64> {
        if let Some(overlay_id) = overlay_id {
            if let Some(overlay) = self.overlays.get(overlay_id) {
                if let Some(version) = overlay.get(target) {
                    return Some(*version);
                }
            }
        }
        self.versions.get(target).copied()
    }

    /// Version by bare id. Unknown is 0, which no stored object ever is — see
    /// `seed`, which floors at 1 — so "unknown" and "version 1" stay distinct.
    pub fn current(&self, id: &str, overlay_id: Option<&str>) -> u64 {
        self.version_of(&self.target(id), overlay_id).unwrap_or(0)
    }

    pub fn bump(&mut self, id: &str, overlay_id: Option<&str>) -> u64 {
        let next = self.current(id, overlay_id) + 1;
        let target = self.target(id);
        match overlay_id {
            Some(overlay_id) => {
                self.overlays
                    .entry(overlay_id.to_owned())
                    .or_default()
                    .insert(target, next);
            }
            None => {
                self.versions.insert(target, next);
            }
        }
        next
    }

    /// Seeds from persisted objects without bumping. A stored version of 0 or a
    /// missing one becomes 1: an object that exists has been written at least
    /// once, and leaving it at 0 would make it indistinguishable from a
    /// resource nothing knows about.
    pub fn seed<'a>(
        &mut self,
        objects: impl IntoIterator<Item = (&'a str, Option<u64>)>,
        overlay_id: Option<&str>,
    ) {
        for (id, version) in objects {
            let target = self.target(id);
            let version = version.unwrap_or(1).max(1);
            match overlay_id {
                Some(overlay_id) => {
                    self.overlays
                        .entry(overlay_id.to_owned())
                        .or_default()
                        .insert(target, version);
                }
                None => {
                    self.versions.insert(target, version);
                }
            }
        }
    }

    /// Note the fall-through: naming an overlay that does not exist forgets
    /// from the *base*, not from nothing. That is what the TypeScript does, and
    /// a caller cleaning up after a discarded overlay relies on it.
    pub fn forget(&mut self, id: &str, overlay_id: Option<&str>) {
        let target = self.target(id);
        match overlay_id.and_then(|o| self.overlays.get_mut(o)) {
            Some(overlay) => {
                overlay.remove(&target);
            }
            None => {
                self.versions.remove(&target);
            }
        }
    }

    /// How many distinct targets are known, counting an overlay's own on top of
    /// the base without double-counting the ones both hold.
    pub fn size(&self, overlay_id: Option<&str>) -> usize {
        match overlay_id.and_then(|o| self.overlays.get(o)) {
            Some(overlay) => {
                let mut merged: std::collections::HashSet<&String> =
                    self.versions.keys().collect();
                merged.extend(overlay.keys());
                merged.len()
            }
            None => self.versions.len(),
        }
    }

    pub fn create_overlay(&mut self, overlay_id: &str) {
        self.overlays.entry(overlay_id.to_owned()).or_default();
    }

    pub fn has_overlay(&self, overlay_id: &str) -> bool {
        self.overlays.contains_key(overlay_id)
    }

    /// Throws the speculative namespace away. The base is untouched, which is
    /// the whole point of running in one.
    pub fn discard(&mut self, overlay_id: &str) -> bool {
        self.overlays.remove(overlay_id).is_some()
    }

    /// Folds an overlay's versions into the base, as committing a speculative
    /// run does.
    pub fn commit(&mut self, overlay_id: &str) {
        if let Some(overlay) = self.overlays.remove(overlay_id) {
            for (target, version) in overlay {
                self.versions.insert(target, version);
            }
        }
    }

    /// Base versions with the overlay's laid over them.
    pub fn all(&self, overlay_id: Option<&str>) -> HashMap<String, u64> {
        let mut result = self.versions.clone();
        if let Some(overlay) = overlay_id.and_then(|o| self.overlays.get(o)) {
            for (target, version) in overlay {
                result.insert(target.clone(), *version);
            }
        }
        result
    }
}
