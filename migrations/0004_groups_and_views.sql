-- Add optional folders without changing existing verification codes.
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(name) BETWEEN 1 AND 50),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Existing entries remain available under "Ungrouped".
ALTER TABLE entries ADD COLUMN group_id TEXT REFERENCES groups(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_entries_group ON entries(group_id);

-- A random per-page-view ID is used only to avoid counting automatic code refreshes.
-- No IP addresses, browser fingerprints, accounts, or visitor identities are stored.
-- Receipts are deleted automatically with their share.
CREATE TABLE IF NOT EXISTS share_visits (
  share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  visit_id TEXT NOT NULL,
  viewed_at INTEGER NOT NULL,
  PRIMARY KEY (share_id, visit_id)
) WITHOUT ROWID;
