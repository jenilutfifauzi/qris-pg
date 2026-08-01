/** Unofficial GoBiz mutasi client. Personal use. Can break anytime. */

export const TX_URL =
  "https://api.gojekapi.com/merchant-analytics/v2/merchants/transactions";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export function buildHeaders(accessToken) {
  const token = String(accessToken || "").replace(/^Bearer\s+/i, "").trim();
  return {
    Authorization: `Bearer ${token}`,
    "Authentication-Type": "go-id",
    Accept: "application/json, text/plain, */*",
    Origin: "https://portal.gofoodmerchant.co.id",
    Referer: "https://portal.gofoodmerchant.co.id/",
    "User-Agent": UA,
  };
}

/** gross_amount API = IDR × 100 */
export function normalizeTx(t) {
  const raw = Number.parseInt(
    t.gross_amount ?? t.real_gross_amount ?? t.amount?.value ?? t.amount ?? 0,
    10
  );
  return {
    transaction_id: t.id || t.order_id || t.wallstreet_transaction_id || null,
    amount: Number.isFinite(raw) ? Math.round(raw / 100) : 0,
    amount_raw: Number.isFinite(raw) ? raw : 0,
    time: t.transaction_time || t.settlement_time || t.created_at || null,
    issuer: t.qris_provider_aspi_issuer || "GoPay",
    payment_type: t.payment_type || "QRIS",
    status: t.transaction_status || null,
  };
}

/**
 * @param {{ merchantId: string, token: string, lookbackHours?: number, size?: number, startTime?: string|Date }} opts
 */
export async function fetchTransactions(opts) {
  const { merchantId, token } = opts;
  if (!merchantId) throw Object.assign(new Error("merchantId missing"), { code: "NO_MERCHANT" });
  if (!token) throw Object.assign(new Error("token missing"), { code: "NO_TOKEN" });

  const now = new Date();
  const lookbackMs = (opts.lookbackHours ?? 6) * 3600 * 1000;
  let start = opts.startTime ? new Date(opts.startTime) : new Date(now.getTime() - lookbackMs);
  if (Number.isNaN(start.getTime())) start = new Date(now.getTime() - lookbackMs);
  const startPadded = new Date(start.getTime() - 2 * 60 * 1000);

  const params = new URLSearchParams({
    from: "0",
    size: String(opts.size ?? 30),
    statuses: "SETTLEMENT,CAPTURE,REFUND,PARTIAL_REFUND",
    payment_types: "QRIS,GOPAY,OFFLINE_CREDIT_CARD,OFFLINE_DEBIT_CARD,CREDIT_CARD",
    start_time: startPadded.toISOString(),
    end_time: now.toISOString(),
    merchant_ids: merchantId,
  });

  const res = await fetch(`${TX_URL}?${params}`, {
    method: "GET",
    headers: buildHeaders(token),
    signal: AbortSignal.timeout(15_000),
  });

  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error(`auth failed HTTP ${res.status}`), {
      code: "AUTH_FAILED",
      status: res.status,
    });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw Object.assign(new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`), {
      code: "HTTP_ERROR",
      status: res.status,
    });
  }

  const data = await res.json();
  const list = data?.transactions || data?.data?.transactions || [];
  return list.map(normalizeTx);
}

export async function testConnection({ merchantId, token }) {
  const started = Date.now();
  try {
    const txs = await fetchTransactions({ merchantId, token, size: 5, lookbackHours: 24 });
    return {
      ok: true,
      count: txs.length,
      ms: Date.now() - started,
      sample: txs.slice(0, 3),
    };
  } catch (e) {
    return {
      ok: false,
      ms: Date.now() - started,
      error: e.message,
      code: e.code || "ERROR",
    };
  }
}

/**
 * Exchange GoBiz refresh token for a fresh pair (rotating — old one dies).
 * Endpoint + headers reverse-engineered from portal.gofoodmerchant.co.id
 * bundle (chunk 1260: ry() → POST {REACT_APP_MARS_API_HOST}/goid/token).
 * @returns {Promise<{accessToken: string, refreshToken: string}>}
 */
export async function refreshAccessToken(refreshToken) {
  const token = String(refreshToken || "").trim();
  if (!token) throw Object.assign(new Error("refresh token missing"), { code: "NO_REFRESH" });

  const res = await fetch("https://api.gobiz.co.id/goid/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authentication-Type": "go-id",
      "X-PhoneMake": "macOS",
      "X-PhoneModel": "Macintosh",
      "x-DeviceOS": "Web",
      "Accept-Language": "id",
      "X-User-Locale": "id-ID",
      "X-AppVersion": "-",
      "Gojek-Country-Code": "ID",
      "Gojek-Timezone": "Asia/Jakarta",
      "X-Platform": "Web",
      "X-User-Type": "merchant",
      "x-appId": "go-biz-web-dashboard",
      "X-UniqueId": crypto.randomUUID(),
      "User-Agent": UA,
    },
    body: JSON.stringify({
      client_id: "go-biz-web-new",
      grant_type: "refresh_token",
      data: { refresh_token: token },
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error(`refresh failed HTTP ${res.status}`), {
      code: "AUTH_FAILED",
      status: res.status,
    });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw Object.assign(new Error(`refresh HTTP ${res.status}: ${text.slice(0, 160)}`), {
      code: "HTTP_ERROR",
      status: res.status,
    });
  }

  const d = await res.json();
  if (!d?.access_token) {
    throw Object.assign(new Error("refresh response missing access_token"), { code: "REFRESH_ERROR" });
  }
  return { accessToken: d.access_token, refreshToken: d.refresh_token || token };
}
