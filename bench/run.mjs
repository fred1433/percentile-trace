#!/usr/bin/env node
/**
 * The bench. Hits the deployed routes N times per arm, sequentially, and keeps
 * every sample. Cold and warm are never mixed: a response that says it was the
 * first one served by its instance goes in a different bucket, because a cold
 * start and a steady-state request are two populations and averaging them
 * produces a number that describes neither.
 *
 *   node bench/run.mjs --target https://percentile-trace.theaipipe.com --samples 200
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { summarise, roundAll } from "./stats.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "out");

const args = parseArgs(process.argv.slice(2));
const target = (args.target ?? "http://localhost:3000").replace(/\/$/, "");
const samples = Number(args.samples ?? 200);
const arms = (args.arms ?? "no-index,indexed").split(",");
const tenant = Number(args.tenant ?? 17);
const days = Number(args.days ?? 30);
const from = args.from ?? "unspecified";
const label = args.label ?? "";
const pauseMs = Number(args.pause ?? 0);

const SEGMENTS = ["total", "fn", "db", "conn", "network"];

async function one(arm) {
  const url = `${target}/api/trace?arm=${arm}&tenant=${tenant}&days=${days}&t=${Date.now()}${Math.random()}`;
  const t0 = performance.now();
  const res = await fetch(url, { cache: "no-store" });
  const body = await res.json();
  const total = performance.now() - t0;
  if (!res.ok) throw new Error(`${arm}: HTTP ${res.status}`);

  const st = parseServerTiming(res.headers.get("server-timing"));
  const fn = st.fn ?? 0;
  return {
    arm,
    total,
    fn,
    db: st.db ?? 0,
    conn: st.conn ?? 0,
    network: Math.max(total - fn, 0),
    cold: res.headers.get("x-pt-cold") === "1",
    region: res.headers.get("x-pt-region") ?? body?.server?.functionRegion ?? "?",
    dbRegion: res.headers.get("x-pt-db-region") ?? "?",
    instance: res.headers.get("x-pt-instance") ?? "?",
    vercelId: res.headers.get("x-vercel-id") ?? null,
    rows: Number(res.headers.get("x-pt-rows") ?? body?.rowsReturned ?? 0),
    at: new Date().toISOString(),
  };
}

function bucket(rows) {
  const out = {};
  for (const seg of SEGMENTS) {
    out[seg] = roundAll(summarise(rows.map((r) => r[seg])));
  }
  return out;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const raw = [];
  console.log(`target ${target}`);
  console.log(`${samples} samples per arm, arms: ${arms.join(", ")}\n`);

  for (const arm of arms) {
    process.stdout.write(`${arm.padEnd(9)} `);
    for (let i = 0; i < samples; i++) {
      raw.push(await one(arm));
      if (i % 20 === 19) process.stdout.write(".");
      if (pauseMs) await sleep(pauseMs);
    }
    process.stdout.write("\n");
  }

  const warm = raw.filter((r) => !r.cold);
  const cold = raw.filter((r) => r.cold);
  const first = raw[0] ?? {};

  const run = {
    at: new Date().toISOString(),
    target,
    from,
    label,
    functionRegion: first.region ?? "?",
    databaseRegion: first.dbRegion ?? "?",
    instances: [...new Set(raw.map((r) => r.instance))].length,
    rowsPerRequest: first.rows ?? 0,
    warm: {
      samples: Math.min(...arms.map((a) => warm.filter((r) => r.arm === a).length)),
      arms: Object.fromEntries(
        arms.map((a) => [a, bucket(warm.filter((r) => r.arm === a))]),
      ),
    },
    cold: {
      samples: cold.length,
      observations: cold.map((r) => ({
        arm: r.arm,
        total: Math.round(r.total),
        fn: Math.round(r.fn),
        conn: Math.round(r.conn),
        db: Math.round(r.db),
      })),
    },
  };

  const stamp = run.at.replace(/[:.]/g, "-");
  writeFileSync(join(OUT, `raw-${stamp}.json`), JSON.stringify(raw, null, 2));

  const summaryPath = join(OUT, "summary.json");
  writeFileSync(summaryPath, JSON.stringify({ runs: [run] }, null, 2));

  console.log(report(run));
  writeFileSync(join(OUT, "last-run.md"), report(run));
  console.log(`\nwritten: bench/out/summary.json, bench/out/raw-${stamp}.json`);
}

function report(run) {
  const lines = [];
  lines.push(`\n${run.target}`);
  lines.push(
    `${run.at} | function ${run.functionRegion} | database ${run.databaseRegion} | ${run.instances} instance(s) | measured from ${run.from}`,
  );
  lines.push("");
  lines.push(
    "arm        segment    n      p50       p95       p99       max",
  );
  for (const [arm, segs] of Object.entries(run.warm.arms)) {
    for (const seg of SEGMENTS) {
      const s = segs[seg];
      lines.push(
        [
          arm.padEnd(10),
          seg.padEnd(10),
          String(s.n).padEnd(6),
          ms(s.p50),
          ms(s.p95),
          ms(s.p99),
          ms(s.max),
        ].join(" "),
      );
    }
    lines.push("");
  }
  if (run.cold.samples) {
    lines.push(`cold starts observed: ${run.cold.samples}`);
    for (const c of run.cold.observations) {
      lines.push(
        `  ${c.arm.padEnd(10)} total ${c.total} ms, function ${c.fn} ms, connection ${c.conn} ms, query ${c.db} ms`,
      );
    }
  } else {
    lines.push("cold starts observed: 0 (every instance was already warm)");
  }
  return lines.join("\n");
}

const ms = (v) => `${v === null ? "-" : v.toFixed(1)}`.padStart(9);

function parseServerTiming(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(",")) {
    const bits = part.trim().split(";");
    const name = bits[0]?.trim();
    const dur = bits.find((b) => b.trim().startsWith("dur="));
    if (name && dur) out[name] = Number.parseFloat(dur.split("=")[1]);
  }
  return out;
}

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
