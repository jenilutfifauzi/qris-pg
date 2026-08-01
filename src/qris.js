/** QRIS static → dynamic (EMVCo TLV + CRC16-CCITT). Zero deps. */

export function crc16(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return (crc & 0xffff).toString(16).toUpperCase().padStart(4, "0");
}

export function parseTlv(data) {
  const out = [];
  let i = 0;
  const s = String(data || "");
  while (i + 4 <= s.length) {
    const tag = s.slice(i, i + 2);
    const len = Number.parseInt(s.slice(i + 2, i + 4), 10);
    if (!Number.isFinite(len) || len < 0) break;
    const value = s.slice(i + 4, i + 4 + len);
    if (value.length !== len) break;
    out.push({ tag, length: len, value });
    i += 4 + len;
    if (tag === "63") break;
  }
  return out;
}

export function buildTlv(elements) {
  return elements
    .map((el) => `${el.tag}${String(el.value.length).padStart(2, "0")}${el.value}`)
    .join("");
}

export function validateQris(qris) {
  const s = String(qris || "").trim();
  if (s.length < 20) return { valid: false, error: "too short" };
  if (!s.startsWith("000201")) return { valid: false, error: "must start with 000201" };
  const idx = s.lastIndexOf("6304");
  if (idx === -1) return { valid: false, error: "no CRC tag" };
  const given = s.slice(idx + 4, idx + 8).toUpperCase();
  if (given.length !== 4) return { valid: false, error: "bad CRC length" };
  const expected = crc16(s.slice(0, idx + 4));
  return { valid: given === expected, expected, given };
}

/** @param {string} qrisStatic @param {number|string} amount */
export function staticToDynamic(qrisStatic, amount) {
  const raw = String(qrisStatic || "").trim();
  if (!raw.startsWith("000201")) throw Object.assign(new Error("QRIS must start with 000201"), { code: "INVALID_PAYLOAD" });

  const nominal = Math.floor(Number(amount));
  if (!Number.isFinite(nominal) || nominal <= 0) {
    throw Object.assign(new Error("amount must be positive integer IDR"), { code: "INVALID_AMOUNT" });
  }
  const amountStr = String(nominal);
  const elements = parseTlv(raw);
  if (!elements.length) throw Object.assign(new Error("failed to parse TLV"), { code: "PARSE_FAILED" });

  const drop = new Set(["54", "55", "56", "57", "63"]);
  const result = [];
  let inserted = false;

  for (const el of elements) {
    if (drop.has(el.tag)) continue;
    if (el.tag === "01") {
      result.push({ tag: "01", value: "12" });
      continue;
    }
    if (el.tag === "58" && !inserted) {
      result.push({ tag: "54", value: amountStr });
      inserted = true;
    }
    result.push({ tag: el.tag, value: el.value });
  }
  if (!inserted) result.push({ tag: "54", value: amountStr });

  const body = buildTlv(result) + "6304";
  return body + crc16(body);
}
