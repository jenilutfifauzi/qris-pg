const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function apiKey() {
  return localStorage.getItem("qris_pg_api_key") || "";
}

function saveApiKey(v) {
  localStorage.setItem("qris_pg_api_key", v || "");
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const key = apiKey();
  if (key) headers["X-API-Key"] = key;
  if (opts.body && typeof opts.body === "object") {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, { ...opts, headers });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(data.error || res.statusText || "request failed");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function show(el, obj) {
  el.textContent = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
}

// tabs
document.querySelectorAll("nav [data-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("nav [data-tab]").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    btn.classList.add("active");
    $("tab-" + btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "list") loadList();
  });
});

$("apiKey").value = apiKey();
$("apiKey").addEventListener("change", () => {
  saveApiKey($("apiKey").value.trim());
  loadSettings();
});
$("apiKey").addEventListener("blur", () => {
  saveApiKey($("apiKey").value.trim());
  loadSettings();
});

async function loadSettings() {
  saveApiKey($("apiKey").value.trim());
  try {
    const s = await api("/api/settings");
    $("merchantId").value = s.merchant_id || "";
    $("qrisStatic").value = s.qris_static || "";
    $("defaultCallback").value = s.default_callback || "";
    $("lookbackHours").value = s.lookback_hours || 6;
    $("gobizToken").placeholder = s.gobiz_token_set
      ? "sudah tersimpan — paste baru hanya kalau mau ganti"
      : "paste Bearer dari Network portal";
    $("gobizRefresh").placeholder = s.gobiz_refresh_set
      ? "sudah tersimpan — paste baru hanya kalau mau ganti"
      : "dari cookie refresh_token portal";
    show($("setupOut"), { loaded: true, token_set: s.gobiz_token_set, refresh_set: s.gobiz_refresh_set, qris_set: s.qris_static_set });
  } catch (e) {
    show($("setupOut"), { error: e.message, hint: e.status === 401 ? "API key salah / belum di-set" : "" });
  }
}

$("btnSave").onclick = async () => {
  saveApiKey($("apiKey").value.trim());
  const body = {};
  if ($("merchantId").value.trim()) body.merchant_id = $("merchantId").value.trim();
  if ($("qrisStatic").value.trim()) body.qris_static = $("qrisStatic").value.trim();
  if ($("defaultCallback").value.trim()) body.default_callback = $("defaultCallback").value.trim();
  body.lookback_hours = Number($("lookbackHours").value) || 6;
  const tok = $("gobizToken").value.trim();
  if (tok) body.gobiz_token = tok;
  const rtok = $("gobizRefresh").value.trim();
  if (rtok) body.gobiz_refresh = rtok;
  try {
    await api("/api/settings", { method: "PUT", body });
    $("gobizToken").value = "";
    $("gobizRefresh").value = "";
    show($("setupOut"), { ok: true, saved: Object.keys(body) });
    await loadSettings();
  } catch (e) {
    show($("setupOut"), { error: e.message, ...e.data });
  }
};

$("btnTest").onclick = async () => {
  saveApiKey($("apiKey").value.trim());
  try {
    const r = await api("/api/test-connection", { method: "POST", body: {} });
    show($("setupOut"), r);
  } catch (e) {
    show($("setupOut"), { error: e.message, ...e.data });
  }
};

$("btnPoll").onclick = async () => {
  saveApiKey($("apiKey").value.trim());
  try {
    const r = await api("/api/poll", { method: "POST", body: {} });
    show($("setupOut"), r);
  } catch (e) {
    show($("setupOut"), { error: e.message, ...e.data });
  }
};

$("btnCreate").onclick = async () => {
  saveApiKey($("apiKey").value.trim());
  $("createResult").hidden = true;
  const body = {
    amount: Number($("amount").value),
    merchant_ref: $("merchantRef").value.trim() || undefined,
    expire_min: Number($("expireMin").value) || 30,
  };
  const cb = $("callbackUrl").value.trim();
  if (cb) body.callback_url = cb;
  try {
    const inv = await api("/api/invoices", { method: "POST", body });
    $("resId").textContent = inv.id;
    $("resAmount").textContent = "Rp" + Number(inv.amount).toLocaleString("id-ID");
    $("resUnique").textContent = inv.unique_code ? `(+${inv.unique_code} unik)` : "";
    $("resStatus").textContent = inv.status;
    $("resExp").textContent = inv.expires_at;
    // QR dirender lokal dari payload — tidak mengirim data QRIS ke service pihak ketiga
    if (typeof qrcode === "function") {
      const qr = qrcode(0, "M");
      qr.addData(inv.qris_payload);
      qr.make();
      $("resQr").src = qr.createDataURL(8, 4);
      $("resQr").hidden = false;
    } else {
      $("resQr").hidden = true; // CDN lib gagal dimuat — QR tidak bisa dirender lokal
    }
    $("resPayload").textContent = inv.qris_payload;
    $("createResult").hidden = false;
    show($("createOut"), inv);
  } catch (e) {
    show($("createOut"), { error: e.message, ...e.data });
  }
};

function fmtRp(n) {
  return "Rp" + Number(n).toLocaleString("id-ID");
}

async function loadList() {
  saveApiKey($("apiKey").value.trim());
  const status = $("filterStatus").value;
  const q = status ? `?status=${encodeURIComponent(status)}` : "";
  try {
    const { invoices } = await api("/api/invoices" + q);
    const tbody = $("invBody");
    tbody.innerHTML = "";
    for (const inv of invoices || []) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><code>${esc(inv.id)}</code></td>
        <td>${esc(inv.merchant_ref || "—")}</td>
        <td>${fmtRp(inv.amount)}</td>
        <td class="status-${esc(inv.status)}">${esc(inv.status)}</td>
        <td>${esc(inv.created_at || "")}</td>`;
      tbody.appendChild(tr);
    }
    show($("listOut"), { count: (invoices || []).length });
  } catch (e) {
    show($("listOut"), { error: e.message, ...e.data });
  }
}

$("btnRefresh").onclick = loadList;
$("filterStatus").onchange = loadList;

loadSettings();
