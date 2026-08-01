import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { crc16, staticToDynamic, validateQris } from "../src/qris.js";
import { normalizeTx } from "../src/gobiz.js";
import { findPendingByRef, rateLimit } from "../src/db.js";
import { retryUnsentCallbacks, sendCallback } from "../src/poll.js";

// vector from qris-static-to-dynamic (CRC static 568D + amount 5500 → C9BE)
const STATIC =
  "00020101021126610014COM.GO-JEK.WWW01189360091432191540810210G2191540810303UMI51440014ID.CO.QRIS.WWW0215ID10253911118910303UMI5204581553033605802ID5924JUAN Pria Sigma, Digital6006BLITAR61056615462070703A016304568D";

describe("qris", () => {
  it("validates static CRC", () => {
    const v = validateQris(STATIC);
    assert.equal(v.valid, true);
    assert.equal(v.given, "568D");
  });

  it("static→dynamic amount 5500 → CRC C9BE", () => {
    const dyn = staticToDynamic(STATIC, 5500);
    assert.ok(dyn.includes("54045500"));
    assert.ok(dyn.includes("010212"));
    const v = validateQris(dyn);
    assert.equal(v.valid, true);
    assert.equal(v.given, "C9BE");
  });

  it("crc16 self-check on empty body prefix", () => {
    assert.equal(typeof crc16("6304"), "string");
    assert.equal(crc16("6304").length, 4);
  });
});

describe("gobiz normalize", () => {
  it("divides gross_amount by 100", () => {
    const t = normalizeTx({
      id: "tx1",
      gross_amount: 500000,
      transaction_status: "SETTLEMENT",
      transaction_time: "2026-01-01T00:00:00Z",
    });
    assert.equal(t.amount, 5000);
    assert.equal(t.amount_raw, 500000);
    assert.equal(t.transaction_id, "tx1");
  });
});

describe("rateLimit", () => {
  it("allows up to limit, blocks after", async () => {
    const store = new Map();
    const db = {
      prepare() {
        return {
          bind(...args) {
            this.args = args;
            return this;
          },
          async run() {
            const k = this.args[0];
            store.set(k, (store.get(k) || 0) + 1);
            return {};
          },
          async first() {
            const k = this.args[0];
            return store.has(k) ? { count: store.get(k) } : null;
          },
        };
      },
    };
    const key = `inv:test`;
    const results = [];
    for (let i = 0; i < 12; i++) results.push(await rateLimit(db, key, 10));
    assert.deepEqual(results, [...Array(10).fill(true), false, false]);
  });
});

describe("callback", () => {
  it("sendCallback posts and signs body with HMAC-SHA256", async () => {
    let seen = {};
    const srv = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        seen = { sig: req.headers["x-qris-signature"], body: raw };
        res.end("ok");
      });
    });
    await new Promise((r) => srv.listen(0, r));
    const port = srv.address().port;
    const r = await sendCallback({ callback_url: `http://127.0.0.1:${port}/h`, id: "abc" }, "testkey");
    srv.close();
    const expect = createHmac("sha256", "testkey").update(seen.body).digest("hex");
    assert.equal(r.ok, true);
    assert.equal(seen.sig, `sha256=${expect}`);
  });

  it("retryUnsentCallbacks increments attempts on failure", async () => {
    const store = new Map();
    const sql = [];
    const db = {
      prepare(q) {
        return {
          bind(...args) {
            this.args = args;
            return this;
          },
          async all() {
            if (q.includes("callback_sent")) {
              const rows = [...store.values()].filter(
                (r) => r.status === "paid" && !r.callback_sent && r.callback_attempts < 5
              );
              return { results: rows };
            }
            return { results: [] };
          },
          async run() {
            sql.push(q);
            return {};
          },
        };
      },
    };
    store.set("a", {
      id: "a",
      callback_url: "http://127.0.0.1:1/x",
      status: "paid",
      callback_sent: 0,
      callback_attempts: 0,
    });
    const res = await retryUnsentCallbacks(db, "testkey");
    assert.equal(res.attempted, 1);
    assert.equal(res.sent, 0);
    assert.ok(sql.some((q) => q.includes("callback_attempts = callback_attempts + 1")));
  });
});

describe("idempotency", () => {
  it("findPendingByRef returns pending invoice or null", async () => {
    const rows = [{ id: "a", merchant_ref: "R1", status: "pending" }];
    const db = {
      prepare() {
        return {
          bind(...args) {
            this.args = args;
            return this;
          },
          async first() {
            return this.args[0] === "R1" ? rows[0] : null;
          },
        };
      },
    };
    assert.equal((await findPendingByRef(db, "R1")).id, "a");
    assert.equal(await findPendingByRef(db, "R2"), null);
    assert.equal(await findPendingByRef(db, ""), null);
  });
});
