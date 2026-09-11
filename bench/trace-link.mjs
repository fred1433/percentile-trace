#!/usr/bin/env node
/**
 * Where the trace id is actually observable, demonstrated rather than claimed.
 *
 * The Vercel request id travels into the statement as a comment. Two things
 * were checked on this project rather than assumed:
 *
 *  - pg_stat_statements does NOT separate requests by that comment. It keys on
 *    the normalised parse tree, and a comment is not part of it, so thousands
 *    of requests with distinct ids collapse into one entry whose stored text
 *    happens to carry whichever id arrived first. It identifies the statement,
 *    not the request.
 *  - pg_stat_activity DOES carry the comment, because it holds the statement
 *    text of the session running right now. That is where a request in flight
 *    is matched to the query it is waiting on.
 *
 * This script runs one slow statement on one connection and reads it back from
 * another at the same time, then writes what it saw.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "out");
loadEnv(join(here, "..", ".env.local"));

const url = process.env.DATABASE_URL_SESSION ?? process.env.DATABASE_URL;
const traceId = `demo::${Date.now().toString(36)}`;
const CLAIMS = JSON.stringify({
  sub: "11111111-2222-4333-8444-555555555555",
  account_id: "12",
  role: "authenticated",
});

async function main() {
  mkdirSync(OUT, { recursive: true });
  const runner = postgres(url, { prepare: false, max: 1, ssl: "require", idle_timeout: 5 });
  const watcher = postgres(url, { prepare: false, max: 1, ssl: "require", idle_timeout: 5 });
  await watcher`select 1`;

  let seen = [];
  const poll = setInterval(async () => {
    try {
      const rows = await watcher`
        select pid, state, now() - query_start as running_for, query
          from pg_stat_activity
         where query like ${"%" + traceId + "%"}
           and query not like '%pg_stat_activity%'`;
      if (rows.length) seen = rows;
    } catch {
      /* the watcher may lose its turn while the runner holds the pool */
    }
  }, 25);

  const statement = `/* pt variant=before trace=${traceId} */
    select id, account_id, symbol, event_at, event_type, price_cents
      from trace.watchlist_before
     where event_at >= $1
     order by event_at desc, id desc
     limit 50`;

  await runner.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${CLAIMS}, true)`;
    // Repeat so the statement is in flight long enough to be caught.
    for (let i = 0; i < 40; i++) {
      await tx.unsafe(statement, [new Date(Date.UTC(2026, 8, 11) - 30 * 86_400_000)]);
    }
  });
  clearInterval(poll);

  const statements = await watcher`
    select calls, round(min_exec_time::numeric,3) as min_exec_ms,
           round(max_exec_time::numeric,3) as max_exec_ms, query
      from trace.query_stats
     where query ilike '%watchlist_before%' and query not ilike 'explain%'`;

  const carriesThisTrace = statements.filter((r) => r.query.includes(traceId)).length;

  const report = {
    at: new Date().toISOString(),
    traceId,
    pgStatActivity: {
      caught: seen.length > 0,
      note: "The statement text of a running session carries the comment, so a request in flight can be matched to the query it is waiting on.",
      rows: seen.map((r) => ({
        pid: r.pid,
        state: r.state,
        query: String(r.query).replace(/\s+/g, " ").trim().slice(0, 200),
      })),
    },
    pgStatStatements: {
      entriesForThisTable: statements.length,
      entriesCarryingThisTraceId: carriesThisTrace,
      callsInThoseEntries: statements.map((r) => Number(r.calls)),
      note: "pg_stat_statements keys on the normalised parse tree and a comment is not part of it. Many requests with distinct trace ids collapse into one entry, whose stored text keeps whichever id arrived first. It identifies the statement, not the request.",
    },
  };

  writeFileSync(join(OUT, "trace-link.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await runner.end();
  await watcher.end();
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
