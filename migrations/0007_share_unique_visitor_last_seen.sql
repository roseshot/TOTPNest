-- A rolling UV window must track the last successful visit, not the first.
ALTER TABLE share_unique_visitors RENAME COLUMN first_seen_at TO last_seen_at;

UPDATE share_unique_visitors
SET last_seen_at = COALESCE((
  SELECT MAX(share_visits.viewed_at)
  FROM share_visits
  WHERE share_visits.share_id = share_unique_visitors.share_id
    AND share_visits.visitor_hash = share_unique_visitors.visitor_hash
), last_seen_at);

DROP TRIGGER IF EXISTS share_visits_after_insert;
CREATE TRIGGER share_visits_after_insert
AFTER INSERT ON share_visits
BEGIN
  INSERT INTO share_stats (share_id, view_count, updated_at)
  VALUES (NEW.share_id, 1, NEW.viewed_at)
  ON CONFLICT(share_id) DO UPDATE SET
    view_count = share_stats.view_count + 1,
    updated_at = MAX(share_stats.updated_at, excluded.updated_at);

  INSERT INTO share_unique_visitors (share_id, visitor_hash, last_seen_at)
  SELECT NEW.share_id, NEW.visitor_hash, NEW.viewed_at
  WHERE NEW.visitor_hash IS NOT NULL
  ON CONFLICT(share_id, visitor_hash) DO UPDATE SET
    last_seen_at = MAX(share_unique_visitors.last_seen_at, excluded.last_seen_at);
END;
