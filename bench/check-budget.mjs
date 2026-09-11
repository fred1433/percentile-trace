#!/usr/bin/env node
/**
 * The guard. Reads the budget committed next to the code and the summary the
 * bench just wrote, and fails the build when a guarded p95 is over budget.
 *
 * A fix that is not defended by a budget is a fix with a shelf life.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const budgetPath = join(here, "..", "perf-budget.json");
const summaryPath = join(here, "out", "summary.json");

if (!existsSync(summaryPath)) {
  console.error("No bench/out/summary.json. Run bench/run.mjs first.");
  process.exit(2);
}

const { budgets } = JSON.parse(readFileSync(budgetPath, "utf8"));
const { runs } = JSON.parse(readFileSync(summaryPath, "utf8"));
const run = runs[0];

if (!run || !run.warm || run.warm.samples === 0) {
  console.error("The summary has no warm samples to check.");
  process.exit(2);
}

console.log(`${run.target}`);
console.log(
  `${run.at} | function ${run.functionRegion} | database ${run.databaseRegion} | ${run.warm.samples} warm samples per arm | measured from ${run.from}\n`,
);

let failed = 0;
for (const b of budgets) {
  const measured = run.warm.arms?.[b.arm]?.[b.segment]?.p95;
  if (measured === undefined || measured === null) {
    console.log(`?  ${b.arm} ${b.segment}: not measured in this run`);
    failed++;
    continue;
  }
  const ok = measured <= b.p95Ms;
  if (!ok) failed++;
  console.log(
    `${ok ? "ok  " : "OVER"} ${b.arm} ${b.segment} p95 ${measured.toFixed(2)} ms, budget ${b.p95Ms} ms`,
  );
  if (!ok) console.log(`     ${b.why}`);
}

if (failed) {
  console.error(`\n${failed} budget(s) over. Failing.`);
  process.exit(1);
}
console.log("\nEvery guarded segment is inside its budget.");
