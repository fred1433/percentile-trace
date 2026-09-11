#!/usr/bin/env node
/**
 * Raw evidence, captured rather than described.
 *
 *  - the response headers exactly as the deployment returned them, which is
 *    the same text the browser's network panel shows in its timing section
 *  - the same Server-Timing as the browser parsed it, read back out of
 *    PerformanceResourceTiming.serverTiming inside a real Chromium
 *  - the span tree the request produced, with the ids that tie it together
 *
 *   node bench/evidence.mjs --target https://percentile-trace.theaipipe.com
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "out");
const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) =>
    a.startsWith("--")
      ? [[a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"]]
      : [],
  ),
);
const target = (args.target ?? "https://percentile-trace.theaipipe.com").replace(/\/$/, "");

async function main() {
  mkdirSync(OUT, { recursive: true });
  const blocks = [];

  for (const variant of ["before", "after"]) {
    const url = `${target}/api/trace?variant=${variant}&spans=1`;
    const res = await fetch(url, { cache: "no-store" });
    const body = await res.json();
    const headers = [...res.headers.entries()]
      .filter(([k]) => k.startsWith("x-") || k === "server-timing" || k === "cache-control")
      .sort()
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");

    blocks.push(
      [
        `=== ${variant}: response headers as returned by ${target} ===`,
        `GET /api/trace?variant=${variant}`,
        `HTTP/2 ${res.status}`,
        headers,
        "",
        `--- the statement that ran, with the trace id carried into the SQL comment ---`,
        body.statement,
        "",
        `--- the span tree of this one request ---`,
        body.spans
          ?.map(
            (s) =>
              `${s.name.padEnd(16)} ${s.durationMs.toFixed(2).padStart(9)} ms   span ${s.spanId}  parent ${s.parentSpanId ?? "-"}  trace ${s.traceId}`,
          )
          .join("\n") ?? "(none)",
        "",
      ].join("\n"),
    );
  }

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(target, { waitUntil: "load" });
  await page.click("text=Measure it now");
  await page.waitForFunction(() => document.body.innerText.includes("measured by this browser"), undefined, {
    timeout: 60_000,
  });
  const parsed = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .filter((e) => e.name.includes("/api/trace"))
      .map((e) => ({
        url: new URL(e.name).pathname + new URL(e.name).search.replace(/&t=\d+/, ""),
        requestToResponseStartMs: e.responseStart - e.requestStart,
        durationMs: e.duration,
        serverTiming: e.serverTiming.map((s) => ({
          name: s.name,
          duration: s.duration,
          description: s.description,
        })),
      })),
  );
  await browser.close();

  blocks.push(
    [
      "=== the same Server-Timing, read by a browser ===",
      "PerformanceResourceTiming.serverTiming, from a real Chromium on the deployed page.",
      "This is the data the network panel renders in its timing section.",
      "",
      JSON.stringify(parsed, null, 2),
      "",
    ].join("\n"),
  );

  const text = `Captured ${new Date().toISOString()} against ${target}\n\n${blocks.join("\n")}`;
  writeFileSync(join(OUT, "evidence.txt"), text);
  console.log(text.slice(0, 2000));
  console.log("\nwritten: bench/out/evidence.txt");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
