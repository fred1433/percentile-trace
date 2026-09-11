import { TracePanel } from "@/components/TracePanel";
import summary from "../../bench/out/summary.json";

type Percentiles = { p50: number; p95: number; p99: number };
type ArmSummary = { total: Percentiles; fn: Percentiles; db: Percentiles };
type Run = {
  at: string;
  target: string;
  from: string;
  functionRegion: string;
  databaseRegion: string;
  warm: { samples: number; arms: Record<string, ArmSummary> };
};

const run = (summary.runs as unknown as Run[])[0];

export default function Home() {
  return (
    <>
      <main className="mx-auto w-full max-w-[760px] flex-1 px-6 md:px-8">
        <section className="pt-24 pb-28 md:pt-36 md:pb-36">
          <p className="text-[13px] font-medium uppercase tracking-[0.14em] text-ink-faint">
            Percentile Trace
          </p>
          <h1 className="mt-7 text-[44px] font-semibold leading-[1.04] tracking-[-0.028em] md:text-[68px]">
            One request, taken apart.
          </h1>
          <p className="mt-8 max-w-[34rem] text-[17px] leading-[1.65] text-ink-soft md:text-[19px]">
            Browser, function, connection, query. Measured in the same request, so
            a slow page names the segment that owns it instead of inviting a guess.
          </p>
          <TracePanel />
        </section>

        {run ? (
          <section className="border-t border-rule py-24 md:py-32">
            <h2 className="text-[26px] font-semibold tracking-[-0.02em] md:text-[32px]">
              The recorded run
            </h2>
            <p className="mt-6 max-w-[34rem] text-[16px] leading-[1.7] text-ink-soft">
              End to end, warm instances, {run.warm.samples} requests per arm.
              Percentiles, because the average of a long tail is the one number that
              describes nobody.
            </p>
            <table className="tnum mt-11 w-full text-left text-[15px]">
              <thead className="text-[12.5px] uppercase tracking-[0.1em] text-ink-faint">
                <tr>
                  <th className="pb-3 font-medium">Arm</th>
                  <th className="pb-3 text-right font-medium">p50</th>
                  <th className="pb-3 text-right font-medium">p95</th>
                  <th className="pb-3 text-right font-medium">p99</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(run.warm.arms).map(([arm, s]) => (
                  <tr key={arm} className="border-t border-rule">
                    <td className="py-4 font-medium">
                      {arm === "indexed" ? "With the index" : "No index"}
                    </td>
                    <Cell v={s.total.p50} />
                    <Cell v={s.total.p95} />
                    <Cell v={s.total.p99} />
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-7 text-[13.5px] leading-relaxed text-ink-faint">
              {new Date(run.at).toISOString().slice(0, 10)}, from {run.from}, function
              in {run.functionRegion}, database in {run.databaseRegion}. Cold starts,
              SQL plans and the region comparison are in the report.
            </p>
          </section>
        ) : null}
      </main>

      <footer className="border-t border-rule">
        <div className="mx-auto flex w-full max-w-[760px] flex-wrap items-center justify-between gap-4 px-6 py-8 text-[14px] text-ink-soft md:px-8">
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

function Cell({ v }: { v: number }) {
  return <td className="py-4 text-right">{Math.round(v)} ms</td>;
}
