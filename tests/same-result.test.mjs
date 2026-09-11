import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { connect, readAs, DB_URL, MEMBER_OF_12 } from "./helpers.mjs";

/**
 * A fix that returns different rows is not a fix, it is a different feature.
 * These check that the three variants are interchangeable from the caller's
 * point of view: same ids, same order, same page.
 */
const claims = { sub: MEMBER_OF_12, account_id: "12", role: "authenticated" };
let sql;

before(() => {
  sql = connect();
});
after(async () => {
  await sql?.end();
});

test("the three variants return the same page, in the same order", { skip: !DB_URL }, async () => {
  const b = await readAs(sql, "before", claims);
  const a = await readAs(sql, "after", claims);
  const n = await readAs(sql, "after-noindex", claims);

  assert.equal(b.length, 50, "before returns a full page");
  assert.deepEqual(
    a.map((r) => r.id),
    b.map((r) => r.id),
    "after returns the same ids in the same order as before",
  );
  assert.deepEqual(
    n.map((r) => r.id),
    b.map((r) => r.id),
    "the index has no effect on which rows are returned",
  );
});

test("pagination agrees across variants", { skip: !DB_URL }, async () => {
  const first = await readAs(sql, "before", claims, { limit: 10 });
  const same = await readAs(sql, "after", claims, { limit: 10 });
  assert.deepEqual(first.map((r) => r.id), same.map((r) => r.id));
  const page = await readAs(sql, "after", claims, { limit: 50 });
  assert.deepEqual(page.slice(0, 10).map((r) => r.id), first.map((r) => r.id));
});

test("the ordering is total, so the page is stable", { skip: !DB_URL }, async () => {
  const rows = await readAs(sql, "after", claims);
  const keys = rows.map((r) => `${new Date(r.event_at).toISOString()}#${r.id}`);
  assert.deepEqual([...keys].sort().reverse(), keys, "rows come back strictly descending");
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, "no row appears twice");
});
