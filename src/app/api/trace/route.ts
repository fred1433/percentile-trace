import { NextRequest } from "next/server";
import { DB_REGION } from "@/lib/db";
import { VARIANTS, isVariant, readWatchlist, safeTraceId, WINDOW_DAYS, PAGE_SIZE } from "@/lib/watchlist";
import { withObservation } from "@/lib/observation";
import { instanceState } from "@/lib/timing";

/**
 * The HTTP population. One request, one variant, every duration the function
 * measured about itself, and the spans the request produced.
 *
 * Nothing here is derived by subtracting one measurement from another. What
 * the client observes and what the function observes are two numbers about two
 * different things and they are reported as two numbers.
 */
export async function GET(req: NextRequest) {
  const started = performance.now();
  const { firstOnInstance, instanceId, instanceAgeMs } = instanceState();

  const params = req.nextUrl.searchParams;
  const variant = params.get("variant") ?? "after";
  const days = clampInt(params.get("days"), 1, 180, WINDOW_DAYS);
  const withSpans = params.get("spans") === "1";

  if (!isVariant(variant)) {
    return json({ error: `variant must be one of ${Object.keys(VARIANTS).join(", ")}` }, 400, {});
  }

  // Vercel stamps every request with an id that also appears in its runtime
  // log. The raw value goes back in a header; a sanitised copy goes into the
  // SQL comment, so a log line, a pg_stat_statements entry and a request seen
  // in the browser are the same request rather than three plausible neighbours.
  const rawVercelId = req.headers.get("x-vercel-id");
  const traceId = safeTraceId(rawVercelId ?? localTraceId());

  const { reading, spans } = await withObservation(async (collector) => {
    const reading = await readWatchlist(variant, traceId, days);
    return { reading, spans: collector.spans };
  });

  const handlerMs = performance.now() - started;
  const meta = VARIANTS[variant];

  const body = {
    variant,
    table: `trace.${meta.table}`,
    policy: meta.policy,
    indexed: meta.indexed,
    path: "postgres over the supavisor transaction pooler",
    params: { days, pageSize: PAGE_SIZE, accountId: 12 },
    rowsReturned: reading.rows.length,
    firstId: reading.rows[0]?.id ?? null,
    lastId: reading.rows.at(-1)?.id ?? null,
    accountIds: [...new Set(reading.rows.map((r) => r.account_id))],
    newestAt: reading.rows[0]?.event_at ?? null,
    sample: reading.rows.slice(0, 3),
    statement: reading.statement,
    server: {
      handlerMs: round(handlerMs),
      connectMs: round(reading.connectMs),
      claimsMs: round(reading.claimsMs),
      queryMs: round(reading.queryMs),
      functionRegion: process.env.VERCEL_REGION ?? "local",
      databaseRegion: DB_REGION,
      firstOnInstance,
      instanceId,
      instanceAgeMs,
      traceId: reading.traceId,
      vercelId: rawVercelId,
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? "local",
      deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? "local",
      nodeVersion: process.version,
    },
    ...(withSpans ? { spans } : {}),
  };

  return json(body, 200, {
    "Server-Timing": [
      `connect;dur=${reading.connectMs.toFixed(2)}`,
      `claims;dur=${reading.claimsMs.toFixed(2)}`,
      `query;dur=${reading.queryMs.toFixed(2)};desc="${meta.title}"`,
      `handler;dur=${handlerMs.toFixed(2)}`,
    ].join(", "),
    "x-pt-variant": variant,
    "x-pt-trace-id": reading.traceId,
    "x-pt-vercel-id": rawVercelId ?? "none",
    "x-pt-region": process.env.VERCEL_REGION ?? "local",
    "x-pt-db-region": DB_REGION,
    "x-pt-first-on-instance": firstOnInstance ? "1" : "0",
    "x-pt-instance": instanceId,
    "x-pt-rows": String(reading.rows.length),
    "x-pt-commit": process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
  });
}

function json(body: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "timing-allow-origin": "*",
      ...headers,
    },
  });
}

const localTraceId = () => `local::${Math.random().toString(36).slice(2, 10)}`;

function clampInt(raw: string | null, min: number, max: number, fallback: number) {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const round = (n: number) => Math.round(n * 100) / 100;
