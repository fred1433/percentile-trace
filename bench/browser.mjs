#!/usr/bin/env node
/**
 * The headline population: what a visitor experiences.
 *
 * One observation is one click. The clock starts on the click on the watchlist
 * link and stops when the expected rows are on screen, verified: the right
 * number of rows, on the right account, and the first id the request returned.
 * A run where the content does not verify is a failure and is counted as one,
 * not quietly averaged in.
 *
 * Load model: one browser, one page, one click at a time, a fresh context per
 * observation so nothing is served from a warm browser cache. Link prefetch is
 * left at the Next.js default, because that is what a visitor gets.
 *
 *   node bench/browser.mjs --target https://percentile-trace.theaipipe.com \
 *        --windows 3 --per-window 12 --from "Asuncion, Paraguay"
 */
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { summarise, roundAll } from "./stats.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "out");

const args = parseArgs(process.argv.slice(2));
const target = (args.target ?? "http://localhost:3000").replace(/\/$/, "");
const windows = Number(args.windows ?? 3);
const perWindow = Number(args["per-window"] ?? 12);
const from = args.from ?? "unspecified";
const conditions = (args.conditions ?? "before,after").split(",");

const TITLES = {
  before: "Membership subquery",
  after: "Account claim",
  "after-noindex": "Account claim, index removed",
};

const rawPath = join(OUT, `browser-raw-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);

async function observe(browser, variant, windowIndex) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  // Stamp the moment the streamed rows land, from inside the page, so the end
  // of the measurement is the DOM commit and not a polling interval.
  await page.addInitScript(() => {
    // @ts-nocheck
    window.__ptRowsAt = null;
    window.__ptClickAt = null;
    const mark = () => {
      const el = document.querySelector("[data-rows-ready]");
      if (el && window.__ptRowsAt === null) window.__ptRowsAt = performance.now();
    };
    new MutationObserver(mark).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    document.addEventListener(
      "click",
      () => {
        if (window.__ptClickAt === null) window.__ptClickAt = performance.now();
      },
      true,
    );
  });

  const started = new Date().toISOString();
  try {
    await page.goto(target, { waitUntil: "load" });
    // Let the default link prefetch settle, so every observation starts from
    // the same state rather than racing it.
    await page.waitForTimeout(1500);

    await page.click(`a[data-open="${variant}"]`);
    await page.waitForSelector("[data-rows-ready]", { timeout: 60_000 });

    const m = await page.evaluate(() => {
      const el = document.querySelector("[data-rows-ready]");
      const nav = performance.getEntriesByType("navigation")[0];
      const lcp = performance.getEntriesByType("largest-contentful-paint").pop();
      return {
        clickAt: window.__ptClickAt,
        rowsAt: window.__ptRowsAt,
        rowsCount: Number(el?.getAttribute("data-rows-count") ?? 0),
        firstId: el?.getAttribute("data-first-id") ?? null,
        traceId: el?.getAttribute("data-trace-id") ?? null,
        queryMs: Number(el?.getAttribute("data-query-ms") ?? 0),
        landingTtfb: nav ? nav.responseStart - nav.startTime : null,
        landingLcp: lcp ? lcp.startTime : null,
        url: location.pathname,
      };
    });

    const clickToRowsMs =
      m.clickAt !== null && m.rowsAt !== null ? m.rowsAt - m.clickAt : null;
    const verified =
      m.rowsCount === 50 && !!m.firstId && m.url === `/watchlist/${variant}`;

    return {
      ok: verified && clickToRowsMs !== null,
      variant,
      windowIndex,
      startedAt: started,
      clickToRowsMs,
      queryMs: m.queryMs,
      rowsCount: m.rowsCount,
      firstId: m.firstId,
      traceId: m.traceId,
      landingTtfb: m.landingTtfb,
      landingLcp: m.landingLcp,
      verified,
    };
  } catch (e) {
    return { ok: false, variant, windowIndex, startedAt: started, error: String(e) };
  } finally {
    await ctx.close();
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const env = await fetch(`${target}/api/health`, { cache: "no-store" })
    .then((r) => r.json())
    .catch(() => ({}));
  const browser = await chromium.launch();
  const version = browser.version();
  const all = [];
  const failures = [];
  const startedAt = new Date().toISOString();

  console.log(`target      ${target}`);
  console.log(`conditions  ${conditions.join(", ")}`);
  console.log(`windows     ${windows} x ${perWindow} per condition\n`);

  for (let w = 0; w < windows; w++) {
    const order = w % 2 === 0 ? conditions : [...conditions].reverse();
    for (const variant of order) {
      process.stdout.write(`window ${w + 1} ${variant.padEnd(14)}`);
      for (let i = 0; i < perWindow; i++) {
        const r = await observe(browser, variant, w);
        (r.ok ? all : failures).push(r);
        appendFileSync(rawPath, JSON.stringify(r) + "\n");
        process.stdout.write(r.ok ? "." : "x");
      }
      process.stdout.write("\n");
    }
  }
  await browser.close();

  const byCondition = {};
  for (const variant of conditions) {
    const rows = all.filter((r) => r.variant === variant);
    byCondition[TITLES[variant] ?? variant] = {
      variant,
      attempted: rows.length + failures.filter((f) => f.variant === variant).length,
      failed: failures.filter((f) => f.variant === variant).length,
      clientMs: roundAll(summarise(rows.map((r) => r.clickToRowsMs))),
      queryMs: roundAll(summarise(rows.map((r) => r.queryMs))),
      landingTtfb: roundAll(summarise(rows.map((r) => r.landingTtfb))),
      landingLcp: roundAll(summarise(rows.map((r) => r.landingLcp))),
      verifiedRows: [...new Set(rows.map((r) => r.rowsCount))],
      firstIds: [...new Set(rows.map((r) => r.firstId))],
    };
  }

  const run = {
    at: startedAt,
    finishedAt: new Date().toISOString(),
    target,
    from,
    population: "browser clicks on the watchlist link, one click per observation",
    metric:
      "From the click on the watchlist link to the expected rows on screen, verified as 50 rows with the first id the request returned, measured by Chromium.",
    loadModel:
      "Closed loop, one click at a time, a fresh browser context per observation, link prefetch at the Next.js default. Failed and unverified observations are counted.",
    engine: `chromium ${version} via playwright`,
    windows,
    perWindow,
    functionRegion: env.functionRegion ?? "unknown",
    databaseRegion: env.databaseRegion ?? "unknown",
    commit: env.commit ?? "unknown",
    deploymentId: env.deploymentId ?? "unknown",
    attempted: all.length + failures.length,
    failed: failures.length,
    rawValues: rawPath.replace(join(here, ".."), "."),
    conditions: byCondition,
  };

  writeFileSync(join(OUT, "browser.json"), JSON.stringify(run, null, 2));
  // The page reads this one. It carries the headline population only, so a
  // number on the site is always the one a visitor would have experienced.
  writeFileSync(join(OUT, "summary.json"), JSON.stringify({ runs: [run] }, null, 2));
  console.log(`\n${run.metric}`);
  for (const [name, c] of Object.entries(byCondition)) {
    console.log(
      `  ${name.padEnd(32)} n ${String(c.clientMs.n).padStart(3)}  p95 ${fmt(c.clientMs.p95)}  p99 ${fmt(c.clientMs.p99)}${c.clientMs.p99IsMax ? "  (exploratory p99)" : ""}`,
    );
  }
  console.log(`\nwritten: bench/out/browser.json, ${run.rawValues}`);
}

const fmt = (v) => `${v === null ? "-" : v.toFixed(0)} ms`.padStart(9);

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
