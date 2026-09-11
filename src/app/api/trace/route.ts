import { NextRequest } from "next/server";
import { sql, DB_REGION } from "@/lib/db";
import { Stopwatch, instanceState } from "@/lib/timing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ARMS = {
  "no-index": "events_no_index",
  indexed: "events_indexed",
} as const;

type Arm = keyof typeof ARMS;

export async function GET(req: NextRequest) {
  const w = new Stopwatch();
  const { cold, instanceId, uptimeMs } = instanceState();

  const params = req.nextUrl.searchParams;
  const arm = (params.get("arm") ?? "indexed") as Arm;
  const tenant = clampInt(params.get("tenant"), 1, 64, 17);
  const days = clampInt(params.get("days"), 1, 180, 30);

  if (!(arm in ARMS)) {
    return json({ error: "arm must be no-index or indexed" }, 400, {});
  }

  const table = ARMS[arm];
  const since = new Date(Date.UTC(2026, 8, 11) - days * 86400_000);

  w.mark("parse");

  let connMs = 0;
  let dbMs = 0;
  let rows: Row[] = [];
  const tConn = performance.now();

  const conn = await sql.reserve();
  connMs = performance.now() - tConn;

  try {
    const tDb = performance.now();
    rows = (await conn.unsafe(
      `select id, occurred_at, kind, amount_cents, label
         from trace.${table}
        where tenant_id = $1
          and occurred_at >= $2
        order by occurred_at desc
        limit 50`,
      [tenant, since],
    )) as unknown as Row[];
    dbMs = performance.now() - tDb;
  } finally {
    conn.release();
  }

  w.add("conn", connMs, cold ? "new connection" : "pooled");
  w.add("db", dbMs, arm === "indexed" ? "index scan" : "seq scan");

  const body = {
    arm,
    table: `trace.${table}`,
    tenant,
    days,
    rowsReturned: rows.length,
    newestAt: rows[0]?.occurred_at ?? null,
    sample: rows.slice(0, 3),
    server: {
      connMs: round(connMs),
      dbMs: round(dbMs),
      functionRegion: process.env.VERCEL_REGION ?? "local",
      databaseRegion: DB_REGION,
      cold,
      instanceId,
      instanceUptimeMs: uptimeMs,
    },
  };

  w.mark("serialize");

  return json(body, 200, {
    "Server-Timing": w.header(),
    "x-pt-arm": arm,
    "x-pt-region": process.env.VERCEL_REGION ?? "local",
    "x-pt-db-region": DB_REGION,
    "x-pt-cold": cold ? "1" : "0",
    "x-pt-instance": instanceId,
    "x-pt-rows": String(rows.length),
  });
}

type Row = {
  id: string;
  occurred_at: string;
  kind: string;
  amount_cents: number;
  label: string;
};

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

function clampInt(raw: string | null, min: number, max: number, fallback: number) {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function round(n: number) {
  return Math.round(n * 100) / 100;
}
