# percentile-trace

A watchlist page that arrives instantly and then waits, measured, fixed, and
measured again. It runs at **https://percentile-trace.theaipipe.com**. The raw
values, the span trees, the query plans and the environment they were taken in
are in [`bench/out/`](bench/out); the full write up is in [REPORT.md](REPORT.md).

## The symptom

Next.js 16 App Router with Cache Components, Node runtime, Vercel functions in
`iad1`, Supabase Postgres in `us-east-1`, row level security per account. The
shell of `/watchlist` is prerendered, so a visitor sees a complete layout at once
and then a gap where their rows should be. Nothing is broken: the response is a
200, no error is logged, and the headline web vitals stay flat, because the
largest paint is in the shell that arrived before the query was even issued.

## What the measurement says

Every request carries what it spent as `Server-Timing` and as OpenTelemetry spans,
and the Vercel request id travels into the SQL as a comment. 1000 requests per
condition after warm up, from Asuncion, function in `iad1`, database in
`us-east-1`, p95 and p99 only:

| Condition | Query p95 | Query p99 | Handler p95 |
|---|---|---|---|
| Membership subquery policy | 92.5 ms | 123.8 ms | 113.5 ms |
| Account claim policy | **9.5 ms** | **11.0 ms** | **28.9 ms** |
| Account claim policy, index removed | 63.9 ms | 95.6 ms | 87.1 ms |

The query owns it. Connection acquisition is 0.1 ms warm and installing the
request claims costs 8.5 ms, and neither moves between conditions.
`EXPLAIN (ANALYZE, BUFFERS)`, replayed as the application role with the same
claims and the policy on, shows a sequential scan over 600 000 rows with 586 644
removed by the filter, on a table that already carries the index the query needs.

## The fix, and which half of it did the work

The policy looked up the caller's accounts through a subquery over another table.
Postgres turned that into a hashed SubPlan tested per row, which no index on the
scanned table can serve. Rewriting it as an equality against the account claim in
the verified token makes it an InitPlan computed once, and the index becomes
reachable.

The third row above is the counterfactual, and it is why the conclusion is not
"it was the policy". Of the 83.1 ms removed at p95, the policy rewrite accounts
for 28.6 ms and the index for the remaining 54.5 ms. Neither alone was enough, and the index
could not have helped while the policy was there.

What a visitor gets, measured from the click to verified rows on screen by a real
Chromium, 105 observations per condition: p95 from 478 ms to 359 ms, p99 from
527 ms to 401 ms. From Asuncion the trip dominates; closer to `iad1` the same
83 ms is a far larger share of a far smaller total. Time to first byte and
Largest Contentful Paint barely move at all, 205 to 190 ms and 444 to 420 ms at
p95, because the largest paint is in the shell that left the edge before the
query was issued.

The fix moves the authorisation decision from the database to whatever mints the
token. [`tests/trust-boundary.test.mjs`](tests/trust-boundary.test.mjs) asserts
that in both directions, so nobody adopts it without minting `account_id` from
verified membership.

## The proof you can open

- [REPORT.md](REPORT.md): the tables first, then the raw evidence, then the method.
- [`bench/out/http.json`](bench/out/http.json) and the `http-raw-*.jsonl` next to
  it: every observation, not a summary.
- [`bench/out/plans.txt`](bench/out/plans.txt),
  [`bench/out/evidence.txt`](bench/out/evidence.txt),
  [`bench/out/trace-link.json`](bench/out/trace-link.json),
  [`bench/out/manifest.json`](bench/out/manifest.json).
- `npm test`: seventeen checks covering isolation, identical results, the trust
  boundary and the statistics.
- [`.github/workflows/perf-budget.yml`](.github/workflows/perf-budget.yml): waits
  for the deployment carrying the commit, benches it, and fails against
  [`perf-budget.json`](perf-budget.json), whose margins come from the observed
  spread rather than from a round number. It was made to fail on a real
  regression and then pass again: runs
  [34610353346](https://github.com/fred1433/percentile-trace/actions/runs/34610353346)
  green, [34610803745](https://github.com/fred1433/percentile-trace/actions/runs/34610803745)
  red at 92.73 ms against a 17 ms budget, and
  [34611333391](https://github.com/fred1433/percentile-trace/actions/runs/34611333391)
  green again.

## Where the line is

- One scenario, one concurrency level, one place measured from. Nothing here
  describes behaviour under load.
- The region was not changed in any condition, and no claim is made about what
  moving the function would cost or about what Fluid Compute changes in CPU
  allocation. Neither was measured.
- The three tables stay live on purpose. Checking out an old commit does not
  restore a database state, so the before and the after sit side by side instead.
- The dataset is synthetic, seeded from a fixed seed, with deliberately uneven
  account sizes. It belongs to nobody.

## Running it

```
cp .env.example .env.local
npm ci
npm test
npm run bench -- --target https://percentile-trace.theaipipe.com --windows 4 --per-window 250
npm run budget
```

`db/001_schema.sql` and `db/002_seed.sql` are applied with a role that owns the
schema. The role the application runs as holds `SELECT` and `EXECUTE` and nothing
else, and row level security applies to it. The service key is never used here: it
bypasses the policy, and a measurement taken with the policy bypassed says nothing
about a page that runs with it on.

MIT licensed.
