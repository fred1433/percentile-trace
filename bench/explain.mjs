#!/usr/bin/env node
/**
 * The database end of the trace. Runs EXPLAIN (ANALYZE, BUFFERS) on both arms
 * of the query the function issues, and reads what Postgres itself recorded in
 * pg_stat_statements for those statements.
 *
 * The two are not the same measurement and the report keeps them apart:
 * pg_stat_statements is execution time inside the server, the Server-Timing
 * "db" segment is what the function waited for, round trip included. The gap
 * between them is the cost of where the function runs.
 *
 *   node bench/explain.mjs --repeats 25
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { summarise, roundAll } from "./stats.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "out");
loadEnv(join(here, "..", ".env.local"));

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) =>
    a.startsWith("--") ? [[a.slice(2), all[i + 1]?.startsWith("--") === false ? all[i + 1] : "true"]] : [],
  ),
);
const repeats = Number(args.repeats ?? 25);
const tenant = Number(args.tenant ?? 17);
const days = Number(args.days ?? 30);

const url = process.env.DATABASE_URL_SESSION ?? process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL_SESSION is not set. Copy .env.example to .env.local.");
  process.exit(1);
}

const sql = postgres(url, { prepare: false, max: 1, ssl: "require", idle_timeout: 5 });

const ARMS = { "no-index": "events_no_index", indexed: "events_indexed" };

function statement(table) {
  return `select id, occurred_at, kind, amount_cents, label
         from trace.${table}
        where tenant_id = $1
          and occurred_at >= $2
        order by occurred_at desc
        limit 50`;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const since = new Date(Date.UTC(2026, 8, 11) - days * 86400_000);
  const plans = [];
  const timings = {};

  const meta = await sql`
    select current_setting('server_version') as version,
           (select count(*) from trace.events_no_index) as rows_no_index,
           (select count(*) from trace.events_indexed) as rows_indexed,
           pg_size_pretty(pg_relation_size('trace.events_no_index')) as size_no_index,
           pg_size_pretty(pg_relation_size('trace.events_indexed')) as size_indexed,
           pg_size_pretty(pg_relation_size('trace.events_indexed_tenant_time')) as size_index`;

  for (const [arm, table] of Object.entries(ARMS)) {
    const execs = [];
    let lastPlan = "";
    for (let i = 0; i < repeats; i++) {
      const rows = await sql.unsafe(
        `explain (analyze, buffers, costs off) ${statement(table)}`,
        [tenant, since],
      );
      const text = rows.map((r) => r["QUERY PLAN"]).join("\n");
      lastPlan = text;
      const m = text.match(/Execution Time: ([\d.]+) ms/);
      if (m) execs.push(Number(m[1]));
    }
    plans.push({ arm, table, plan: lastPlan });
    timings[arm] = roundAll(summarise(execs), 3);
    console.log(
      `${arm.padEnd(10)} EXPLAIN ANALYZE execution time over ${repeats} runs: ` +
        `p50 ${timings[arm].p50} ms, p95 ${timings[arm].p95} ms, max ${timings[arm].max} ms`,
    );
  }

  const stats = await sql`
    select query, calls, rows,
           round(min_exec_time::numeric, 3)  as min_exec_ms,
           round(mean_exec_time::numeric, 3) as mean_exec_ms,
           round(max_exec_time::numeric, 3)  as max_exec_ms,
           shared_blks_hit, shared_blks_read
      from trace.query_stats
     where query ilike '%order by occurred_at desc%'
     order by max_exec_time desc`;

  const out = {
    at: new Date().toISOString(),
    server: meta[0],
    repeats,
    tenant,
    days,
    explainAnalyze: timings,
    pgStatStatements: stats.map((r) => ({
      ...r,
      query: r.query.replace(/\s+/g, " ").trim(),
    })),
  };

  writeFileSync(join(OUT, "query-stats.json"), JSON.stringify(out, null, 2));
  writeFileSync(
    join(OUT, "plans.txt"),
    plans
      .map(
        (p) =>
          `=== ${p.arm} (trace.${p.table}) === ${out.at}\n\n${p.plan}\n`,
      )
      .join("\n"),
  );
  console.log("\npg_stat_statements, this project's statements only:");
  for (const s of out.pgStatStatements) {
    console.log(
      `  calls ${String(s.calls).padStart(5)}  min ${s.min_exec_ms} ms  mean ${s.mean_exec_ms} ms  max ${s.max_exec_ms} ms  ${
        s.query.includes("no_index") ? "events_no_index" : "events_indexed"
      }`,
    );
  }
  console.log("\nwritten: bench/out/plans.txt, bench/out/query-stats.json");
  await sql.end();
}

function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
