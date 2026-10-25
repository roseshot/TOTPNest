-- Add an optional recipient-visible label without exposing issuer/account metadata.
ALTER TABLE shares ADD COLUMN public_label TEXT NOT NULL DEFAULT '';

-- Compact lifetime Views and one row per share/browser for rolling UV counts.
CREATE TABLE IF NOT EXISTS share_stats (
  share_id TEXT PRIMARY KEY REFERENCES shares(id) ON DELETE CASCADE,
  view_count INTEGER NOT NULL DEFAULT 0 CHECK (view_count >= 0),
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS share_unique_visitors (
  share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  visitor_hash TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  PRIMARY KEY (share_id, visitor_hash)
) WITHOUT ROWID;

-- Preserve existing counts before old page-view receipts are pruned.
INSERT INTO share_stats (share_id, view_count, updated_at)
SELECT share_id, COUNT(*), COALESCE(MAX(viewed_at), 0)
FROM share_visits GROUP BY share_id;
INSERT OR IGNORE INTO share_unique_visitors (share_id, visitor_hash, first_seen_at)
SELECT share_id, visitor_hash, MIN(viewed_at)
FROM share_visits WHERE visitor_hash IS NOT NULL
GROUP BY share_id, visitor_hash;

CREATE INDEX IF NOT EXISTS idx_share_visits_viewed_at ON share_visits(viewed_at);
CREATE INDEX IF NOT EXISTS idx_share_unique_visitors_first_seen
  ON share_unique_visitors(first_seen_at);

-- Retry receipts increment aggregate Views only once per page-load ID.
CREATE TRIGGER IF NOT EXISTS share_visits_after_insert
AFTER INSERT ON share_visits
BEGIN
  INSERT INTO share_stats (share_id, view_count, updated_at)
  VALUES (NEW.share_id, 1, NEW.viewed_at)
  ON CONFLICT(share_id) DO UPDATE SET
    view_count = share_stats.view_count + 1,
    updated_at = MAX(share_stats.updated_at, excluded.updated_at);
  INSERT OR IGNORE INTO share_unique_visitors (share_id, visitor_hash, first_seen_at)
  SELECT NEW.share_id, NEW.visitor_hash, NEW.viewed_at
  WHERE NEW.visitor_hash IS NOT NULL;
END;

-- History keeps metadata only: no public IDs, password verifiers, unlock tickets, or secrets.
CREATE TABLE IF NOT EXISTS share_history (
  id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  account TEXT NOT NULL,
  public_label TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('revoked', 'expired', 'entry_deleted')),
  view_count INTEGER NOT NULL DEFAULT 0,
  unique_visitors INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_share_history_ended_at ON share_history(ended_at DESC);
