#!/usr/bin/env node
/**
 * The database end of the trace.
 *
 * Replays the exact statement the function issues, as the same application
 * role, with the same claims, and captures EXPLAIN (ANALYZE, BUFFERS) for each
 * variant. Then reads what Postgres recorded about those statements in
 * pg_stat_statements.
 *
 * pg_stat_statements is used here to identify a statement and corroborate the
 * work it did. It is never used to produce a percentile: it exposes calls, a
 * mean, a standard deviation and two extremes, and none of those is a p95.
 *
 * The service key is never used. It would bypass row level security, and a
 * measurement taken with RLS bypassed says nothing about a page that runs with
 * RLS on.
 *
 *   node bench/explain.mjs --repeats 25
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "out");
loadEnv(join(here, "..", ".env.local"));

const args = parseArgs(process.argv.slice(2));
const repeats = Number(args.repeats ?? 25);
const days = Number(args.days ?? 30);
const reset = args.reset === "true";

const url = process.env.DATABASE_URL_SESSION ?? process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL_SESSION is not set. Copy .env.example to .env.local.");
  process.exit(1);
}

const sql = postgres(url, { prepare: false, max: 1, ssl: "require", idle_timeout: 5 });

const VARIANTS = {
  before: "watchlist_before",
  after: "watchlist_after",
  "after-noindex": "watchlist_after_noindex",
};

const CLAIMS = JSON.stringify({
  sub: "11111111-2222-4333-8444-555555555555",
  account_id: "12",
  role: "authenticated",
});

const body = (table) => `select id, account_id, symbol, event_at, event_type, price_cents
           from trace.${table}
          where event_at >= $1
          order by event_at desc, id desc
          limit 50`;

async function main() {
  mkdirSync(OUT, { recursive: true });
  const from = new Date(Date.UTC(2026, 8, 11) - days * 86_400_000);
  const plans = [];
  const observed = {};

  const meta = (
    await sql`
    select current_setting('server_version') as version,
           (select count(*) from trace.watchlist_before) as rows_total,
           (select count(distinct account_id) from trace.watchlist_before) as accounts`
  )[0];

  for (const [variant, table] of Object.entries(VARIANTS)) {
    const execs = [];
    let plan = "";
    let rowsSeen = null;
    let firstId = null;
    for (let i = 0; i < repeats; i++) {
      await sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${CLAIMS}, true)`;
        const out = await tx.unsafe(
          `explain (analyze, buffers, costs off) ${body(table)}`,
          [from],
        );
        plan = out.map((r) => r["QUERY PLAN"]).join("\n");
        const m = plan.match(/Execution Time: ([\d.]+) ms/);
        if (m) execs.push(Number(m[1]));

        if (i === repeats - 1) {
          const rows = await tx.unsafe(body(table), [from]);
          rowsSeen = rows.length;
          firstId = rows[0]?.id ?? null;
        }
      });
    }
    plans.push({ variant, table, plan });
    observed[variant] = {
      table: `trace.${table}`,
      repeats,
      usesIndex: /Index Scan|Index Only Scan/.test(plan),
      scanType: /Seq Scan/.test(plan) ? "sequential scan" : "index scan",
      rowsRemovedByFilter: Number(
        (plan.match(/Rows Removed by Filter: (\d+)/) ?? [])[1] ?? 0,
      ),
      explainExecutionMs: {
        note: "EXPLAIN ANALYZE adds instrumentation overhead. These are shown to compare plans, not as the page's latency.",
        observations: execs.map((v) => Math.round(v * 1000) / 1000),
      },
      sameResult: { rows: rowsSeen, firstId },
    };
    console.log(
      `${variant.padEnd(14)} ${observed[variant].scanType.padEnd(17)} rows removed by filter ${String(observed[variant].rowsRemovedByFilter).padStart(7)}`,
    );
  }

  const stats = await sql`
    select query, calls, rows, round(min_exec_time::numeric, 3) as min_exec_ms,
           round(mean_exec_time::numeric, 3) as mean_exec_ms,
           round(max_exec_time::numeric, 3) as max_exec_ms,
           round(stddev_exec_time::numeric, 3) as stddev_exec_ms,
           shared_blks_hit, shared_blks_read
      from trace.query_stats
     where query ilike '%order by event_at desc%'
       and query not ilike 'explain%'
     order by max_exec_time desc
     limit 40`;

  const out = {
    at: new Date().toISOString(),
    path: "postgres over the supavisor session pooler, role trace_app, row level security on",
    server: meta,
    role: (await sql`select current_user as role`)[0].role,
    days,
    variants: observed,
    pgStatStatements: {
      note: "Identification and corroboration only. pg_stat_statements exposes aggregates, so no percentile is taken from it. Each entry below is one statement text; the trace id in the SQL comment is what ties an entry to a single request.",
      entries: stats.map((r) => ({
        ...r,
        variant:
          (r.query.match(/variant=([a-z-]+)/) ?? [])[1] ??
          (r.query.includes("watchlist_before")
            ? "before"
            : r.query.includes("watchlist_after_noindex")
              ? "after-noindex"
              : "after"),
        traceId: (r.query.match(/trace=([A-Za-z0-9:_.-]+)/) ?? [])[1] ?? null,
        query: r.query.replace(/\s+/g, " ").trim().slice(0, 240),
      })),
    },
  };

  writeFileSync(join(OUT, "query-stats.json"), JSON.stringify(out, null, 2));
  writeFileSync(
    join(OUT, "plans.txt"),
    plans
      .map((p) => `=== ${p.variant} (trace.${p.table}) === ${out.at}\n\n${p.plan}\n`)
      .join("\n"),
  );

  console.log(`\npg_stat_statements entries for this statement shape: ${stats.length}`);
  for (const e of out.pgStatStatements.entries.slice(0, 6)) {
    console.log(
      `  ${String(e.variant).padEnd(14)} calls ${String(e.calls).padStart(4)}  min ${e.min_exec_ms} ms  max ${e.max_exec_ms} ms  trace ${e.traceId ?? "-"}`,
    );
  }
  console.log("\nwritten: bench/out/plans.txt, bench/out/query-stats.json");
  if (reset) {
    await sql`select extensions.pg_stat_statements_reset()`.catch(() =>
      console.log("reset needs a privileged role, skipped"),
    );
  }
  await sql.end();
}

function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      out[key] = next && !next.startsWith("--") ? ((i++), next) : "true";
    }
  }
  return out;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
