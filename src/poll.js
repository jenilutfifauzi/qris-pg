import {
  expireOld,
  findPendingByAmount,
  getConfig,
  isTxClaimed,
  listPending,
  markPaid,
  publicInvoice,
} from "./db.js";
import { fetchTransactions } from "./gobiz.js";

async function hmacSha256Hex(secret, text) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Fire callback once. Best-effort. Signed with X-Qris-Signature when secret given. */
export async function sendCallback(invoice, secret) {
  const url = invoice.callback_url;
  if (!url) return { skipped: true };

  const body = {
    id: invoice.id,
    merchant_ref: invoice.merchant_ref,
    amount: invoice.amount,
    status: invoice.status,
    tx_id: invoice.tx_id,
    paid_at: invoice.paid_at,
    unique_code: invoice.unique_code,
  };
  const raw = JSON.stringify(body);
  const sig = secret ? await hmacSha256Hex(secret, raw) : "";

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "qris-pg/1.0",
        ...(sig ? { "X-Qris-Signature": `sha256=${sig}` } : {}),
      },
      body: raw,
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Re-send callbacks for paid invoices whose callback failed (max 5 attempts). */
export async function retryUnsentCallbacks(db, secret) {
  const { results } = await db
    .prepare(
      `SELECT * FROM invoices
       WHERE status = 'paid' AND callback_sent = 0 AND callback_attempts < 5`
    )
    .all();
  let sent = 0;
  for (const inv of results || []) {
    const r = await sendCallback(inv, secret);
    if (r.ok) {
      await db.prepare("UPDATE invoices SET callback_sent = 1 WHERE id = ?").bind(inv.id).run();
      sent++;
    } else {
      await db
        .prepare("UPDATE invoices SET callback_attempts = callback_attempts + 1 WHERE id = ?")
        .bind(inv.id)
        .run();
    }
  }
  return { attempted: (results || []).length, sent };
}

/**
 * One poll cycle: expire → fetch mutasi → match amount → mark paid → callback.
 * @returns {{ expired: number, matched: number, pending: number, error?: string }}
 */
export async function runPoll(env) {
  const db = env.DB;
  const expired = await expireOld(db);
  const pending = await listPending(db);
  if (!pending.length) return { expired, matched: 0, pending: 0 };

  const cfg = await getConfig(db);
  if (!cfg.merchantId || !cfg.token) {
    return { expired, matched: 0, pending: pending.length, error: "not configured" };
  }

  let txs;
  try {
    txs = await fetchTransactions({
      merchantId: cfg.merchantId,
      token: cfg.token,
      lookbackHours: cfg.lookbackHours,
      size: 40,
    });
  } catch (e) {
    return {
      expired,
      matched: 0,
      pending: pending.length,
      error: e.message,
      code: e.code,
    };
  }

  let matched = 0;
  for (const t of txs) {
    if (!t.transaction_id || !t.amount) continue;
    if (await isTxClaimed(db, t.transaction_id)) continue;

    const inv = await findPendingByAmount(db, t.amount);
    if (!inv) continue;

    const paid = await markPaid(db, inv.id, t.transaction_id);
    if (!paid) continue;

    matched++;
    console.log(
      JSON.stringify({
        message: "invoice paid",
        id: paid.id,
        amount: paid.amount,
        tx_id: t.transaction_id,
      })
    );
    await sendCallback(paid, env.API_KEY);
  }

  const retried = await retryUnsentCallbacks(db, env.API_KEY);
  return { expired, matched, pending: pending.length, scanned: txs.length, retried: retried.sent };
}

export { publicInvoice };
