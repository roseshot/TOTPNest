-- Track approximate unique browsers per share without storing IPs or user agents.
-- Historical view receipts have no visitor identifier, so past UV cannot be reconstructed.
ALTER TABLE share_visits ADD COLUMN visitor_hash TEXT;

-- One index supports per-link COUNT(DISTINCT visitor_hash) efficiently.
CREATE INDEX IF NOT EXISTS idx_share_visits_uv
  ON share_visits (share_id, visitor_hash)
  WHERE visitor_hash IS NOT NULL;
