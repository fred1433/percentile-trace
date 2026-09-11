#!/usr/bin/env node
/**
 * Proposes a budget from a run instead of picking a round number.
 *
 * The margin comes from the spread that was actually observed:
 *
 *   budget = max( p99 * 1.5 , p99 + 2 * (p99 - p95) )
 *
 * A segment that is steady gets a tight budget, a segment that already varies
 * gets room in proportion to how much it varies. Both terms are needed: the
 * first stops a perfectly flat segment from getting a budget equal to its own
 * p99, the second stops a jittery one from failing on ordinary noise.
 *
 * Only segments the server measures about itself are proposed. An end to end
 * number depends on where the bench runs, so a budget on it would fail for
 * reasons that have nothing to do with the deployment.
 *
 *   node bench/propose-budget.mjs --condition after
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const run = JSON.parse(readFileSync(join(here, "out", "http.json"), "utf8"));
const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) =>
    a.startsWith("--")
      ? [[a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"]]
      : [],
  ),
);
const condition = args.condition ?? "after";
const c = run.conditions[condition];
if (!c) {
  console.error(`No condition "${condition}" in bench/out/http.json`);
  process.exit(1);
}

console.log(`from ${run.attempted} requests on ${run.target}, condition "${condition}"\n`);
const proposed = [];
for (const segment of ["queryMs", "connectMs", "handlerMs"]) {
  const s = c.afterWarmUp[segment];
  if (!s || s.p95 === null) continue;
  const spread = s.p99 - s.p95;
  const budget = Math.ceil(Math.max(s.p99 * 1.5, s.p99 + 2 * spread));
  proposed.push({ condition, segment, p95Ms: budget });
  console.log(
    `${segment.padEnd(11)} n ${String(s.n).padStart(4)}  p95 ${s.p95.toFixed(2)}  p99 ${s.p99.toFixed(2)}  spread ${spread.toFixed(2)}  ->  budget ${budget} ms`,
  );
}
console.log("\n" + JSON.stringify(proposed, null, 2));
