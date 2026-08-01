import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { crc16, staticToDynamic, validateQris } from "../src/qris.js";
import { normalizeTx } from "../src/gobiz.js";

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
