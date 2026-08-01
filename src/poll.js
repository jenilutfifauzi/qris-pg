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

/** Fire callback once. Best-effort. */
export async function sendCallback(invoice) {
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

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "qris-pg/1.0" },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
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
    await sendCallback(paid);
  }

  return { expired, matched, pending: pending.length, scanned: txs.length };
}

export { publicInvoice };
