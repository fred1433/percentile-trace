import Link from "next/link";
import { LiveTrace } from "@/components/LiveTrace";
import summary from "../../bench/out/summary.json";

type Stat = { n: number; p95: number | null; p99: number | null; p99IsMax?: boolean };
type Run = {
  at: string;
  target: string;
  from: string;
  functionRegion: string;
  databaseRegion: string;
  metric: string;
  loadModel: string;
  conditions: Record<string, { clientMs: Stat; queryMs: Stat }>;
};

const run = (summary.runs as unknown as Run[])[0];

export default function Home() {
  return (
    <>
      <main className="mx-auto w-full max-w-[780px] flex-1 px-6 md:px-8">
        <section className="pt-24 pb-28 md:pt-32 md:pb-32">
          <p className="text-[13px] font-medium uppercase tracking-[0.14em] text-ink-faint">
            Percentile Trace
          </p>
          <h1 className="mt-7 text-[42px] font-semibold leading-[1.05] tracking-[-0.028em] md:text-[64px]">
            The page arrives.
            <br />
            The rows do not.
          </h1>
          <p className="mt-8 max-w-[35rem] text-[17px] leading-[1.65] text-ink-soft md:text-[19px]">
            An authenticated watchlist on Next.js, Vercel and Supabase Postgres.
            The shell is prerendered and on screen at once. Behind it, one
            database call holds the stream open. This is the work of finding out
            which one, and what it costs once it is fixed.
          </p>
          <div className="mt-9 flex flex-wrap gap-x-6 gap-y-3 text-[15px]">
            <Link
              href="/watchlist/before"
              data-open="before"
              className="underline underline-offset-4 hover:text-ink-soft"
            >
              Open the slow watchlist
            </Link>
            <Link
              href="/watchlist/after"
              data-open="after"
              className="text-ink-soft underline underline-offset-4 hover:text-ink"
            >
              Open the fixed one
            </Link>
          </div>
          <LiveTrace />
        </section>

        {run ? (
          <section className="border-t border-rule py-24 md:py-28">
            <h2 className="text-[26px] font-semibold tracking-[-0.02em] md:text-[30px]">
              The recorded run
            </h2>
            <p className="mt-6 max-w-[35rem] text-[16px] leading-[1.7] text-ink-soft">
              {run.metric} No averages anywhere: a mean over a long tail is the
              one number that describes nobody.
            </p>
            <table className="tnum mt-10 w-full text-left text-[15px]">
              <thead className="text-[12px] uppercase tracking-[0.1em] text-ink-faint">
                <tr>
                  <th className="pb-3 font-medium">Condition</th>
                  <th className="pb-3 text-right font-medium">n</th>
                  <th className="pb-3 text-right font-medium">p95</th>
                  <th className="pb-3 text-right font-medium">p99</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(run.conditions).map(([name, s]) => (
                  <tr key={name} className="border-t border-rule">
                    <td className="py-4 font-medium">{name}</td>
                    <td className="py-4 text-right text-ink-soft">{s.clientMs.n}</td>
                    <td className="py-4 text-right">{fmt(s.clientMs.p95)}</td>
                    <td className="py-4 text-right">{fmt(s.clientMs.p99)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-7 max-w-[35rem] text-[13.5px] leading-relaxed text-ink-faint">
              {new Date(run.at).toISOString().slice(0, 16).replace("T", " ")} UTC,
              measured from {run.from}, function in {run.functionRegion},
              database in {run.databaseRegion}. {run.loadModel} The raw values,
              the query plans and the method are in the report.
            </p>
          </section>
        ) : null}
      </main>

      <footer className="border-t border-rule">
        <div className="mx-auto flex w-full max-w-[780px] flex-wrap items-center justify-between gap-4 px-6 py-8 text-[14px] text-ink-soft md:px-8">
          <a
            className="underline underline-offset-4 hover:text-ink"
            href="https://github.com/fred1433/percentile-trace"
          >
            github.com/fred1433/percentile-trace
          </a>
          <span className="text-ink-faint">The AI Pipe</span>
        </div>
      </footer>
    </>
  );
}

const fmt = (v: number | null) => (v === null ? "-" : `${Math.round(v)} ms`);
