PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  account TEXT NOT NULL,
  algorithm TEXT NOT NULL CHECK (algorithm IN ('SHA1','SHA256','SHA512')),
  digits INTEGER NOT NULL CHECK (digits IN (6,8)),
  period INTEGER NOT NULL CHECK (period BETWEEN 15 AND 120),
  secret_nonce TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  token_nonce TEXT NOT NULL,
  token_ciphertext TEXT NOT NULL,
  password_hash TEXT,
  note TEXT NOT NULL DEFAULT '',
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shares_entry ON shares(entry_id);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_reset ON rate_limits(reset_at);
