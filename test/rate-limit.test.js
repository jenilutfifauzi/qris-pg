import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { rateLimit } from "../src/db.js";

// real SQLite — catches regressions in the ON CONFLICT CASE (mock can't)
// node:sqlite has no .bind(); wrap into the D1-style API db.js expects.
function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE rate_limits (key TEXT PRIMARY KEY, minute INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 1)"
  );
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        bind(...args) {
          this.args = args;
          return this;
        },
        run() {
          return { meta: stmt.run(...this.args) };
        },
        first() {
          return stmt.get(...this.args);
        },
      };
    },
    close: () => db.close(),
  };
}

describe("rateLimit (real SQLite)", () => {
  it("allows up to limit, blocks after", async () => {
    const db = makeDb();
    const results = [];
    for (let i = 0; i < 12; i++) results.push(await rateLimit(db, "k", 10));
    assert.deepEqual(results, [...Array(10).fill(true), false, false]);
    db.close();
  });

  it("resets count when minute window changes", async () => {
    const db = makeDb();
    const minute = Math.floor(Date.now() / 60000);
    // simulate: 10 hits in minute N → blocked
    for (let i = 0; i < 10; i++) await rateLimit(db, "k", 10);
    assert.equal(await rateLimit(db, "k", 10), false);
    // force next-minute row by rewriting minute (real rollover happens via clock)
    db.prepare("UPDATE rate_limits SET minute = ? WHERE key = 'k'").bind(minute - 1).run();
    assert.equal(await rateLimit(db, "k", 10), true, "count must reset on new window");
    db.close();
  });
});
