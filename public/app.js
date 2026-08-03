/* qris-pg dashboard — vanilla JS.
   Seluruh business logic dipertahankan dari versi sebelumnya (settings, create,
   list, poll, test-connection). Perubahan hanya lapisan presentasi + UX. */
"use strict";

const $ = (id) => document.getElementById(id);
const CLERK_PK = (document.querySelector("meta[name='clerk-publishable-key']") || {}).content || "";

function esc(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

/* icon from the inline sprite — whitelist only (no user input ever reaches this) */
function icon(name) {
  return `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

/* ── API ─────────────────────────────────────────────── */
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

function debugOut(id, obj) {
  const pre = $(id);
  if (pre) pre.textContent = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
}

/* ── UI helpers ──────────────────────────────────────── */
function fmtRp(n) {
  return "Rp" + Number(n).toLocaleString("id-ID");
}
function fmtRel(iso) {
  if (!iso) return "—";
  const t = new Date(iso.endsWith("Z") || iso.includes("+") ? iso : iso.replace(" ", "T") + "Z").getTime();
  if (!Number.isFinite(t)) return iso;
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return "baru saja";
  if (s < 3600) return Math.floor(s / 60) + " m lalu";
  if (s < 86400) return Math.floor(s / 3600) + " j lalu";
  if (s < 604800) return Math.floor(s / 86400) + " h lalu";
  return new Date(t).toLocaleDateString("id-ID", { day: "numeric", month: "short" });
}
function fmtDt(iso) {
  if (!iso) return "—";
  const d = new Date(iso.endsWith("Z") || iso.includes("+") ? iso : iso.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("id-ID", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function badgeCls(status) {
  return status === "paid" ? "badge-paid" : status === "expired" ? "badge-expired" : "badge-pending";
}
function statusLabel(status) {
  return status === "paid" ? "Lunas" : status === "expired" ? "Kadaluarsa" : "Pending";
}

function toast(title, msg, type = "info", ms = 4200) {
  const box = $("toasts");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  const tico = type === "success" ? "check" : type === "error" ? "alert" : "info";
  el.innerHTML = `<span class="t-ico">${icon(tico)}</span><div class="t-body"><div class="t-title">${esc(title)}</div><div class="t-msg">${esc(msg)}</div></div>`;
  box.appendChild(el);
  const kill = () => {
    if (!el.isConnected) return;
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 190);
  };
  setTimeout(kill, ms);
  el.addEventListener("click", kill);
}

async function copyText(text, label = "Disalin") {
  try {
    await navigator.clipboard.writeText(text);
    toast(label, "Tersalin ke clipboard.", "success", 2200);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      toast(label, "Tersalin ke clipboard.", "success", 2200);
    } catch {
      toast("Gagal menyalin", "Clipboard tidak tersedia di browser ini.", "error");
    }
    ta.remove();
  }
}

/* ── Tabs ────────────────────────────────────────────── */
const TAB_META = {
  setup: ["Dashboard", "Ringkasan status gateway QRIS"],
  create: ["Buat Invoice", "Generate QRIS dinamis dengan kode unik"],
  list: ["Invoices", "Riwayat pembayaran & status"],
};
let currentTab = "setup";

function switchTab(name) {
  currentTab = name;
  document.querySelectorAll(".side-item").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + name));
  $("pageTitle").textContent = TAB_META[name][0];
  $("pageSub").textContent = TAB_META[name][1];
  closeSidebar();
  if (name === "list") loadList();
  if (name === "setup") loadSettings();
}

document.querySelectorAll("[data-tab]").forEach((el) => {
  el.addEventListener("click", (e) => {
    e.preventDefault();
    switchTab(el.dataset.tab);
  });
});

/* ── Sidebar (mobile) ────────────────────────────────── */
const sidebar = $("sidebar");
const scrim = $("scrim");
function openSidebar() {
  sidebar.classList.add("open");
  scrim.hidden = false;
}
function closeSidebar() {
  sidebar.classList.remove("open");
  scrim.hidden = true;
}
$("btnMenu").addEventListener("click", () => (sidebar.classList.contains("open") ? closeSidebar() : openSidebar()));
scrim.addEventListener("click", closeSidebar);

/* ── Dropdowns (bell + user) ─────────────────────────── */
function closeDd(menu) {
  menu.hidden = true;
}
$("btnBell").addEventListener("click", (e) => {
  e.stopPropagation();
  const menu = $("bellMenu");
  $("userMenu").hidden = true;
  menu.hidden = !menu.hidden;
  if (!menu.hidden) renderBell();
});
$("btnUser").addEventListener("click", (e) => {
  e.stopPropagation();
  const menu = $("userMenu");
  $("bellMenu").hidden = true;
  menu.hidden = !menu.hidden;
});
document.addEventListener("click", () => {
  $("bellMenu").hidden = true;
  $("userMenu").hidden = true;
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeModal();
    $("bellMenu").hidden = true;
    $("userMenu").hidden = true;
  }
});

function renderBell() {
  const menu = $("bellMenu");
  const last = localStorage.getItem("qris_pg_last_poll");
  if (last) {
    let parsed;
    try {
      parsed = JSON.parse(last);
    } catch {
      parsed = null;
    }
    if (parsed) {
      const when = parsed.ts ? fmtRel(parsed.ts) : "terakhir";
      menu.innerHTML = `
        <div class="dd-title">Poll terakhir · ${when}</div>
        <div class="dd-note">${esc(JSON.stringify(parsed, null, 2))}</div>
        <div class="dd-sep"></div>
        <button type="button" id="bellPoll">${icon("refresh")}Jalankan poll sekarang</button>`;
      menu.querySelector("#bellPoll").addEventListener("click", () => {
        closeDd(menu);
        doPoll();
      });
      return;
    }
  }
  menu.innerHTML = `
    <div class="dd-title">Notifikasi</div>
    <div class="dd-note">Belum ada hasil poll. Poll otomatis berjalan tiap menit via cron.</div>
    <div class="dd-sep"></div>
    <button type="button" id="bellPoll">${icon("refresh")}Jalankan poll sekarang</button>`;
  menu.querySelector("#bellPoll").addEventListener("click", () => {
    closeDd(menu);
    doPoll();
  });
}

$("userMenu").addEventListener("click", (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (!act) return;
  closeDd($("userMenu"));
  if (act === "reload") {
    loadSettings();
    if (currentTab === "list") loadList();
    toast("Data dimuat ulang", "Status & daftar invoice disegarkan.", "success", 2000);
  }
  if (act === "clear") {
    saveApiKey("");
    localStorage.removeItem("qris_pg_last_poll");
    toast("API key dihapus", "Key hanya tersimpan di browser Anda — paste ulang saat diperlukan.", "info");
    setTimeout(() => location.reload(), 900);
  }
  if (act === "logout") {
    closeDd($("userMenu"));
    if (window.Clerk) window.Clerk.signOut(); // listener renderAuth -> kembali ke layar login
  }
});

/* ── Conn state + clock ──────────────────────────────── */
async function checkHealth() {
  try {
    const r = await fetch("/api/health", { cache: "no-store" });
    const ok = r.ok;
    $("connDot").className = "dot " + (ok ? "dot-live" : "dot-down");
    $("connLabel").textContent = ok ? "Gateway aktif" : "Gateway error";
    $("connDetail").textContent = ok ? "cron poll tiap menit" : "HTTP " + r.status;
  } catch {
    $("connDot").className = "dot dot-down";
    $("connLabel").textContent = "Tidak terhubung";
    $("connDetail").textContent = "cek koneksi / server";
  }
}
function tickClock() {
  $("footClock").textContent = new Date().toLocaleString("id-ID", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* ── Setup tab ───────────────────────────────────────── */
function statCard(ico, icoCls, label, val, sub, small) {
  return `<div class="stat-card">
    <span class="stat-ico ${icoCls}">${icon(ico)}</span>
    <div class="stat-body">
      <div class="stat-label">${esc(label)}</div>
      <div class="stat-val${small ? " small" : ""}" title="${esc(val)}">${esc(val)}</div>
      <div class="stat-sub">${esc(sub)}</div>
    </div>
  </div>`;
}

function renderSetupStats(s) {
  const tokenState = s.gobiz_token_set ? ["check", "green", "Tersimpan", "auto-refresh aktif"] : ["x", "gray", "Belum di-set", "paste Bearer di form"];
  const refreshState = s.gobiz_refresh_set ? ["check", "green", "Tersimpan", "rotating — jangan test berulang"] : ["x", "gray", "Belum di-set", "dari cookie portal"];
  const qrisState = s.qris_static_set ? ["check", "green", "Tersimpan", "payload statis siap"] : ["x", "gray", "Belum di-set", "paste payload QRIS"];
  $("statSetup").innerHTML =
    statCard("store", "blue", "Merchant ID", s.merchant_id || "—", "GoBiz merchant", true) +
    statCard("key", tokenState[0] === "check" ? "green" : "gray", "Access Token", tokenState[0] === "check" ? "Tersimpan" : "Belum di-set", tokenState[2]) +
    statCard("refresh", refreshState[0] === "check" ? "green" : "gray", "Refresh Token", refreshState[0] === "check" ? "Tersimpan" : "Belum di-set", refreshState[2]) +
    statCard("qr", qrisState[0] === "check" ? "green" : "gray", "QRIS Static", qrisState[0] === "check" ? "Tersimpan" : "Belum di-set", qrisState[2]);
  const ready = Boolean(s.merchant_id) && s.gobiz_token_set && s.qris_static_set;
  $("cfgBadge").textContent = ready ? "siap produksi" : "konfigurasi belum lengkap";
  $("cfgBadge").className = "badge " + (ready ? "badge-paid" : "badge-soft");
}

async function loadSettings() {
  saveApiKey($("apiKey").value.trim());
  try {
    const s = await api("/api/settings");
    $("merchantId").value = s.merchant_id || "";
    $("qrisStatic").value = s.qris_static || "";
    $("defaultCallback").value = s.default_callback || "";
    $("lookbackHours").value = s.lookback_hours || 6;
    $("gobizToken").placeholder = s.gobiz_token_set ? "sudah tersimpan — paste baru hanya kalau mau ganti" : "paste Bearer dari Network portal";
    $("gobizRefresh").placeholder = s.gobiz_refresh_set ? "sudah tersimpan — paste baru hanya kalau mau ganti" : "dari cookie refresh_token portal";
    renderSetupStats(s);
    $("setupDbg").hidden = true;
  } catch (e) {
    renderSetupStats({ merchant_id: "", gobiz_token_set: false, gobiz_refresh_set: false, qris_static_set: false });
    $("cfgBadge").textContent = "API key belum valid";
    $("cfgBadge").className = "badge badge-soft";
    debugOut("setupOut", { error: e.message, hint: e.status === 401 ? "API key salah / belum di-set" : "" });
    $("setupDbg").hidden = false;
    toast(e.status === 401 ? "Unauthorized" : "Gagal memuat konfigurasi", e.message, "error");
  }
}

$("apiKey").addEventListener("input", () => saveApiKey($("apiKey").value.trim()));
$("apiKey").addEventListener("change", loadSettings);

$("btnEye").addEventListener("click", () => {
  const inp = $("apiKey");
  const show = inp.type === "password";
  inp.type = show ? "text" : "password";
  $("btnEye").innerHTML = icon(show ? "eye-off" : "eye");
});

$("btnSave").onclick = async () => {
  const btn = $("btnSave");
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
  btn.disabled = true;
  try {
    await api("/api/settings", { method: "PUT", body });
    $("gobizToken").value = "";
    $("gobizRefresh").value = "";
    debugOut("setupOut", { ok: true, saved: Object.keys(body) });
    $("setupDbg").hidden = false;
    await loadSettings();
    toast("Konfigurasi disimpan", Object.keys(body).length + " field diperbarui di D1.", "success");
  } catch (e) {
    debugOut("setupOut", { error: e.message, ...e.data });
    $("setupDbg").hidden = false;
    toast("Gagal menyimpan", e.message, "error");
  } finally {
    btn.disabled = false;
  }
};

async function doTest() {
  const btn = $("btnTest");
  saveApiKey($("apiKey").value.trim());
  btn.disabled = true;
  const svg = btn.querySelector("svg");
  svg.classList.add("spin");
  try {
    const r = await api("/api/test-connection", { method: "POST", body: {} });
    debugOut("setupOut", r);
    $("setupDbg").hidden = false;
    if (r.ok) {
      const n = r.transactions?.length ?? r.data?.length ?? 0;
      toast("Koneksi GoBiz OK", `Mutasi ditemukan: ${n} transaksi.`, "success");
    } else {
      toast("Test mutasi gagal", r.error || "lihat debug JSON", "error");
    }
  } catch (e) {
    debugOut("setupOut", { error: e.message, ...e.data });
    $("setupDbg").hidden = false;
    toast("Test mutasi gagal", e.message, "error");
  } finally {
    btn.disabled = false;
    svg.classList.remove("spin");
  }
}
$("btnTest").onclick = doTest;

async function doPoll() {
  const btn = $("btnPoll");
  saveApiKey($("apiKey").value.trim());
  btn.disabled = true;
  const svg = btn.querySelector("svg");
  svg.classList.add("spin");
  try {
    const r = await api("/api/poll", { method: "POST", body: {} });
    localStorage.setItem("qris_pg_last_poll", JSON.stringify({ ...r, ts: new Date().toISOString() }));
    debugOut("setupOut", r);
    $("setupDbg").hidden = false;
    $("bellMenu").hidden = true;
    if (r.skipped) {
      toast("Poll dilewati", r.reason || "poll lain sedang berjalan.", "info");
    } else {
      toast("Poll selesai", `matched: ${r.matched ?? 0} · expired: ${r.expired ?? 0} · pending: ${r.pending ?? 0}`, r.error ? "error" : "success");
    }
    if (currentTab === "list") loadList();
  } catch (e) {
    debugOut("setupOut", { error: e.message, ...e.data });
    $("setupDbg").hidden = false;
    toast("Poll gagal", e.message, "error");
  } finally {
    btn.disabled = false;
    svg.classList.remove("spin");
  }
}
$("btnPoll").onclick = doPoll;

/* ── Create tab ──────────────────────────────────────── */
let previewTimer = null;
function stopPreviewTimer() {
  if (previewTimer) {
    clearInterval(previewTimer);
    previewTimer = null;
  }
}
function startPreviewTimer(expiresAt) {
  stopPreviewTimer();
  const tick = () => {
    const left = new Date(expiresAt).getTime() - Date.now();
    if (left <= 0) {
      $("resExp").textContent = "Berlaku sampai " + fmtDt(expiresAt) + " · kadaluarsa";
      stopPreviewTimer();
      return;
    }
    const m = Math.max(1, Math.round(left / 60000));
    $("resExp").textContent = `Berlaku sampai ${fmtDt(expiresAt)} · sisa ±${m} mnt`;
  };
  tick();
  previewTimer = setInterval(tick, 15000);
}

$("btnCreate").onclick = async () => {
  const btn = $("btnCreate");
  saveApiKey($("apiKey").value.trim());
  stopPreviewTimer();
  $("createResult").hidden = true;
  const body = {
    amount: Number($("amount").value),
    merchant_ref: $("merchantRef").value.trim() || undefined,
    expire_min: Number($("expireMin").value) || 30,
  };
  const cb = $("callbackUrl").value.trim();
  if (cb) body.callback_url = cb;
  btn.disabled = true;
  try {
    const inv = await api("/api/invoices", { method: "POST", body });
    $("resId").textContent = inv.id;
    $("resRef").textContent = inv.merchant_ref || "—";
    $("resAmount").textContent = fmtRp(inv.amount);
    $("resUnique").textContent = inv.unique_code ? `+${inv.unique_code} kode unik` : "";
    $("resUnique").hidden = !inv.unique_code;
    $("resStatus").textContent = statusLabel(inv.status);
    $("resStatus").className = "badge " + badgeCls(inv.status);
    $("resPayload").textContent = inv.qris_payload;
    startPreviewTimer(inv.expires_at);
    if (typeof qrcode === "function") {
      const qr = qrcode(0, "M");
      qr.addData(inv.qris_payload);
      qr.make();
      $("resQr").src = qr.createDataURL(8, 4);
      $("resQr").hidden = false;
    } else {
      $("resQr").hidden = true; // CDN lib gagal dimuat — QR tidak bisa dirender lokal
    }
    $("createResult").hidden = false;
    debugOut("createOut", inv);
    $("createDbg").hidden = false;
    toast("Invoice dibuat", fmtRp(inv.amount) + " · siap dibayar via QRIS.", "success");
  } catch (e) {
    debugOut("createOut", { error: e.message, ...e.data });
    $("createDbg").hidden = false;
    toast("Gagal membuat invoice", e.message, "error");
  } finally {
    btn.disabled = false;
  }
};

$("btnCopyPayload").onclick = () => copyText($("resPayload").textContent, "Payload QRIS disalin");

/* ── List tab ────────────────────────────────────────── */
let invCache = [];
let segStatus = "";
let searchQ = "";

document.querySelectorAll("#segFilter .seg").forEach((seg) => {
  seg.addEventListener("click", () => {
    document.querySelectorAll("#segFilter .seg").forEach((s) => s.classList.toggle("active", s === seg));
    segStatus = seg.dataset.status;
    renderList();
  });
});
$("searchInput").addEventListener("input", (e) => {
  searchQ = e.target.value.trim().toLowerCase();
  if (currentTab !== "list") switchTab("list");
  renderList();
});
$("btnRefresh").onclick = loadList;

function renderList() {
  const rows = invCache.filter((inv) => {
    if (segStatus && inv.status !== segStatus) return false;
    if (!searchQ) return true;
    return [inv.id, inv.merchant_ref, String(inv.amount)].some((v) => String(v || "").toLowerCase().includes(searchQ));
  });
  const tbody = $("invBody");
  tbody.innerHTML = "";
  for (const inv of rows) {
    const cb = inv.callback_url
      ? (inv.callback_sent ? "✓" : "✗") + (inv.callback_attempts > 0 ? " " + inv.callback_attempts + "x" : "")
      : "—";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><code class="inv-id">${esc(inv.id)}</code></td>
      <td class="ref-cell" title="${esc(inv.merchant_ref || "")}">${esc(inv.merchant_ref || "—")}</td>
      <td class="num">${fmtRp(inv.amount)}</td>
      <td><span class="badge ${badgeCls(inv.status)}">${statusLabel(inv.status)}</span></td>
      <td class="time-cell" title="${esc(fmtDt(inv.created_at))}">${fmtRel(inv.created_at)}</td>
      <td class="time-cell" title="✓ terkirim · ✗ gagal · Nx = jumlah retry">${cb}</td>
      <td class="row-act">
        <button type="button" class="icon-btn" data-view="${esc(inv.id)}" aria-label="Detail invoice ${esc(inv.id)}">${icon("eye")}</button>
        <button type="button" class="icon-btn" data-resend="${esc(inv.id)}" title="Kirim ulang callback" aria-label="Kirim ulang callback ${esc(inv.id)}" ${inv.callback_url ? "" : "disabled"}>${icon("refresh")}</button>
      </td>`;
    tbody.appendChild(tr);
  }
  $("invEmpty").hidden = rows.length > 0;
  $("invEmptyText").textContent = rows.length === 0 && invCache.length > 0 ? "Tidak ada invoice yang cocok dengan filter / pencarian." : "Belum ada invoice.";
  const p = invCache.filter((i) => i.status === "pending").length;
  $("listMeta").textContent = `${invCache.length} invoice · ${p} pending`;
  $("navPending").hidden = p === 0;
  $("navPending").textContent = p;
}

async function loadList() {
  saveApiKey($("apiKey").value.trim());
  const btn = $("btnRefresh");
  btn.disabled = true;
  try {
    const { invoices } = await api("/api/invoices");
    invCache = invoices || [];
    renderList();
    const stats = {
      total: invCache.length,
      pending: invCache.filter((i) => i.status === "pending").length,
      paid: invCache.filter((i) => i.status === "paid").length,
      expired: invCache.filter((i) => i.status === "expired").length,
    };
    $("statList").innerHTML =
      statCard("list", "blue", "Total", stats.total, "semua status") +
      statCard("clock", "amber", "Pending", stats.pending, "menunggu pembayaran") +
      statCard("check", "green", "Lunas", stats.paid, "callback terkirim") +
      statCard("x", "gray", "Kadaluarsa", stats.expired, "lewat batas waktu");
    debugOut("listOut", { count: stats.total });
    $("listDbg").hidden = true;
  } catch (e) {
    debugOut("listOut", { error: e.message, ...e.data });
    $("listDbg").hidden = false;
    toast("Gagal memuat invoice", e.message, "error");
  } finally {
    btn.disabled = false;
  }
}

/* ── Modal detail invoice ────────────────────────────── */
$("invBody").addEventListener("click", (e) => {
  const viewBtn = e.target.closest("[data-view]");
  if (viewBtn) openInvoiceModal(viewBtn.dataset.view);
  const rsBtn = e.target.closest("[data-resend]");
  if (rsBtn) resendCallback(rsBtn.dataset.resend, rsBtn);
});
$("modalClose").addEventListener("click", closeModal);
$("invModal").addEventListener("click", (e) => {
  if (e.target === $("invModal")) closeModal();
});
async function resendCallback(id, btn) {
  btn.disabled = true;
  try {
    const r = await api("/api/invoices/" + encodeURIComponent(id) + "/resend", { method: "POST" });
    toast("Callback dikirim ulang", "HTTP " + (r.status ?? 200) + " — target menerima webhook.", "success");
    loadList(); // refresh attempts di tabel
  } catch (e) {
    toast("Callback gagal", e.message, "error");
  } finally {
    btn.disabled = false;
  }
}
document.querySelectorAll("[data-copy]").forEach((b) => {
  b.addEventListener("click", () => copyText($(b.dataset.copy).textContent, "Payload disalin"));
});

function closeModal() {
  $("invModal").hidden = true;
  document.body.style.overflow = "";
}
function openInvoiceModal(id) {
  const inv = invCache.find((i) => i.id === id);
  if (!inv) return;
  $("modalTitle").textContent = "Invoice " + id;
  $("modalSub").textContent = statusLabel(inv.status) + " · " + fmtRel(inv.created_at);
  $("modalKv").innerHTML = `
    <div><span>Amount</span><strong>${fmtRp(inv.amount)}</strong></div>
    <div><span>Kode unik</span><strong>${esc(inv.unique_code ?? "—")}</strong></div>
    <div><span>Merchant ref</span><code>${esc(inv.merchant_ref || "—")}</code></div>
    <div><span>Status</span><span class="badge ${badgeCls(inv.status)}">${statusLabel(inv.status)}</span></div>
    <div><span>Dibuat</span><code>${esc(fmtDt(inv.created_at))}</code></div>
    <div><span>Expires</span><code>${esc(fmtDt(inv.expires_at))}</code></div>
    <div><span>Dibayar</span><code>${esc(fmtDt(inv.paid_at))}</code></div>
    <div><span>TX ID</span><code title="${esc(inv.tx_id || "")}">${esc(inv.tx_id || "—")}</code></div>`;
  $("modalPayload").textContent = inv.qris_payload || "—";
  $("modalJson").textContent = JSON.stringify(inv, null, 2);
  // ponytail: reuse qrcode pattern from create tab
  const qrWrap = $("modalQrWrap");
  if (inv.qris_payload && typeof qrcode === "function") {
    const qr = qrcode(0, "M");
    qr.addData(inv.qris_payload);
    qr.make();
    $("modalQr").src = qr.createDataURL(8, 4);
    qrWrap.hidden = false;
  } else {
    qrWrap.hidden = true;
  }
  $("invModal").hidden = false;
  document.body.style.overflow = "hidden";
}

/* ── Auth (Clerk) ────────────────────────────────────── */
let qrisBooted = false;
const authTimeoutMs = 7000;

function qrisShowApp() {
  const gate = $("clerkLogin");
  const shell = $("appShell");
  if (gate) gate.hidden = true;
  if (shell) shell.hidden = false;
  const u = window.Clerk && window.Clerk.user;
  if (u) {
    const name = u.primaryEmailAddress?.emailAddress || u.username || u.firstName || u.lastName || "admin";
    const nm = $("userName");
    if (nm) nm.textContent = name;
    const role = $("userRole");
    if (role) role.textContent = "Clerk";
  }
  if (qrisBoot) return;
  qrisBoot = true;
  checkHealth();
  setInterval(checkHealth, 60000);
  tickClock();
  setInterval(tickClock, 30000);
  switchTab("setup");
}

function qrisShowLogin() {
  const gate = $("clerkLogin");
  const shell = $("appShell");
  if (gate) gate.hidden = false;
  if (shell) shell.hidden = true;
  if (window.qrisSignInMounted) return;
  if (window.Clerk && typeof window.Clerk.mountSignIn === "function") {
    try {
      window.Clerk.mountSignIn("#clerkMount");
      window.qrisSignInMounted = true;
    } catch (e) {
      console.error("clerk mountSignIn failed", e);
    }
  }
}

function qrisRenderGate() {
  const signed = window.Clerk && window.Clerk.isSignedIn?.();
  if (signed) qrisShowApp();
  else qrisShowLogin();
}

// Fallback: kalau Clerk CDN gagal/terblokir (offline), tetap buka app — data
// tetap aman karena /api/* masih di-guard API key.
function qrisFallbackOpen() {
  if (!qrisBoot) {
    toast("Clerk tidak tersedia", "Fallback dibuka tanpa login — API key pada /api masih aktif.", "info", 5000);
    qrisShowApp();
  }
}

async function initAuth() {
  try {
    if (window.Clerk) {
      await window.Clerk.load({ publishableKey: CLERK_PK });
      window.Clerk.addListener(qrisRenderGate);
      qrisRenderGate();
    } else {
      qrisShowLogin();
    }
  } catch (e) {
    console.error("clerk boot failed", e);
    qrisShowApp();
  }
}

initAuth();
setTimeout(qrisFallbackOpen, authTimeoutMs);
