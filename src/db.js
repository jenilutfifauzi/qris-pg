/** D1 helpers for settings + invoices. */

export async function getSetting(db, key) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first();
  return row?.value ?? null;
}

export async function setSetting(db, key, value) {
  await db
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .bind(key, String(value ?? ""))
    .run();
}

export async function getSettings(db) {
  const { results } = await db.prepare("SELECT key, value FROM settings").all();
  const out = {};
  for (const r of results || []) out[r.key] = r.value;
  return out;
}

export async function getConfig(db) {
  const s = await getSettings(db);
  return {
    merchantId: s.merchant_id || "",
    token: s.gobiz_token || "",
    qrisStatic: s.qris_static || "",
    defaultCallback: s.default_callback || "",
    lookbackHours: Number(s.lookback_hours || 6),
  };
}

/** Allocate unique amount: base, base+1, ... among active pending. */
export async function allocateUniqueAmount(db, baseAmount) {
  const base = Math.floor(baseAmount);
  for (let i = 0; i < 200; i++) {
    const amt = base + i;
    const clash = await db
      .prepare(
        `SELECT 1 AS x FROM invoices
         WHERE amount = ? AND status = 'pending'
           AND datetime(expires_at) > datetime('now')`
      )
      .bind(amt)
      .first();
    if (!clash) return { amount: amt, uniqueCode: i };
  }
  // ponytail: rare collision path — random offset
  const extra = 100 + Math.floor(Math.random() * 900);
  return { amount: base + extra, uniqueCode: extra };
}

export function publicInvoice(row) {
  if (!row) return null;
  return {
    id: row.id,
    merchant_ref: row.merchant_ref,
    amount: row.amount,
    base_amount: row.base_amount,
    unique_code: row.unique_code,
    status: row.status,
    qris_payload: row.qris_payload,
    callback_url: row.callback_url,
    expires_at: row.expires_at,
    paid_at: row.paid_at,
    tx_id: row.tx_id,
    created_at: row.created_at,
  };
}

export async function createInvoice(db, {
  id,
  merchantRef,
  amount,
  baseAmount,
  uniqueCode,
  qrisPayload,
  callbackUrl,
  expiresAt,
}) {
  await db
    .prepare(
      `INSERT INTO invoices
        (id, merchant_ref, amount, base_amount, unique_code, status, qris_payload, callback_url, expires_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
    )
    .bind(
      id,
      merchantRef || null,
      amount,
      baseAmount,
      uniqueCode,
      qrisPayload,
      callbackUrl || null,
      expiresAt
    )
    .run();
  return getInvoice(db, id);
}

export async function getInvoice(db, id) {
  return db.prepare("SELECT * FROM invoices WHERE id = ?").bind(id).first();
}

export async function listInvoices(db, { status, limit = 50 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  if (status) {
    const { results } = await db
      .prepare("SELECT * FROM invoices WHERE status = ? ORDER BY created_at DESC LIMIT ?")
      .bind(status, lim)
      .all();
    return results || [];
  }
  const { results } = await db
    .prepare("SELECT * FROM invoices ORDER BY created_at DESC LIMIT ?")
    .bind(lim)
    .all();
  return results || [];
}

export async function listPending(db) {
  const { results } = await db
    .prepare(
      `SELECT * FROM invoices
       WHERE status = 'pending' AND datetime(expires_at) > datetime('now')
       ORDER BY created_at ASC`
    )
    .all();
  return results || [];
}

export async function expireOld(db) {
  const r = await db
    .prepare(
      `UPDATE invoices SET status = 'expired'
       WHERE status = 'pending' AND datetime(expires_at) <= datetime('now')`
    )
    .run();
  // prune stale rate-limit windows (runs every cron minute)
  await db
    .prepare("DELETE FROM rate_limits WHERE minute < ?")
    .bind(Math.floor(Date.now() / 60000) - 60)
    .run();
  return r?.meta?.changes ?? 0;
}

/** Atomic per-key counter (window = minute). Returns false when over limit. */
export async function rateLimit(db, key, limit) {
  const minute = Math.floor(Date.now() / 60000);
  await db
    .prepare(
      `INSERT INTO rate_limits (key, minute, count) VALUES (?, ?, 1)
       ON CONFLICT(key) DO UPDATE SET count = count + 1, minute = excluded.minute`
    )
    .bind(key, minute)
    .run();
  const row = await db.prepare("SELECT count FROM rate_limits WHERE key = ?").bind(key).first();
  return (row?.count ?? 0) <= limit;
}

/** Mark paid once; returns invoice or null if already claimed/paid. */
export async function markPaid(db, invoiceId, txId) {
  const inv = await getInvoice(db, invoiceId);
  if (!inv || inv.status !== "pending") return null;

  try {
    await db
      .prepare("INSERT INTO claimed (tx_id, invoice_id, amount) VALUES (?, ?, ?)")
      .bind(txId, invoiceId, inv.amount)
      .run();
  } catch {
    return null; // tx already claimed
  }

  await db
    .prepare(
      `UPDATE invoices
       SET status = 'paid', paid_at = datetime('now'), tx_id = ?, callback_sent = ?
       WHERE id = ? AND status = 'pending'`
    )
    .bind(txId, inv.callback_url ? 0 : 1, invoiceId)
    .run();

  return getInvoice(db, invoiceId);
}

export async function findPendingByAmount(db, amount) {
  return db
    .prepare(
      `SELECT * FROM invoices
       WHERE status = 'pending' AND amount = ?
         AND datetime(expires_at) > datetime('now')
       ORDER BY created_at ASC LIMIT 1`
    )
    .bind(amount)
    .first();
}

/** Idempotency: return an existing pending invoice with the same merchant_ref. */
export async function findPendingByRef(db, ref) {
  if (!ref) return null;
  return db
    .prepare("SELECT * FROM invoices WHERE merchant_ref = ? AND status = 'pending' LIMIT 1")
    .bind(ref)
    .first();
}

export async function isTxClaimed(db, txId) {
  const row = await db.prepare("SELECT 1 AS x FROM claimed WHERE tx_id = ?").bind(txId).first();
  return Boolean(row);
}
