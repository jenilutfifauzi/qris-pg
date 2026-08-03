import {
  claimPollLock,
  expireOld,
  findPendingByAmount,
  getConfig,
  getSetting,
  isTxClaimed,
  listPending,
  markPaid,
  setSetting,
} from "./db.js";
import { fetchTransactions, refreshAccessToken } from "./gobiz.js";

/** Callback signing secret — separate from the API auth key so a merchant who
 * holds API_KEY cannot forge callback signatures. Falls back to API_KEY when
 * CALLBACK_SECRET is not set (backwards compatible). */
export function callbackSecret(env) {
  return env.CALLBACK_SECRET || env.API_KEY;
}

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
        // idempotency: consumer MUST dedup by tx_id (double-fire possible on worker crash)
        "Idempotency-Key": invoice.tx_id || invoice.id,
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
      // RETURNING gives us the new count so we can alert exactly when a callback
      // is permanently dropped (attempts >= 5) instead of failing silently.
      const row = await db
        .prepare(
          `UPDATE invoices SET callback_attempts = callback_attempts + 1
           WHERE id = ? RETURNING callback_attempts`
        )
        .bind(inv.id)
        .first();
      if ((row?.callback_attempts ?? 0) >= 5) {
        console.error(
          JSON.stringify({
            message: "callback give-up — no more retries",
            id: inv.id,
            attempts: row.callback_attempts,
            error: r.error || `HTTP ${r.status}`,
          })
        );
      }
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
  // concurrency lock: cron + manual /api/poll + opportunistic GET can overlap.
  // Lock expires automatically after 45s, so a crashed poll never wedges the loop.
  if (!(await claimPollLock(db))) {
    return { skipped: true, reason: "poll in progress — lock held by another poll" };
  }
  const expired = await expireOld(db);
  // retry callbacks FIRST — must run even with zero pending invoices,
  // otherwise a failed callback is stuck forever until a new invoice appears
  const retried = await retryUnsentCallbacks(db, callbackSecret(env));
  const pending = await listPending(db);
  if (!pending.length) return { expired, matched: 0, pending: 0, retried: retried.sent };

  const cfg = await getConfig(db);
  if (!cfg.merchantId || !cfg.token) {
    return { expired, matched: 0, pending: pending.length, error: "not configured" };
  }

  let txs;
  let refreshed = false;
  try {
    txs = await fetchTransactions({
      merchantId: cfg.merchantId,
      token: cfg.token,
      lookbackHours: cfg.lookbackHours,
      size: 40,
    });
  } catch (e) {
    // token expired → auto-refresh via stored refresh token (rotating), retry once
    if (e.code === "AUTH_FAILED") {
      const rt = await getSetting(db, "gobiz_refresh");
      if (!rt) {
        return {
          expired,
          matched: 0,
          pending: pending.length,
          error: "AUTH_FAILED — no refresh token configured (set gobiz_refresh)",
          code: "AUTH_FAILED",
        };
      }
      // cooldown: refresh token is single-use/rotating — concurrent polls
      // (cron + opportunistic) must not both consume it or the 2nd dies.
      // Atomic claim: only ONE poll can reserve the refresh window; losers
      // fall through to the cooldown error instead of double-refreshing.
      const claimed = await db
        .prepare(
          `INSERT INTO settings (key, value) VALUES ('last_refresh_at', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value
           WHERE CAST(settings.value AS INTEGER) <= ?`
        )
        .bind(String(Date.now()), Date.now() - 60_000)
        .run();
      if ((claimed?.meta?.changes ?? 0) === 0) {
        return {
          expired,
          matched: 0,
          pending: pending.length,
          error: "AUTH_FAILED — refresh in cooldown (concurrent poll?), retry next minute",
          code: "AUTH_FAILED",
        };
      }
      try {
        const pair = await refreshAccessToken(rt);
        await setSetting(db, "gobiz_token", pair.accessToken);
        if (pair.refreshToken && pair.refreshToken !== rt) {
          await setSetting(db, "gobiz_refresh", pair.refreshToken);
        }
        refreshed = true;
        console.log(JSON.stringify({ message: "gobiz token auto-refreshed" }));
        txs = await fetchTransactions({
          merchantId: cfg.merchantId,
          token: pair.accessToken,
          lookbackHours: cfg.lookbackHours,
          size: 40,
        });
      } catch (e2) {
        return {
          expired,
          matched: 0,
          pending: pending.length,
          error: `AUTH_FAILED (refresh: ${e2.message})`,
          code: e2.code || "AUTH_FAILED",
        };
      }
    } else {
      return {
        expired,
        matched: 0,
        pending: pending.length,
        error: e.message,
        code: e.code,
      };
    }
  }

  let matched = 0;
  for (const t of txs) {
    if (!t.transaction_id || !t.amount) continue;
    // only forward payments settle invoices — refunds must never match a pending invoice
    if (t.status && t.status !== "SETTLEMENT" && t.status !== "CAPTURE") continue;
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
    const cb = await sendCallback(paid, callbackSecret(env));
    if (cb.ok) {
      await db.prepare("UPDATE invoices SET callback_sent = 1 WHERE id = ?").bind(paid.id).run();
    }
  }

  return { expired, matched, pending: pending.length, scanned: txs.length, retried: retried.sent, refreshed };
}
