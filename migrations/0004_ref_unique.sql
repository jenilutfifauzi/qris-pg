-- atomically enforce: max one pending invoice per merchant_ref (fixes concurrent-duplicate race)
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_pending_ref
  ON invoices(merchant_ref) WHERE status = 'pending';
