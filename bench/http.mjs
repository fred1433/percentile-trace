#!/usr/bin/env node
/**
 * The HTTP population.
 *
 * Load model: closed loop, one request in flight at a time, no pacing between
 * requests, sequential per condition. Failures and unsent requests are counted
 * and reported; they are never silently dropped from the sample.
 *
 * Condition order alternates between windows, so a drift in the platform or in
 * the database over the life of the run cannot land entirely on one condition.
 * Every window is kept, not only the best one.
 *
 * This is not the headline metric. The headline metric is what a visitor
 * experiences, and that one is measured by a browser in bench/browser.mjs.
 * These two are different populations and are never mixed.
 *
 *   node bench/http.mjs --target https://percentile-trace.theaipipe.com \
 *        --windows 4 --per-window 250 --from "Asuncion, Paraguay"
 */
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { summarise, roundAll } from "./stats.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "out");

const args = parseArgs(process.argv.slice(2));
const target = (args.target ?? "http://localhost:3000").replace(/\/$/, "");
const windows = Number(args.windows ?? 4);
const perWindow = Number(args["per-window"] ?? 250);
const from = args.from ?? "unspecified";
const conditions = (args.conditions ?? "before,after,after-noindex").split(",");
const label = args.label ?? "";
const timeoutMs = Number(args.timeout ?? 20000);
const outName = args["out-name"] ?? "http.json";

const rawPath = join(OUT, `http-raw-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);

async function one(variant, windowIndex, wantSpans) {
  const url = `${target}/api/trace?variant=${variant}${wantSpans ? "&spans=1" : ""}&t=${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  let res, body, clientMs;
  try {
    // Node's fetch has no default timeout, so one connection that never answers
    // would stop the whole run. A request that passes this bound is a counted
    // failure, not a sample that quietly disappears.
    res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    body = await res.json();
    clientMs = performance.now() - t0;
  } catch (e) {
    return {
      ok: false,
      variant,
      windowIndex,
      startedAt,
      clientMs: performance.now() - t0,
      error: String(e),
    };
  }
  if (!res.ok) {
    return { ok: false, variant, windowIndex, startedAt, clientMs, status: res.status };
  }
  const s = body.server;
  return {
    ok: true,
    variant,
    windowIndex,
    startedAt,
    clientMs,
    handlerMs: s.handlerMs,
    connectMs: s.connectMs,
    claimsMs: s.claimsMs,
    queryMs: s.queryMs,
    traceId: s.traceId,
    vercelId: s.vercelId,
    vercelIdHeader: res.headers.get("x-vercel-id"),
    vercelCache: res.headers.get("x-vercel-cache"),
    region: s.functionRegion,
    dbRegion: s.databaseRegion,
    instance: s.instanceId,
    firstOnInstance: s.firstOnInstance,
    commit: s.commit,
    deploymentId: s.deploymentId,
    nodeVersion: s.nodeVersion,
    rows: body.rowsReturned,
    firstId: body.firstId,
    lastId: body.lastId,
    accountIds: body.accountIds,
    statement: body.statement,
    spans: body.spans,
  };
}

function statsFor(rows, key) {
  return roundAll(summarise(rows.map((r) => r[key]).filter((v) => typeof v === "number")));
}

/** The observation whose client duration is closest to the p95 of its condition. */
function representative(rows, p95) {
  let best = null;
  for (const r of rows) {
    const d = Math.abs(r.clientMs - p95);
    if (!best || d < best.d) best = { d, r };
  }
  return best?.r ?? null;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const startedAt = new Date().toISOString();
  const all = [];
  const failures = [];

  console.log(`target      ${target}`);
  console.log(`conditions  ${conditions.join(", ")}`);
  console.log(`windows     ${windows} x ${perWindow} per condition, closed loop, no pacing`);
  console.log(`from        ${from}\n`);

  for (let w = 0; w < windows; w++) {
    // Alternating order, so a drift over the life of the run does not land on
    // one condition.
    const order = w % 2 === 0 ? conditions : [...conditions].reverse();
    for (const variant of order) {
      process.stdout.write(`window ${w + 1} ${variant.padEnd(14)}`);
      for (let i = 0; i < perWindow; i++) {
        // One observation per window carries its span tree, so a full linked
        // trace exists without putting the payload on every request.
        const r = await one(variant, w, i === 0);
        if (r.ok) all.push(r);
        else failures.push(r);
        appendFileSync(rawPath, JSON.stringify(r) + "\n");
        if (i % 25 === 24) process.stdout.write(".");
      }
      process.stdout.write("\n");
    }
  }

  const first = all[0] ?? {};
  const byCondition = {};
  for (const variant of conditions) {
    const rows = all.filter((r) => r.variant === variant);
    const warm = rows.filter((r) => !r.firstOnInstance);
    const firstOnInstance = rows.filter((r) => r.firstOnInstance);
    const client = statsFor(warm, "clientMs");
    byCondition[variant] = {
      attempted: rows.length + failures.filter((f) => f.variant === variant).length,
      failed: failures.filter((f) => f.variant === variant).length,
      afterWarmUp: {
        clientMs: client,
        handlerMs: statsFor(warm, "handlerMs"),
        queryMs: statsFor(warm, "queryMs"),
        connectMs: statsFor(warm, "connectMs"),
        claimsMs: statsFor(warm, "claimsMs"),
      },
      firstRequestOnAnInstance: {
        n: firstOnInstance.length,
        observations: firstOnInstance.map((r) => ({
          clientMs: Math.round(r.clientMs),
          handlerMs: r.handlerMs,
          connectMs: r.connectMs,
          queryMs: r.queryMs,
          instance: r.instance,
        })),
      },
      sameResult: {
        rows: [...new Set(rows.map((r) => r.rows))],
        firstId: [...new Set(rows.map((r) => r.firstId))],
        lastId: [...new Set(rows.map((r) => r.lastId))],
        accountIds: [...new Set(rows.flatMap((r) => r.accountIds ?? []))],
      },
      representative: trimSpans(representative(warm, client.p95 ?? 0)),
      distribution: histogram(warm.map((r) => r.clientMs)),
    };
  }

  const run = {
    population: "HTTP requests to /api/trace, one variant per request",
    metric:
      "clientMs is the wall time of the fetch as the bench machine saw it; handlerMs, connectMs, claimsMs and queryMs are what the function measured about itself. Neither is derived from the other and no segment is obtained by subtraction.",
    loadModel:
      `Closed loop, one request in flight, no pacing, sequential per condition, condition order alternating between windows. Failed and unsent requests are counted. A request is abandoned after ${timeoutMs} ms and counted as a failure.`,
    startedAt,
    finishedAt: new Date().toISOString(),
    target,
    from,
    label,
    windows,
    perWindow,
    functionRegion: first.region ?? "?",
    databaseRegion: first.dbRegion ?? "?",
    commit: first.commit ?? "?",
    deploymentId: first.deploymentId ?? "?",
    nodeVersion: first.nodeVersion ?? "?",
    instancesSeen: [...new Set(all.map((r) => r.instance))].length,
    attempted: all.length + failures.length,
    failed: failures.length,
    rawValues: rawPath.replace(join(here, ".."), "."),
    conditions: byCondition,
  };

  writeFileSync(join(OUT, outName), JSON.stringify(run, null, 2));
  const mdName = outName.replace(/\.json$/, ".md");
  console.log(text(run));
  writeFileSync(join(OUT, mdName), text(run));
  console.log(`\nwritten: bench/out/${outName}, bench/out/${mdName}, ${run.rawValues}`);
}

function trimSpans(r) {
  if (!r) return null;
  const { spans, ...rest } = r;
  return { ...rest, spans: spans ?? null };
}

/** Ten buckets over the observed range, so the shape is visible, not just two numbers. */
function histogram(values, buckets = 10) {
  if (values.length === 0) return [];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const width = (hi - lo) / buckets || 1;
  const counts = Array(buckets).fill(0);
  for (const v of values) {
    counts[Math.min(buckets - 1, Math.floor((v - lo) / width))]++;
  }
  return counts.map((count, i) => ({
    fromMs: Math.round(lo + i * width),
    toMs: Math.round(lo + (i + 1) * width),
    count,
  }));
}

function text(run) {
  const L = [];
  L.push(`\n${run.target}  commit ${String(run.commit).slice(0, 7)}  deployment ${run.deploymentId}`);
  L.push(
    `${run.startedAt} to ${run.finishedAt} | function ${run.functionRegion} | database ${run.databaseRegion} | ${run.instancesSeen} instance(s) | from ${run.from}`,
  );
  L.push(`${run.attempted} requests attempted, ${run.failed} failed`);
  L.push("");
  L.push("condition        segment        n      p95        p99        max");
  for (const [name, c] of Object.entries(run.conditions)) {
    for (const [seg, s] of Object.entries(c.afterWarmUp)) {
      L.push(
        [
          name.padEnd(16),
          seg.replace("Ms", "").padEnd(14),
          String(s.n).padEnd(6),
          ms(s.p95),
          ms(s.p99),
          ms(s.max),
        ].join(" "),
      );
    }
    const small = c.afterWarmUp.clientMs.p99IsMax;
    if (small) L.push(`  note: exploratory empirical p99, N = ${c.afterWarmUp.clientMs.n}`);
    L.push(
      `  same result: ${c.sameResult.rows.join("/")} rows, first id ${c.sameResult.firstId.join("/")}, accounts ${c.sameResult.accountIds.join("/")}`,
    );
    L.push(
      `  first request on an instance: ${c.firstRequestOnAnInstance.n} observation(s), not a confirmed cold start`,
    );
    L.push("");
  }
  return L.join("\n");
}

const ms = (v) => `${v === null ? "-" : v.toFixed(1)}`.padStart(10);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else out[key] = "true";
    }
  }
  return out;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
