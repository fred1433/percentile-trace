#!/usr/bin/env node
/**
 * The measurement manifest.
 *
 * A number without the state it was taken in is a rumour. Checking out an old
 * commit does not restore a database, so the manifest records both halves: the
 * pinned versions and the deployment on one side, and the migrations, indexes,
 * policies and row counts on the other.
 *
 *   node bench/manifest.mjs --target https://percentile-trace.theaipipe.com
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const OUT = join(here, "out");
loadEnv(join(root, ".env.local"));

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) =>
    a.startsWith("--")
      ? [[a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"]]
      : [],
  ),
);
const target = (args.target ?? "https://percentile-trace.theaipipe.com").replace(/\/$/, "");

const url = process.env.DATABASE_URL_SESSION ?? process.env.DATABASE_URL;
const sql = url
  ? postgres(url, { prepare: false, max: 1, ssl: "require", idle_timeout: 5 })
  : null;

async function main() {
  mkdirSync(OUT, { recursive: true });
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const installed = (name) => lock.packages?.[`node_modules/${name}`]?.version ?? null;

  let health = null;
  try {
    health = await (await fetch(`${target}/api/health?db=1`, { cache: "no-store" })).json();
  } catch (e) {
    health = { error: String(e) };
  }

  let database = { error: "DATABASE_URL_SESSION not set" };
  if (sql) {
    const [server] = await sql`select current_setting('server_version') as version,
                                      current_user as role`;
    const tables = await sql`
      select c.relname as table, c.reltuples::bigint as planner_rows,
             pg_size_pretty(pg_relation_size(c.oid)) as heap_size
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'trace' and c.relkind = 'r' order by 1`;
    const indexes = await sql`
      select tablename as table, indexname as index, indexdef as definition
        from pg_indexes where schemaname = 'trace' order by 1, 2`;
    const policies = await sql`
      select tablename as table, policyname as policy, roles::text as roles,
             pg_get_expr(pol.polqual, pol.polrelid) as using_expression
        from pg_policies p
        join pg_policy pol on pol.polname = p.policyname
        join pg_class c on c.oid = pol.polrelid and c.relname = p.tablename
       where schemaname = 'trace' order by 1`;
    // The manifest is read with the application role, and row level security
    // applies to it, so a plain count(*) returns only what that caller may see.
    // The planner's estimate in pg_class is not filtered by a policy, so it is
    // the honest way to state the size of the table from here.
    const planner = await sql`
      select c.relname as table, c.reltuples::bigint as estimated_rows
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'trace' and c.relkind = 'r' order by 1`;
    const asCaller = await sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({
        sub: "11111111-2222-4333-8444-555555555555",
        account_id: "12",
        role: "authenticated",
      })}, true)`;
      return tx`select count(*) as visible_rows,
                       count(distinct account_id) as visible_accounts,
                       min(event_at) as oldest, max(event_at) as newest
                  from trace.watchlist_after`;
    });
    const rls = await sql`
      select c.relname as table, c.relrowsecurity as rls_enabled
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'trace' and c.relkind = 'r' order by 1`;

    database = {
      server: server.version,
      readAs: server.role,
      seed: "select setseed(0.20260911) before the insert, see db/002_seed.sql",
      datasetNote:
        "Read with the application role, so row level security applies. The planner estimate is unfiltered; the visible counts are what the measured caller can see.",
      plannerEstimate: Object.fromEntries(planner.map((r) => [r.table, Number(r.estimated_rows)])),
      visibleToMeasuredCaller: { account_id: 12, ...asCaller[0] },
      rowLevelSecurity: Object.fromEntries(rls.map((r) => [r.table, r.rls_enabled])),
      tables,
      indexes,
      policies,
    };
    await sql.end();
  }

  const manifest = {
    at: new Date().toISOString(),
    repository: {
      commit: git("rev-parse HEAD"),
      shortCommit: git("rev-parse --short HEAD"),
      branch: git("rev-parse --abbrev-ref HEAD"),
      dirty: git("status --porcelain").length > 0,
    },
    pinnedVersions: {
      next: pkg.dependencies.next,
      nextInstalled: installed("next"),
      react: installed("react"),
      postgresDriver: installed("postgres"),
      playwright: installed("playwright"),
      openTelemetryApi: installed("@opentelemetry/api"),
      vercelOtel: installed("@vercel/otel"),
      nodeLocal: process.version,
    },
    deployment: {
      target,
      commit: health?.commit ?? null,
      deploymentId: health?.deploymentId ?? null,
      functionRegion: health?.functionRegion ?? null,
      nodeRuntime: health?.nodeVersion ?? null,
      databaseRegion: health?.databaseRegion ?? null,
      emptyRoundTripMs: health?.roundTripMs ?? null,
      // Read from the Vercel project on 2026-09-11 and copied here verbatim.
      // No claim is made about what Fluid Compute changes in CPU allocation,
      // because that was not measured.
      vercelProjectAsRead: {
        readAt: "2026-09-11",
        nodeVersion: "24.x",
        serverlessFunctionRegion: "iad1",
        resourceConfig: {
          fluid: true,
          functionDefaultRegions: ["iad1"],
          elasticConcurrencyEnabled: true,
          functionDefaultMemoryType: "standard",
          functionDefaultTimeout: 300,
        },
      },
    },
    path: "the application opens a Postgres connection through the Supavisor transaction pooler. The Supabase Data API is not used.",
    database,
  };

  writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`commit      ${manifest.repository.shortCommit}${manifest.repository.dirty ? " (working tree dirty)" : ""}`);
  console.log(`deployment  ${manifest.deployment.deploymentId} in ${manifest.deployment.functionRegion}`);
  console.log(`next        ${manifest.pinnedVersions.nextInstalled}, node ${manifest.deployment.nodeRuntime}`);
  console.log(
    `database    ${database.server ?? "?"} in ${manifest.deployment.databaseRegion}, ` +
      `${database.plannerEstimate?.watchlist_before ?? "?"} rows estimated, ` +
      `${database.visibleToMeasuredCaller?.visible_rows ?? "?"} visible to the measured caller`,
  );
  console.log("\nwritten: bench/out/manifest.json");
}

function git(cmd) {
  try {
    return execSync(`git ${cmd}`, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
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
