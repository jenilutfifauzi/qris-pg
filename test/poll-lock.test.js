import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { claimPollLock } from "../src/db.js";

// real SQLite — verifies the atomic upsert-where lock semantics of claimPollLock
function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
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
        raw() {
          return stmt;
        },
      };
    },
    close: () => db.close(),
  };
}

describe("claimPollLock (real SQLite)", () => {
  it("first claim succeeds, second immediate claim is rejected", async () => {
    const db = makeDb();
    assert.equal(await claimPollLock(db), true, "first poll must acquire the lock");
    assert.equal(await claimPollLock(db), false, "concurrent poll must be rejected");
    db.close();
  });

  it("lock expires after ttlMs — claim succeeds again", async () => {
    const db = makeDb();
    assert.equal(await claimPollLock(db), true);
    // age the lock past the 45s TTL (real expiry happens via clock)
    db.prepare("UPDATE settings SET value = ? WHERE key = 'poll_lock'")
      .bind(String(Date.now() - 60_000))
      .run();
    assert.equal(await claimPollLock(db), true, "expired lock must be re-claimable");
    db.close();
  });
});
