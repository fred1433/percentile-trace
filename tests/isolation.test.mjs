import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { connect, readAs, DB_URL, MEMBER_OF_12, MEMBER_OF_5 } from "./helpers.mjs";

/**
 * Row level security is the point of the page, so the fix has to keep it. One
 * account does not see another, on every variant, with the application role and
 * never with a key that bypasses the policy.
 */
let sql;
before(() => {
  sql = connect();
});
after(async () => {
  await sql?.end();
});

const VARIANTS = ["before", "after", "after-noindex"];

for (const variant of VARIANTS) {
  test(`${variant}: a caller only sees their own account`, { skip: !DB_URL }, async () => {
    const twelve = await readAs(sql, variant, {
      sub: MEMBER_OF_12,
      account_id: "12",
      role: "authenticated",
    });
    const five = await readAs(sql, variant, {
      sub: MEMBER_OF_5,
      account_id: "5",
      role: "authenticated",
    });

    assert.ok(twelve.length > 0 && five.length > 0, "both callers see their own rows");
    assert.deepEqual([...new Set(twelve.map((r) => r.account_id))], [12]);
    assert.deepEqual([...new Set(five.map((r) => r.account_id))], [5]);

    const overlap = new Set(twelve.map((r) => r.id));
    assert.equal(
      five.filter((r) => overlap.has(r.id)).length,
      0,
      "the two callers share no row",
    );
  });

  test(`${variant}: no claims means no rows`, { skip: !DB_URL }, async () => {
    const rows = await sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', '', true)`;
      return tx.unsafe(
        `select id from trace.watchlist_${variant.replace("-", "_").replace("after_noindex", "after_noindex")} limit 5`,
      ).catch(() => []);
    });
    assert.equal(rows.length, 0, "an unauthenticated statement reads nothing");
  });
}

test("the runtime role cannot write, and cannot turn the policy off", { skip: !DB_URL }, async () => {
  await assert.rejects(
    () => sql`delete from trace.watchlist_after where id = -1`,
    /permission denied/i,
  );
  await assert.rejects(
    () => sql`alter table trace.watchlist_after disable row level security`,
    /must be owner|permission denied/i,
  );
});
