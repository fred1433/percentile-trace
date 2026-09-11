#!/usr/bin/env node
/**
 * The guard.
 *
 * Reads the budget committed next to the code and the HTTP bench that just
 * ran, and fails when a guarded p95 is over budget.
 *
 * Three outcomes, not two. A run with too few samples to resolve the
 * percentile it is asked about exits "inconclusive" rather than green: a test
 * that cannot fail is not a passing test.
 *
 * What it detects: regressions covered by this scenario and this budget. It
 * says nothing about behaviour under concurrency, other accounts, other
 * regions or other query shapes.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvedAt } from "./stats.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const budgetPath = join(here, "..", "perf-budget.json");
const runPath = join(here, "out", "http.json");

const INCONCLUSIVE = 2;

if (!existsSync(runPath)) {
  console.error("No bench/out/http.json. Run bench/http.mjs first.");
  process.exit(INCONCLUSIVE);
}

const budget = JSON.parse(readFileSync(budgetPath, "utf8"));
const run = JSON.parse(readFileSync(runPath, "utf8"));

console.log(run.target);
console.log(
  `${run.startedAt} | commit ${String(run.commit).slice(0, 7)} | deployment ${run.deploymentId} | function ${run.functionRegion} | database ${run.databaseRegion} | from ${run.from}`,
);
console.log(`${run.attempted} requests attempted, ${run.failed} failed\n`);

const minSamples = budget.minimumSamples ?? resolvedAt(95);
let over = 0;
let inconclusive = 0;

if (run.failed > (budget.maximumFailures ?? 0)) {
  console.log(`INCONCLUSIVE  ${run.failed} request(s) failed, budget allows ${budget.maximumFailures ?? 0}`);
  inconclusive++;
}

for (const b of budget.budgets) {
  const seg = run.conditions?.[b.condition]?.afterWarmUp?.[b.segment];
  if (!seg) {
    console.log(`INCONCLUSIVE  ${b.condition} ${b.segment} was not measured in this run`);
    inconclusive++;
    continue;
  }
  if (seg.n < minSamples) {
    console.log(
      `INCONCLUSIVE  ${b.condition} ${b.segment} has ${seg.n} samples, ${minSamples} needed to resolve a p95`,
    );
    inconclusive++;
    continue;
  }
  const ok = seg.p95 <= b.p95Ms;
  if (!ok) over++;
  console.log(
    `${ok ? "ok          " : "OVER        "}${b.condition} ${b.segment} p95 ${seg.p95.toFixed(2)} ms over ${seg.n} samples, budget ${b.p95Ms} ms`,
  );
  if (!ok) console.log(`              ${b.why}`);
}

if (inconclusive) {
  console.error(`\n${inconclusive} check(s) inconclusive. Not green.`);
  process.exit(INCONCLUSIVE);
}
if (over) {
  console.error(`\n${over} budget(s) over. Failing.`);
  process.exit(1);
}
console.log(
  "\nEvery guarded segment is inside its budget. This detects regressions covered by this scenario and this budget, and nothing else.",
);
