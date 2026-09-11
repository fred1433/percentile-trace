"use client";

import { useCallback, useState } from "react";

type Variant = "before" | "after";

type Observation = {
  variant: Variant;
  clientMs: number;
  handlerMs: number;
  connectMs: number;
  claimsMs: number;
  queryMs: number;
  traceId: string;
  vercelId: string | null;
  region: string;
  dbRegion: string;
  rows: number;
  firstId: string | null;
  spans: number;
};

const TITLE: Record<Variant, string> = {
  before: "Membership subquery",
  after: "Account claim",
};

/**
 * One request per variant, and every number on screen says where it was
 * measured. The client duration and the handler duration are two measurements
 * of two different things, so neither is ever subtracted from the other.
 */
export function LiveTrace() {
  const [obs, setObs] = useState<Observation[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const out: Observation[] = [];
      for (const variant of ["before", "after"] as Variant[]) {
        out.push(await measure(variant));
      }
      setObs(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <div className="mt-12">
      <button
        onClick={run}
        disabled={busy}
        className="rounded-full bg-ink px-7 py-3.5 text-[15px] font-medium text-white transition-opacity hover:opacity-85 disabled:opacity-40"
      >
        {busy ? "Measuring" : obs ? "Measure again" : "Measure it now"}
      </button>

      {error ? <p className="mt-6 text-[14px] text-[var(--slow)]">{error}</p> : null}

      {obs ? (
        <div className="mt-11 space-y-8">
          {obs.map((o) => (
            <Card key={o.variant} o={o} />
          ))}
          <p className="text-[13px] leading-relaxed text-ink-faint">
            Function in {obs[0].region}, database in {obs[0].dbRegion}. Both
            requests returned {obs[0].rows} rows starting at the same id, so the
            two are comparable. One sample each: the percentiles below come from
            a bench, not from this button.
          </p>
        </div>
      ) : (
        <p className="mt-9 max-w-[34rem] text-[15px] leading-relaxed text-ink-soft">
          Two requests leave your browser now, one against each version of the
          policy. Every number that comes back carries the request id that
          produced it.
        </p>
      )}
    </div>
  );
}

function Card({ o }: { o: Observation }) {
  const slow = o.variant === "before";
  return (
    <div>
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-[15px] font-medium">{TITLE[o.variant]}</span>
        <span
          className="tnum text-[30px] font-semibold tracking-tight md:text-[34px]"
          style={{ color: slow ? "var(--slow)" : "var(--fast)" }}
        >
          {o.queryMs.toFixed(0)} ms
        </span>
      </div>
      <p className="tnum mt-2.5 text-[13.5px] text-ink-soft">
        query, measured by the function
        <span className="mx-2 text-ink-faint">·</span>
        request {Math.round(o.clientMs)} ms, measured by this browser
        <span className="mx-2 text-ink-faint">·</span>
        connect {o.connectMs.toFixed(1)} ms
      </p>
      <p className="mt-2 truncate font-mono text-[12px] text-ink-faint">
        {o.traceId}
      </p>
    </div>
  );
}

async function measure(variant: Variant): Promise<Observation> {
  const url = `/api/trace?variant=${variant}&spans=1&t=${Date.now()}`;
  const t0 = performance.now();
  const res = await fetch(url, { cache: "no-store" });
  const body = await res.json();
  const clientMs = performance.now() - t0;
  if (!res.ok) throw new Error(`The ${variant} request came back ${res.status}.`);

  return {
    variant,
    clientMs,
    handlerMs: body.server.handlerMs,
    connectMs: body.server.connectMs,
    claimsMs: body.server.claimsMs,
    queryMs: body.server.queryMs,
    traceId: body.server.traceId,
    vercelId: body.server.vercelId,
    region: body.server.functionRegion,
    dbRegion: body.server.databaseRegion,
    rows: body.rowsReturned,
    firstId: body.firstId,
    spans: Array.isArray(body.spans) ? body.spans.length : 0,
  };
}
