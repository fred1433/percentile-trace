"use client";

import { useCallback, useEffect, useState } from "react";
import { onLCP, onTTFB, type Metric } from "web-vitals";

type Arm = "no-index" | "indexed";

type Reading = {
  arm: Arm;
  total: number;
  network: number;
  conn: number;
  db: number;
  app: number;
  region: string;
  dbRegion: string;
  rows: number;
  cold: boolean;
};

const LABEL: Record<Arm, string> = {
  "no-index": "No index",
  indexed: "With the index",
};

export function TracePanel() {
  const [readings, setReadings] = useState<Reading[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [vitals, setVitals] = useState<{ ttfb?: number; lcp?: number }>({});

  useEffect(() => {
    const take = (k: "ttfb" | "lcp") => (m: Metric) =>
      setVitals((v) => ({ ...v, [k]: m.value }));
    onTTFB(take("ttfb"));
    onLCP(take("lcp"));
  }, []);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const out: Reading[] = [];
      for (const arm of ["no-index", "indexed"] as Arm[]) {
        out.push(await measure(arm));
      }
      setReadings(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const scale = readings ? Math.max(...readings.map((r) => r.total)) : 1;

  return (
    <div className="mt-14">
      <button
        onClick={run}
        disabled={busy}
        className="rounded-full bg-ink px-7 py-3.5 text-[15px] font-medium text-white transition-opacity hover:opacity-85 disabled:opacity-40"
      >
        {busy ? "Measuring" : readings ? "Measure again" : "Run the trace"}
      </button>

      {error ? (
        <p className="mt-6 text-[14px] text-[var(--slow)]">{error}</p>
      ) : null}

      {readings ? (
        <div className="mt-12 space-y-9">
          {readings.map((r) => (
            <Row key={r.arm} r={r} scale={scale} />
          ))}
          <p className="tnum pt-1 text-[13.5px] leading-relaxed text-ink-faint">
            Function in {readings[0].region}, database in {readings[0].dbRegion}.
            50 rows out of 600 000, same tenant and same window on both arms.
            {vitals.ttfb !== undefined
              ? ` This page: TTFB ${Math.round(vitals.ttfb)} ms`
              : ""}
            {vitals.lcp !== undefined ? `, LCP ${Math.round(vitals.lcp)} ms.` : "."}
          </p>
        </div>
      ) : (
        <p className="mt-10 max-w-xl text-[15px] leading-relaxed text-ink-soft">
          Two requests leave your browser, one against a table with the index the
          query needs and one against the same rows without it. Everything below is
          measured on the spot, nothing is replayed.
        </p>
      )}
    </div>
  );
}

function Row({ r, scale }: { r: Reading; scale: number }) {
  const w = (v: number) => `${Math.max((v / scale) * 100, v > 0 ? 0.4 : 0)}%`;
  const fast = r.arm === "indexed";
  return (
    <div>
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-[15px] font-medium">{LABEL[r.arm]}</span>
        <span
          className="tnum text-[30px] font-semibold tracking-tight md:text-[34px]"
          style={{ color: fast ? "var(--fast)" : "var(--slow)" }}
        >
          {Math.round(r.total)} ms
        </span>
      </div>
      <div className="mt-3 flex h-2.5 w-full overflow-hidden rounded-full bg-[var(--rule-soft)]">
        <span style={{ width: w(r.network), background: "var(--net)" }} />
        <span style={{ width: w(r.conn), background: "var(--conn)" }} />
        <span
          style={{ width: w(r.db), background: fast ? "var(--fast)" : "var(--slow)" }}
        />
      </div>
      <p className="tnum mt-3 text-[13.5px] text-ink-soft">
        network {Math.round(r.network)} ms
        <Dot />
        connection {r.conn.toFixed(1)} ms
        <Dot />
        query {r.db.toFixed(1)} ms
      </p>
    </div>
  );
}

function Dot() {
  return <span className="mx-2 text-ink-faint">·</span>;
}

async function measure(arm: Arm): Promise<Reading> {
  const url = `/api/trace?arm=${arm}&tenant=17&days=30&t=${Date.now()}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`The ${arm} request came back ${res.status}.`);
  const body = await res.json();
  const seg = parseServerTiming(res.headers.get("server-timing"));

  const entry = performance
    .getEntriesByType("resource")
    .filter((e): e is PerformanceResourceTiming => e.name.endsWith(url))
    .pop();

  const fn = seg.fn ?? 0;
  const browser = entry
    ? entry.responseStart - entry.requestStart
    : fn;
  const network = Math.max(browser - fn, 0);

  return {
    arm,
    total: network + fn,
    network,
    conn: seg.conn ?? 0,
    db: seg.db ?? 0,
    app: Math.max(fn - (seg.conn ?? 0) - (seg.db ?? 0), 0),
    region: body.server.functionRegion,
    dbRegion: body.server.databaseRegion,
    rows: body.rowsReturned,
    cold: body.server.cold,
  };
}

function parseServerTiming(header: string | null): Record<string, number> {
  const out: Record<string, number> = {};
  if (!header) return out;
  for (const part of header.split(",")) {
    const bits = part.trim().split(";");
    const name = bits[0]?.trim();
    const dur = bits.find((b) => b.trim().startsWith("dur="));
    if (name && dur) out[name] = Number.parseFloat(dur.split("=")[1]);
  }
  return out;
}
