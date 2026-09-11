import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { connect, readAs, DB_URL, MEMBER_OF_12 } from "./helpers.mjs";

/**
 * What the fix costs, written down as a test rather than left as a footnote.
 *
 * The slow policy checks membership in the database on every read. The fast one
 * trusts an account_id claim in the verified token. That moves the
 * authorisation decision from the database to whatever mints the token, and a
 * claim that was never checked against membership would be honoured.
 *
 * These tests assert the behaviour in both directions, so nobody adopts the
 * fast policy without also minting the claim from verified membership, for
 * example in a Supabase custom access token hook.
 */
let sql;
before(() => {
  sql = connect();
});
after(async () => {
  await sql?.end();
});

const forged = { sub: MEMBER_OF_12, account_id: "5", role: "authenticated" };

test("the membership policy refuses an account the user does not belong to", { skip: !DB_URL }, async () => {
  const rows = await readAs(sql, "before", forged);
  assert.deepEqual(
    [...new Set(rows.map((r) => r.account_id))],
    [12],
    "the database checks membership and ignores the claim",
  );
});

test("the claim policy honours the claim, so the claim has to be trustworthy", { skip: !DB_URL }, async () => {
  const rows = await readAs(sql, "after", forged);
  assert.deepEqual(
    [...new Set(rows.map((r) => r.account_id))],
    [5],
    "the database trusts account_id, which is only safe if the token issuer verified it",
  );
});
