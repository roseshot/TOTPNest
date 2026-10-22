-- Keep the legacy token columns temporarily so migrations remain compatible
-- with the previously deployed Worker during the rollout.
ALTER TABLE shares ADD COLUMN public_id TEXT;

-- Rotate every existing share URL. Old UUID + fragment links are no longer valid.
-- Use 128 unpredictable bits for existing shares; new shares use 22 Base62 symbols.
UPDATE shares SET public_id = lower(hex(randomblob(16))) WHERE public_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_shares_public_id ON shares(public_id);

