/** Timing-safe-ish API key check via SHA-256 digests. */

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return new Uint8Array(buf);
}

export async function timingSafeEqualStr(a, b) {
  const [ha, hb] = await Promise.all([sha256(String(a || "")), sha256(String(b || ""))]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

export function extractApiKey(request) {
  const h = request.headers.get("x-api-key");
  if (h) return h.trim();
  const auth = request.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

export async function requireApiKey(request, env) {
  const expected = (env.API_KEY || "").trim();
  if (!expected) {
    return { ok: false, status: 503, error: "API_KEY not set — wrangler secret put API_KEY" };
  }
  const got = extractApiKey(request);
  if (!got || !(await timingSafeEqualStr(got, expected))) {
    return { ok: false, status: 401, error: "unauthorized" };
  }
  return { ok: true };
}

/** Basic auth for the dashboard (public-facing). Uses timing-safe compare. */
export async function requireBasicAuth(request, env) {
  const user = (env.DASH_USER || "").trim();
  const pass = (env.DASH_PASS || "").trim();
  if (!user || !pass) return { ok: false, status: 503, error: "DASH_USER/DASH_PASS not set" };
  const auth = request.headers.get("authorization") || "";
  const m = auth.match(/^Basic\s+(.+)$/i);
  if (!m) return { ok: false, status: 401, error: "unauthorized" };
  let decoded;
  try {
    decoded = atob(m[1]);
  } catch {
    return { ok: false, status: 401, error: "unauthorized" };
  }
  const i = decoded.indexOf(":");
  const gotUser = i >= 0 ? decoded.slice(0, i) : "";
  const gotPass = i >= 0 ? decoded.slice(i + 1) : "";
  if (!(await timingSafeEqualStr(gotUser, user)) || !(await timingSafeEqualStr(gotPass, pass))) {
    return { ok: false, status: 401, error: "unauthorized" };
  }
  return { ok: true };
}
