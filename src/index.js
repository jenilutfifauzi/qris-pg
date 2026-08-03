/**
 * qris-pg — minimal QRIS payment gateway on Cloudflare Workers.
 *
 * API (X-API-Key or Bearer):
 *   POST /api/invoices          create
 *   GET  /api/invoices/:id      status
 *   GET  /api/invoices          list
 *   GET  /api/settings          read config (token masked)
 *   PUT  /api/settings          save merchant / token / qris static
 *   POST /api/test-connection   probe GoBiz mutasi
 *   POST /api/poll              force poll now
 *   GET  /api/health
 *
 * Cron: every minute → poll mutasi + callback
 * WebUI: public/ (static assets)
 */
import { requireApiKey, requireBasicAuth } from "./auth.js";
import {
  allocateUniqueAmount,
  createInvoice,
  findPendingByRef,
  getConfig,
  getInvoice,
  getSetting,
  getSettings,
  listInvoices,
  publicInvoice,
  rateLimit,
  setSetting,
} from "./db.js";
import { testConnection } from "./gobiz.js";
import { runPoll, sendCallback, callbackSecret } from "./poll.js";
import { staticToDynamic, validateQris } from "./qris.js";

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // No CORS headers on purpose: the dashboard is same-origin (served by this
      // worker's assets), so wildcard ACAO would only open responses to any site.
      ...extra,
    },
  });
}

function err(message, status = 400, code = "ERROR") {
  return json({ error: message, code }, status);
}

async function readJson(request) {
  const raw = await request.text();
  if (raw.length > 100_000) throw new Error("payload too large");
  if (!raw) return {};
  return JSON.parse(raw);
}

// Never return token material — only a boolean flag to the client.
function tokenSet(t) {
  return Boolean(t && String(t).length > 0);
}

// SSRF guard: callback must be public http(s), not loopback/private/link-local.
function isSafeCallbackUrl(u) {
  let p;
  try {
    p = new URL(u);
  } catch {
    return false;
  }
  if (p.protocol !== "http:" && p.protocol !== "https:") return false;
  const h = p.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return false;
  if (/^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  if (h === "::1" || h === "[::1]") return false;
  return true;
}

function isoPlusMinutes(min) {
  return new Date(Date.now() + min * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;

  if (method === "OPTIONS") return json({}, 204);

  if (method === "GET" && path === "/api/health") {
    return json({ ok: true, service: "qris-pg", ts: new Date().toISOString() });
  }

  const auth = await requireApiKey(request, env);
  if (!auth.ok) return err(auth.error, auth.status, "UNAUTHORIZED");

  // ── settings ──────────────────────────────────────────────
  if (method === "GET" && path === "/api/settings") {
    const s = await getSettings(env.DB);
    return json({
      merchant_id: s.merchant_id || "",
      gobiz_token_set: tokenSet(s.gobiz_token),
      gobiz_refresh_set: tokenSet(s.gobiz_refresh),
      // QRIS static is merchant-facing payload (sticker); still only returned to API-key holders
      qris_static: s.qris_static || "",
      qris_static_set: Boolean(s.qris_static),
      default_callback: s.default_callback || "",
      lookback_hours: Number(s.lookback_hours || 6),
      default_expire_min: Number(env.DEFAULT_EXPIRE_MIN || 30),
    });
  }

  if (method === "PUT" && path === "/api/settings") {
    let body;
    try {
      body = await readJson(request);
    } catch {
      return err("invalid JSON", 400, "BAD_JSON");
    }

    if (body.merchant_id != null) await setSetting(env.DB, "merchant_id", String(body.merchant_id).trim());
    if (body.gobiz_token != null && String(body.gobiz_token).trim()) {
      const tok = String(body.gobiz_token).replace(/^Bearer\s+/i, "").trim();
      await setSetting(env.DB, "gobiz_token", tok);
    }
    if (body.gobiz_refresh != null && String(body.gobiz_refresh).trim()) {
      await setSetting(env.DB, "gobiz_refresh", String(body.gobiz_refresh).trim());
    }
    if (body.qris_static != null) {
      const q = String(body.qris_static).trim();
      if (q) {
        const v = validateQris(q);
        if (!v.valid) return err(`QRIS static invalid: ${v.error || "CRC"}`, 400, "INVALID_QRIS");
        await setSetting(env.DB, "qris_static", q);
      }
    }
    if (body.default_callback != null) {
      const cb = String(body.default_callback).trim();
      if (cb && !isSafeCallbackUrl(cb)) return err("callback_url must be http(s) and not internal", 400, "INVALID_CALLBACK");
      await setSetting(env.DB, "default_callback", cb);
    }
    if (body.lookback_hours != null) {
      await setSetting(env.DB, "lookback_hours", String(Math.min(72, Math.max(1, Number(body.lookback_hours) || 6))));
    }
    return json({ ok: true });
  }

  if (method === "POST" && path === "/api/test-connection") {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!(await rateLimit(env.DB, `test:${ip}`, 5))) {
      return json({ error: "rate limit exceeded", code: "RATE_LIMITED" }, 429, { "Retry-After": "60" });
    }
    const cfg = await getConfig(env.DB);
    if (!cfg.merchantId || !cfg.token) return err("set merchant_id + gobiz_token first", 400, "NOT_CONFIGURED");
    const result = await testConnection({ merchantId: cfg.merchantId, token: cfg.token });
    return json(result, result.ok ? 200 : 502);
  }

  if (method === "POST" && path === "/api/poll") {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!(await rateLimit(env.DB, `poll:${ip}`, 5))) {
      return json({ error: "rate limit exceeded", code: "RATE_LIMITED" }, 429, { "Retry-After": "60" });
    }
    const result = await runPoll(env);
    return json(result);
  }

  // ── invoices ──────────────────────────────────────────────
  if (method === "POST" && path === "/api/invoices") {
    let body;
    try {
      body = await readJson(request);
    } catch {
      return err("invalid JSON", 400, "BAD_JSON");
    }

    const base = Math.floor(Number(body.amount));
    if (!Number.isFinite(base) || base < 1) return err("amount must be positive integer IDR", 400, "INVALID_AMOUNT");

    // ponytail: 10/min/IP, bump via env var if a real merchant outgrows it
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!(await rateLimit(env.DB, `inv:${ip}`, 10))) {
      return json({ error: "rate limit exceeded", code: "RATE_LIMITED" }, 429, { "Retry-After": "60" });
    }

    const cfg = await getConfig(env.DB);
    if (!cfg.qrisStatic) return err("qris_static not set — open WebUI setup", 400, "NOT_CONFIGURED");

    const merchantRef = body.merchant_ref ? String(body.merchant_ref).slice(0, 128) : null;
    const existing = await findPendingByRef(env.DB, merchantRef);
    if (existing) {
      // no qr_url on purpose — QR dirender client-side dari qris_payload
      // (payload QRIS tidak dikirim ke service pihak ketiga manapun)
      return json(publicInvoice(existing), 201);
    }

    // clamp: 1 min … 24h (no unbounded pending invoices)
    const expireMin = Math.min(1440, Math.max(1, Number(body.expire_min ?? env.DEFAULT_EXPIRE_MIN ?? 30)));
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const callback =
      (body.callback_url && String(body.callback_url).trim()) ||
      cfg.defaultCallback ||
      null;
    if (callback && !isSafeCallbackUrl(callback)) {
      return err("callback_url must be http(s) and not internal", 400, "INVALID_CALLBACK");
    }

    // retry on amount collision race (partial unique index makes dup pending amounts impossible)
    let inv = null;
    for (let attempt = 0; attempt < 5 && !inv; attempt++) {
      const { amount, uniqueCode } = await allocateUniqueAmount(env.DB, base);
      let qris;
      try {
        qris = staticToDynamic(cfg.qrisStatic, amount);
      } catch (e) {
        return err(e.message, 400, e.code || "QRIS_ERROR");
      }
      try {
        inv = await createInvoice(env.DB, {
          id,
          merchantRef,
          amount,
          baseAmount: base,
          uniqueCode,
          qrisPayload: qris,
          callbackUrl: callback,
          expiresAt: isoPlusMinutes(expireMin),
        });
      } catch (e) {
        if (!/unique/i.test(String(e.message || ""))) throw e;
      }
    }
    if (!inv) {
      // concurrent create may have won the merchant_ref race (unique partial index)
      const winner = await findPendingByRef(env.DB, merchantRef);
      if (winner) {
        return json(publicInvoice(winner), 201);
      }
      return err("unique amount exhausted — try again", 409, "AMOUNT_EXHAUSTED");
    }

    return json(publicInvoice(inv), 201);
  }

  if (method === "GET" && path === "/api/invoices") {
    const status = url.searchParams.get("status") || undefined;
    const limit = url.searchParams.get("limit");
    const rows = await listInvoices(env.DB, { status, limit });
    return json({ invoices: rows.map(publicInvoice) });
  }

  // manual callback resend — POST /api/invoices/:id/resend
  const resendMatch = path.match(/^\/api\/invoices\/([a-zA-Z0-9_-]+)\/resend$/);
  if (method === "POST" && resendMatch) {
    const inv = await getInvoice(env.DB, resendMatch[1]);
    if (!inv) return err("not found", 404, "NOT_FOUND");
    if (!inv.callback_url) return err("invoice tanpa callback url", 400, "NO_CALLBACK");
    const r = await sendCallback(inv, callbackSecret(env));
    if (r.ok) {
      await env.DB.prepare("UPDATE invoices SET callback_sent = 1, callback_attempts = 0 WHERE id = ?").bind(inv.id).run();
      return json({ ok: true, status: r.status });
    }
    await env.DB.prepare("UPDATE invoices SET callback_attempts = min(callback_attempts + 1, 5) WHERE id = ?").bind(inv.id).run();
    return err("callback gagal: " + (r.error || "http " + r.status), 502, "CALLBACK_FAILED");
  }

  const invMatch = path.match(/^\/api\/invoices\/([a-zA-Z0-9_-]+)$/);
  if (method === "GET" && invMatch) {
    const inv = await getInvoice(env.DB, invMatch[1]);
    if (!inv) return err("not found", 404, "NOT_FOUND");
    // opportunistic poll if still pending — throttled, 30s cooldown
    if (inv.status === "pending") {
      const last = Number((await getSetting(env.DB, "last_poll_at")) || 0);
      if (Date.now() - last > 30_000) {
        await setSetting(env.DB, "last_poll_at", String(Date.now()));
        ctx.waitUntil(runPoll(env));
      }
    }
    const fresh = (await getInvoice(env.DB, invMatch[1])) || inv;
    return json(publicInvoice(fresh));
  }

  return err("not found", 404, "NOT_FOUND");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, env, ctx);
      }
      // dashboard + static assets — basic auth (public-facing)
      const guard = await requireBasicAuth(request, env);
      if (!guard.ok) {
        return new Response(JSON.stringify({ error: guard.error }), {
          status: guard.status,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "WWW-Authenticate": 'Basic realm="qris-pg"',
          },
        });
      }
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response("qris-pg — set assets.directory", { status: 200 });
    } catch (e) {
      console.error(JSON.stringify({ message: "unhandled", error: e.message || String(e), stack: e.stack }));
      return err("internal error", 500, "INTERNAL");
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      runPoll(env)
        .then((r) => {
          console.log(JSON.stringify({ message: "cron poll", cron: controller.cron, ...r }));
        })
        .catch((e) => {
          console.error(JSON.stringify({ message: "cron poll failed", error: e.message || String(e), stack: e.stack }));
        })
    );
  },
};
