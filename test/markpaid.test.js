import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { markPaid } from "../src/db.js";

// Real SQLite — regression for the markPaid race guard (rollback on UPDATE changes=0).
const SCHEMA = `
CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  merchant_ref TEXT,
  amount INTEGER NOT NULL,
  base_amount INTEGER NOT NULL,
  unique_code INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  qris_payload TEXT,
  callback_url TEXT,
  expires_at TEXT NOT NULL,
  paid_at TEXT,
  tx_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  callback_sent INTEGER NOT NULL DEFAULT 0,
  callback_attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE claimed (
  tx_id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  claimed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        _sql: sql,
        bind(...args) {
          this.args = args;
          return this;
        },
        run() {
          const r = stmt.run(...(this.args || []));
          return { meta: { changes: r.changes } };
        },
        first() {
          return stmt.get(...(this.args || []));
        },
        all() {
          return { results: stmt.all(...(this.args || [])) };
        },
        // raw access for assertions
        raw() {
          return stmt;
        },
      };
    },
    // D1-style atomic batch: runs in an implicit transaction; a failing
    // statement rolls the whole batch back (same semantics as D1 batch()).
    async batch(stmts) {
      db.exec("BEGIN");
      try {
        const out = [];
        for (const s of stmts) {
          const stmt = db.prepare(s._sql);
          const r = stmt.run(...(s.args || []));
          out.push({ meta: { changes: r.changes }, results: [] });
        }
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    close: () => db.close(),
  };
}

function seedPending(db, id = "inv1", amount = 5000) {
  db.prepare(
    "INSERT INTO invoices (id, merchant_ref, amount, base_amount, unique_code, status, callback_url, expires_at) VALUES (?, NULL, ?, ?, 0, 'pending', NULL, '2099-01-01T00:00:00Z')"
  )
    .bind(id, amount, amount)
    .run();
}

// wrapper that fakes a concurrent expireOld: invoice UPDATE touches 0 rows
// (retired — the atomic CTE makes the status check part of the same statement;
//  the race is now tested by actually expiring the invoice before markPaid)

describe("markPaid", () => {
  it("marks pending invoice paid and records the claim", async () => {
    const db = makeDb();
    seedPending(db);
    const inv = await markPaid(db, "inv1", "TX-1");
    assert.ok(inv, "returns invoice");
    assert.equal(inv.status, "paid");
    assert.equal(inv.tx_id, "TX-1");
    const claimed = db.prepare("SELECT COUNT(*) AS n FROM claimed").raw().get();
    assert.equal(claimed.n, 1);
    db.close();
  });

  it("returns null for already-paid invoice (no double claim)", async () => {
    const db = makeDb();
    seedPending(db);
    await markPaid(db, "inv1", "TX-1");
    const again = await markPaid(db, "inv1", "TX-1");
    assert.equal(again, null);
    const claimed = db.prepare("SELECT COUNT(*) AS n FROM claimed").raw().get();
    assert.equal(claimed.n, 1);
    db.close();
  });

  it("returns null when invoice expired concurrently — no orphan claim row (atomic)", async () => {
    const db = makeDb();
    seedPending(db);
    // simulate expireOld winning the race: invoice already expired before markPaid
    db.prepare("UPDATE invoices SET status = 'expired' WHERE id = 'inv1'").run();
    const inv = await markPaid(db, "inv1", "TX-2");
    assert.equal(inv, null, "must not return a truthy invoice");
    // atomicity: the claim insert is conditional on status='pending', so
    // nothing was persisted — tx_id stays reusable, no orphan row.
    const claimed = db.prepare("SELECT COUNT(*) AS n FROM claimed").raw().get();
    assert.equal(claimed.n, 0, "claimed row must not exist for expired invoice");
    const invRow = db.prepare("SELECT status FROM invoices WHERE id = 'inv1'").raw().get();
    assert.equal(invRow.status, "expired");
    db.close();
  });

  it("leaves tx_id reusable after an expired-invoice attempt (atomic)", async () => {
    const db = makeDb();
    seedPending(db, "invA");
    seedPending(db, "invB", 9000);
    // invA expired first → markPaid on invA returns null and claims nothing
    db.prepare("UPDATE invoices SET status = 'expired' WHERE id = 'invA'").run();
    const a = await markPaid(db, "invA", "TX-RE");
    assert.equal(a, null);
    // same tx_id can still pay invB — nothing was burned by the failed attempt
    const b = await markPaid(db, "invB", "TX-RE");
    assert.ok(b, "tx_id must remain reusable after the expired attempt");
    assert.equal(b.status, "paid");
    const claimed = db.prepare("SELECT COUNT(*) AS n FROM claimed").raw().get();
    assert.equal(claimed.n, 1);
    db.close();
  });

  it("returns null when tx_id is already claimed by another invoice", async () => {
    const db = makeDb();
    seedPending(db, "invA");
    seedPending(db, "invB", 9000);
    await markPaid(db, "invA", "TX-3");
    const other = await markPaid(db, "invB", "TX-3"); // same tx, different invoice
    assert.equal(other, null);
    db.close();
  });
});
