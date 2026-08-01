CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  merchant_ref TEXT,
  amount INTEGER NOT NULL,
  base_amount INTEGER NOT NULL,
  unique_code INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  qris_payload TEXT,
  callback_url TEXT,
  expires_at TEXT NOT NULL,
  paid_at TEXT,
  tx_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_invoices_status_amount ON invoices(status, amount);
CREATE INDEX IF NOT EXISTS idx_invoices_expires ON invoices(status, expires_at);

CREATE TABLE IF NOT EXISTS claimed (
  tx_id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  claimed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
