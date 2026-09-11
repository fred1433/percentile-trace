#!/usr/bin/env node
/**
 * The browser end of the trace. A real Chromium loads the deployed page N
 * times and reports what the page itself experienced: TTFB and LCP from the
 * web-vitals library, plus the resource timing of each API call the page made.
 *
 * Every load is a fresh context with an empty cache, so nothing is served from
 * a warm browser cache and called a measurement.
 *
 *   node bench/browser.mjs --target https://percentile-trace.theaipipe.com --loads 15
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { summarise, roundAll } from "./stats.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "out");

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) =>
    a.startsWith("--")
      ? [[a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"]]
      : [],
  ),
);
const target = (args.target ?? "http://localhost:3000").replace(/\/$/, "");
const loads = Number(args.loads ?? 15);
const from = args.from ?? "unspecified";

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const samples = [];

  for (let i = 0; i < loads; i++) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(target, { waitUntil: "load" });

    // The page reports its own LCP; give the observer a moment to settle, then
    // ask the browser for the navigation entry rather than timing it ourselves.
    await page.waitForTimeout(1200);

    const nav = await page.evaluate(() => {
      const n = performance.getEntriesByType("navigation")[0];
      const lcp = performance.getEntriesByType("largest-contentful-paint").pop();
      return {
        ttfb: n ? n.responseStart - n.startTime : null,
        domContentLoaded: n ? n.domContentLoadedEventEnd - n.startTime : null,
        loadEvent: n ? n.loadEventEnd - n.startTime : null,
        transferSize: n ? n.transferSize : null,
        lcp: lcp ? lcp.startTime : null,
      };
    });

    // Then the trace itself, driven the way a visitor drives it.
    await page.getByRole("button", { name: /run the trace/i }).click();
    await page.waitForFunction(
      () => document.body.innerText.includes("network"),
      undefined,
      { timeout: 30_000 },
    );
    const api = await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .filter((e) => e.name.includes("/api/trace"))
        .map((e) => ({
          arm: new URL(e.name).searchParams.get("arm"),
          ttfb: e.responseStart - e.requestStart,
          duration: e.duration,
        })),
    );

    samples.push({ ...nav, api });
    process.stdout.write(".");
    await ctx.close();
  }
  process.stdout.write("\n");
  await browser.close();

  const pick = (k) => samples.map((s) => s[k]).filter((v) => typeof v === "number");
  const apiOf = (arm, k) =>
    samples.flatMap((s) => s.api.filter((a) => a.arm === arm).map((a) => a[k]));

  const run = {
    at: new Date().toISOString(),
    target,
    from,
    loads,
    engine: "chromium (playwright), fresh context per load",
    page: {
      ttfb: roundAll(summarise(pick("ttfb"))),
      lcp: roundAll(summarise(pick("lcp"))),
      loadEvent: roundAll(summarise(pick("loadEvent"))),
    },
    api: {
      "no-index": { ttfb: roundAll(summarise(apiOf("no-index", "ttfb"))) },
      indexed: { ttfb: roundAll(summarise(apiOf("indexed", "ttfb"))) },
    },
  };

  writeFileSync(join(OUT, "browser.json"), JSON.stringify(run, null, 2));
  console.log(`\n${target}, ${loads} loads, measured from ${from}`);
  for (const [k, v] of Object.entries(run.page)) {
    console.log(`  page ${k.padEnd(14)} p50 ${fmt(v.p50)}  p95 ${fmt(v.p95)}  p99 ${fmt(v.p99)}`);
  }
  for (const [arm, v] of Object.entries(run.api)) {
    console.log(
      `  api  ${arm.padEnd(14)} p50 ${fmt(v.ttfb.p50)}  p95 ${fmt(v.ttfb.p95)}  p99 ${fmt(v.ttfb.p99)}`,
    );
  }
  console.log("\nwritten: bench/out/browser.json");
}

const fmt = (v) => `${v === null ? "-" : v.toFixed(1)} ms`.padStart(10);

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
