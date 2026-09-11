import { sql, DB_REGION } from "@/lib/db";
import { Stopwatch, instanceState } from "@/lib/timing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** No database work, so the bench can separate platform latency from query time. */
export async function GET(req: Request) {
  const w = new Stopwatch();
  const { cold, instanceId, uptimeMs } = instanceState();
  const url = new URL(req.url);
  const touchDb = url.searchParams.get("db") === "1";

  let dbMs: number | null = null;
  if (touchDb) {
    const t = performance.now();
    await sql`select 1 as ok`;
    dbMs = performance.now() - t;
    w.add("db", dbMs, "select 1");
  }

  return new Response(
    JSON.stringify({
      ok: true,
      functionRegion: process.env.VERCEL_REGION ?? "local",
      databaseRegion: DB_REGION,
      cold,
      instanceId,
      instanceUptimeMs: uptimeMs,
      roundTripMs: dbMs === null ? null : Math.round(dbMs * 100) / 100,
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
    }),
    {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store, max-age=0",
        "timing-allow-origin": "*",
        "Server-Timing": w.header(),
        "x-pt-region": process.env.VERCEL_REGION ?? "local",
        "x-pt-db-region": DB_REGION,
        "x-pt-cold": cold ? "1" : "0",
        "x-pt-instance": instanceId,
      },
    },
  );
}
