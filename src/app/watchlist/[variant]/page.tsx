import { Suspense } from "react";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import {
  VARIANTS,
  VARIANT_NAMES,
  isVariant,
  readWatchlist,
  safeTraceId,
  PAGE_SIZE,
  type Variant,
} from "@/lib/watchlist";
import { withObservation } from "@/lib/observation";

/**
 * The shell of this page is prerendered. The rows are not: they are awaited
 * inside a Suspense boundary, so the query sits in the middle of the stream.
 * A page that arrives instantly and then waits is what a visitor experiences,
 * and it is what the browser bench measures: from the click to the moment the
 * expected rows are on screen.
 */
export function generateStaticParams() {
  return VARIANT_NAMES.map((variant) => ({ variant }));
}

export default async function WatchlistPage({
  params,
}: PageProps<"/watchlist/[variant]">) {
  const { variant } = await params;
  if (!isVariant(variant)) notFound();
  const meta = VARIANTS[variant];

  return (
    <main className="mx-auto w-full max-w-[820px] flex-1 px-6 py-16 md:px-8 md:py-24">
      <a
        href="/"
        className="text-[13px] text-ink-faint underline underline-offset-4 hover:text-ink"
      >
        Percentile Trace
      </a>
      <h1 className="mt-7 text-[32px] font-semibold leading-[1.1] tracking-[-0.025em] md:text-[42px]">
        Watchlist
      </h1>
      <p className="mt-5 max-w-[36rem] text-[16px] leading-[1.7] text-ink-soft">
        The last {PAGE_SIZE} events on this account, out of 600 000 rows across
        40 accounts. Everything above this line was prerendered. The rows below
        arrive when the database answers.
      </p>
      <pre className="mt-7 overflow-x-auto rounded-lg border border-rule bg-paper p-5 text-[12.5px] leading-relaxed text-ink-soft">
        {`create policy account_read on trace.${meta.table}\n  for select to trace_app\n  using (${meta.policy});`}
        {meta.indexed
          ? `\n\n-- index on (account_id, event_at desc): present`
          : `\n\n-- index on (account_id, event_at desc): absent`}
      </pre>

      <div className="mt-10 min-h-[260px]">
        <Suspense fallback={<Skeleton />}>
          <Rows variant={variant} />
        </Suspense>
      </div>

      <nav className="mt-12 flex flex-wrap gap-x-6 gap-y-2 border-t border-rule pt-7 text-[13.5px]">
        {VARIANT_NAMES.map((v) => (
          <a
            key={v}
            href={`/watchlist/${v}`}
            data-variant-link={v}
            className={
              v === variant
                ? "text-ink"
                : "text-ink-soft underline underline-offset-4 hover:text-ink"
            }
          >
            {VARIANTS[v].title}
          </a>
        ))}
      </nav>
    </main>
  );
}

async function Rows({ variant }: { variant: Variant }) {
  const h = await headers();
  const traceId = safeTraceId(h.get("x-vercel-id"));

  const { reading, spans } = await withObservation(async (collector) => {
    const reading = await readWatchlist(variant, traceId);
    return { reading, spans: collector.spans };
  });

  return (
    <div
      data-rows-ready="1"
      data-rows-count={reading.rows.length}
      data-first-id={reading.rows[0]?.id ?? ""}
      data-trace-id={reading.traceId}
      data-query-ms={reading.queryMs.toFixed(2)}
    >
      <div className="tnum flex flex-wrap items-baseline gap-x-7 gap-y-1 text-[13.5px] text-ink-soft">
        <span>
          query{" "}
          <strong className="font-semibold text-ink">
            {reading.queryMs.toFixed(1)} ms
          </strong>
        </span>
        <span>connect {reading.connectMs.toFixed(1)} ms</span>
        <span>claims {reading.claimsMs.toFixed(1)} ms</span>
        <span>{spans.length} spans</span>
      </div>
      <table className="tnum mt-6 w-full text-left text-[13.5px]">
        <thead className="text-[11.5px] uppercase tracking-[0.09em] text-ink-faint">
          <tr>
            <th className="pb-2.5 font-medium">When</th>
            <th className="pb-2.5 font-medium">Symbol</th>
            <th className="pb-2.5 font-medium">Event</th>
            <th className="pb-2.5 text-right font-medium">Price</th>
          </tr>
        </thead>
        <tbody>
          {reading.rows.slice(0, 8).map((row) => (
            <tr key={row.id} className="border-t border-rule">
              <td className="py-2.5 text-ink-soft">
                {new Date(row.event_at).toISOString().slice(0, 16).replace("T", " ")}
              </td>
              <td className="py-2.5">{row.symbol}</td>
              <td className="py-2.5 text-ink-soft">{row.event_type}</td>
              <td className="py-2.5 text-right">
                {(row.price_cents / 100).toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-5 text-[12.5px] text-ink-faint">
        {reading.rows.length} rows on account{" "}
        {reading.rows[0]?.account_id ?? "?"}, 8 shown. Trace {reading.traceId}.
      </p>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-3.5 pt-1" aria-hidden data-rows-pending="1">
      {[...Array(6)].map((_, i) => (
        <div key={i} className="h-4 w-full rounded bg-[var(--rule-soft)]" />
      ))}
    </div>
  );
}
