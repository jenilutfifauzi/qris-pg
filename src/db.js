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
  const { results } = await db
    .prepare(
      `SELECT amount FROM invoices
       WHERE status = 'pending' AND amount BETWEEN ? AND ?
         AND datetime(expires_at) > datetime('now')`
    )
    .bind(base, base + 199)
    .all();
  const taken = new Set((results || []).map((r) => r.amount));
  for (let i = 0; i < 200; i++) {
    if (!taken.has(base + i)) return { amount: base + i, uniqueCode: i };
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
    callback_sent: row.callback_sent,
    callback_attempts: row.callback_attempts,
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
  // retention: keep 90 days of history; never delete paid invoices with an
  // unsent callback, and never touch non-pending rows younger than 90 days.
  await db
    .prepare("DELETE FROM claimed WHERE claimed_at < datetime('now', '-90 days')")
    .run();
  await db
    .prepare(
      `DELETE FROM invoices WHERE status = 'expired' AND created_at < datetime('now', '-90 days')`
    )
    .run();
  await db
    .prepare(
      `DELETE FROM invoices WHERE status = 'paid' AND callback_sent = 1 AND created_at < datetime('now', '-90 days')`
    )
    .run();
  return r?.meta?.changes ?? 0;
}

/** Claim the poll lock. Atomic upsert: succeeds only when the previous holder's
 * timestamp is older than `ttlMs` (or the key never existed). Prevents cron +
 * manual + opportunistic polls from double-fetching GoBiz concurrently. */
export async function claimPollLock(db, ttlMs = 45_000) {
  const now = Date.now();
  const r = await db
    .prepare(
      `INSERT INTO settings (key, value) VALUES ('poll_lock', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value
       WHERE CAST(settings.value AS INTEGER) <= ?`
    )
    .bind(String(now), now - ttlMs)
    .run();
  return (r?.meta?.changes ?? 0) > 0;
}

/** Atomic per-key counter (window = minute). Returns false when over limit.
 * Single statement via RETURNING — no check-then-act race between concurrent requests. */
export async function rateLimit(db, key, limit) {
  const minute = Math.floor(Date.now() / 60000);
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, minute, count) VALUES (?, ?, 1)
       ON CONFLICT(key) DO UPDATE SET
         minute = excluded.minute,
         count = CASE WHEN minute = excluded.minute THEN count + 1 ELSE 1 END
       RETURNING count`
    )
    .bind(key, minute)
    .first();
  return (row?.count ?? 1) <= limit;
}

/** Mark paid once; returns invoice or null if already claimed/paid/expired.
 *
 * Atomic via db.batch (D1 runs the batch in an implicit transaction):
 *  1. claim insert is conditional — the SELECT only yields a row while the
 *     invoice is still 'pending', so an expired/paid invoice claims nothing;
 *  2. if the tx_id is already claimed, the INSERT hits the PK constraint and
 *     the whole batch rolls back (the UPDATE is never applied);
 *  3. a worker crash mid-poll either commits both statements or neither.
 * No orphan claimed rows, no burned tx_ids, no double-paid invoices.
 */
export async function markPaid(db, invoiceId, txId) {
  const inv = await getInvoice(db, invoiceId);
  if (!inv || inv.status !== "pending") return null;

  try {
    const [, upd] = await db.batch([
      db
        .prepare(
          `INSERT INTO claimed (tx_id, invoice_id, amount)
           SELECT ?, ?, amount FROM invoices WHERE id = ? AND status = 'pending'`
        )
        .bind(txId, invoiceId, invoiceId),
      db
        .prepare(
          `UPDATE invoices
           SET status = 'paid', paid_at = datetime('now'), tx_id = ?, callback_sent = ?
           WHERE id = ? AND status = 'pending'`
        )
        .bind(txId, inv.callback_url ? 0 : 1, invoiceId),
    ]);
    // changes = 0 → invoice expired/paid concurrently: nothing was persisted
    // (claim insert is conditional on status='pending'), tx_id stays reusable.
    if ((upd?.meta?.changes ?? 0) === 0) return null;
  } catch {
    return null; // tx already claimed → batch rolled back atomically
  }

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
