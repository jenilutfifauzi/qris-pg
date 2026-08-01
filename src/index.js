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
import { requireApiKey } from "./auth.js";
import {
  allocateUniqueAmount,
  createInvoice,
  getConfig,
  getInvoice,
  getSettings,
  listInvoices,
  publicInvoice,
  setSetting,
} from "./db.js";
import { testConnection } from "./gobiz.js";
import { runPoll } from "./poll.js";
import { staticToDynamic, validateQris } from "./qris.js";

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type,X-API-Key,Authorization",
      "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
      ...extra,
    },
  });
}

function err(message, status = 400, code = "ERROR") {
  return json({ error: message, code }, status);
}

async function readJson(request) {
  const raw = await request.text();
  if (!raw) return {};
  return JSON.parse(raw);
}

// Never return token material — only a boolean flag to the client.
function tokenSet(t) {
  return Boolean(t && String(t).length > 0);
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
    if (body.qris_static != null) {
      const q = String(body.qris_static).trim();
      if (q) {
        const v = validateQris(q);
        if (!v.valid) return err(`QRIS static invalid: ${v.error || "CRC"}`, 400, "INVALID_QRIS");
        await setSetting(env.DB, "qris_static", q);
      }
    }
    if (body.default_callback != null) {
      await setSetting(env.DB, "default_callback", String(body.default_callback).trim());
    }
    if (body.lookback_hours != null) {
      await setSetting(env.DB, "lookback_hours", String(Math.max(1, Number(body.lookback_hours) || 6)));
    }
    return json({ ok: true });
  }

  if (method === "POST" && path === "/api/test-connection") {
    const cfg = await getConfig(env.DB);
    if (!cfg.merchantId || !cfg.token) return err("set merchant_id + gobiz_token first", 400, "NOT_CONFIGURED");
    const result = await testConnection({ merchantId: cfg.merchantId, token: cfg.token });
    return json(result, result.ok ? 200 : 502);
  }

  if (method === "POST" && path === "/api/poll") {
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

    const cfg = await getConfig(env.DB);
    if (!cfg.qrisStatic) return err("qris_static not set — open WebUI setup", 400, "NOT_CONFIGURED");

    const expireMin = Math.max(1, Number(body.expire_min ?? env.DEFAULT_EXPIRE_MIN ?? 30));
    const { amount, uniqueCode } = await allocateUniqueAmount(env.DB, base);

    let qris;
    try {
      qris = staticToDynamic(cfg.qrisStatic, amount);
    } catch (e) {
      return err(e.message, 400, e.code || "QRIS_ERROR");
    }

    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const callback =
      (body.callback_url && String(body.callback_url).trim()) ||
      cfg.defaultCallback ||
      null;

    const inv = await createInvoice(env.DB, {
      id,
      merchantRef: body.merchant_ref ? String(body.merchant_ref).slice(0, 128) : null,
      amount,
      baseAmount: base,
      uniqueCode,
      qrisPayload: qris,
      callbackUrl: callback,
      expiresAt: isoPlusMinutes(expireMin),
    });

    return json(
      {
        ...publicInvoice(inv),
        qr_url: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qris)}`,
      },
      201
    );
  }

  if (method === "GET" && path === "/api/invoices") {
    const status = url.searchParams.get("status") || undefined;
    const limit = url.searchParams.get("limit");
    const rows = await listInvoices(env.DB, { status, limit });
    return json({ invoices: rows.map(publicInvoice) });
  }

  const invMatch = path.match(/^\/api\/invoices\/([a-zA-Z0-9_-]+)$/);
  if (method === "GET" && invMatch) {
    const inv = await getInvoice(env.DB, invMatch[1]);
    if (!inv) return err("not found", 404, "NOT_FOUND");
    // opportunistic poll if still pending
    if (inv.status === "pending") {
      ctx.waitUntil(runPoll(env));
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
      // static assets (WebUI) served by platform when path matches;
      // SPA fallback via not_found_handling
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response("qris-pg — set assets.directory", { status: 200 });
    } catch (e) {
      console.error(JSON.stringify({ message: "unhandled", error: e.message || String(e) }));
      return err(e.message || "internal error", 500, e.code || "INTERNAL");
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      runPoll(env).then((r) => {
        console.log(JSON.stringify({ message: "cron poll", cron: controller.cron, ...r }));
      })
    );
  },
};
