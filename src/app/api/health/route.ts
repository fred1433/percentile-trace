import { sql, DB_REGION } from "@/lib/db";
import { instanceState } from "@/lib/timing";

/**
 * No policy, no table, one round trip. The floor under every other number:
 * whatever the watchlist costs, this much of it is the platform and the trip
 * to the database, not the query.
 */
export async function GET(req: Request) {
  const started = performance.now();
  const { firstOnInstance, instanceId, instanceAgeMs } = instanceState();
  const url = new URL(req.url);
  const touchDb = url.searchParams.get("db") === "1";

  let roundTripMs: number | null = null;
  if (touchDb) {
    const t = performance.now();
    await sql`select 1 as ok`;
    roundTripMs = performance.now() - t;
  }
  const handlerMs = performance.now() - started;

  return new Response(
    JSON.stringify({
      ok: true,
      functionRegion: process.env.VERCEL_REGION ?? "local",
      databaseRegion: DB_REGION,
      firstOnInstance,
      instanceId,
      instanceAgeMs,
      handlerMs: round(handlerMs),
      roundTripMs: roundTripMs === null ? null : round(roundTripMs),
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? "local",
      deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? "local",
      nodeVersion: process.version,
      vercelId: req.headers.get("x-vercel-id"),
    }),
    {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store, max-age=0",
        "timing-allow-origin": "*",
        "Server-Timing": [
          roundTripMs === null ? null : `db;dur=${roundTripMs.toFixed(2)};desc="select 1"`,
          `handler;dur=${handlerMs.toFixed(2)}`,
        ]
          .filter(Boolean)
          .join(", "),
        "x-pt-region": process.env.VERCEL_REGION ?? "local",
        "x-pt-db-region": DB_REGION,
        "x-pt-first-on-instance": firstOnInstance ? "1" : "0",
        "x-pt-instance": instanceId,
        "x-pt-commit": process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
      },
    },
  );
}

const round = (n: number) => Math.round(n * 100) / 100;
