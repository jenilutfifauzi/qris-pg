CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  minute INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1
);

-- atomically enforce: max one pending invoice per amount (fixes wrong-match race)
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_pending_amount
  ON invoices(amount) WHERE status = 'pending';
