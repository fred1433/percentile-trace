import { test } from "node:test";
import assert from "node:assert/strict";
import { percentile, summarise, resolvedAt } from "../bench/stats.mjs";

/** The percentile is nearest rank on the sorted sample, and nothing is interpolated. */
test("nearest rank picks a value that is in the sample", () => {
  const v = [5, 1, 4, 2, 3];
  assert.equal(percentile(v, 50), 3);
  assert.equal(percentile(v, 95), 5);
  assert.equal(percentile(v, 100), 5);
  for (const p of [50, 90, 95, 99]) assert.ok(v.includes(percentile(v, p)));
});

test("a hundred samples put p95 at the 95th value", () => {
  const v = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(v, 95), 95);
  assert.equal(percentile(v, 99), 99);
});

test("a small sample says its p99 is only the maximum", () => {
  assert.equal(summarise([1, 2, 3]).p99IsMax, true);
  assert.equal(summarise(Array.from({ length: 200 }, (_, i) => i)).p99IsMax, false);
  assert.equal(resolvedAt(99), 101);
  assert.equal(resolvedAt(95), 21);
});

test("an empty sample reports nothing rather than zero", () => {
  const s = summarise([]);
  assert.equal(s.n, 0);
  assert.equal(s.p95, null);
  assert.equal(s.p99, null);
  assert.equal(s.p99IsMax, false);
});

test("no summary field is an average", () => {
  const keys = Object.keys(summarise([1, 2, 3]));
  for (const forbidden of ["mean", "avg", "average", "p50", "median"]) {
    assert.ok(!keys.includes(forbidden), `${forbidden} must not be reported`);
  }
});
