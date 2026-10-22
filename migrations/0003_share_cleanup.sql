-- Revoked and expired share records are permanently removed, not archived.
-- The migration is safe to run before updating the Worker: old code treats
-- missing shares as unavailable. TOTP entries are not modified.
CREATE INDEX IF NOT EXISTS idx_shares_expires_at ON shares(expires_at)
  WHERE expires_at IS NOT NULL;

DELETE FROM shares
WHERE revoked_at IS NOT NULL
   OR (expires_at IS NOT NULL
       AND expires_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000);

