# Percentile Trace, report

An authenticated watchlist on Next.js 16, Vercel and Supabase Postgres. It arrives
instantly and then waits. This is what the waiting was, what it cost, and what it
costs now.

Everything below was measured against `https://percentile-trace.theaipipe.com`.
Raw values, span trees, query plans and the environment they were taken in are in
`bench/out/`.

---

## 1. The numbers

### What a visitor experiences

From the click on the watchlist link to the expected rows on screen, verified as
fifty rows with the first id the request returned. Measured by Chromium
153.0.8010.12 through Playwright, a fresh browser context per observation, link
prefetch at the Next.js default. 105 observations per condition over three
windows with alternating order, 210 attempted, 0 failed. Measured from Asuncion,
Paraguay. Function in `iad1`, database in `us-east-1`, deployment
`dpl_BVxxhE4FJV7C5XP5Td1zGyVNC7yH`.

| Condition | p95 | p99 |
|---|---|---|
| Membership subquery policy | **478 ms** | **527 ms** |
| Account claim policy | **359 ms** | **401 ms** |

An earlier run of the same size, on the previous deployment, gave 479 and 577
against 352 and 479. Both runs are in `bench/out/`.

### What a dashboard would have shown

The same page entered as a full navigation rather than a click, 30 observations
per condition. Time to first byte and Largest Contentful Paint are the two
numbers most dashboards watch, and neither of them sees this.

| Condition | TTFB p95 | LCP p95 | Navigation to rows p95 |
|---|---|---|---|
| Membership subquery policy | 205 ms | 444 ms | 617 ms |
| Account claim policy | 190 ms | 420 ms | 488 ms |

The shell is prerendered, so it leaves the edge before the query is issued and
the largest paint is inside it. The rows arrive afterwards. A page can be two
thirds slower to be usable while both headline web vitals stay flat.

### What the function measures about itself

A different population, never mixed with the one above and never subtracted from
it. 1000 requests per condition after warm up, closed loop, one request in flight,
no pacing, condition order alternating across four windows. 3000 attempted, 1
failed. Nine function instances.

| Condition | Query p95 | Query p99 | Handler p95 | Handler p99 |
|---|---|---|---|---|
| Membership subquery policy | 92.5 ms | 123.8 ms | 113.5 ms | 144.2 ms |
| Account claim policy | **9.5 ms** | **11.0 ms** | **28.9 ms** | **35.3 ms** |
| Account claim policy, index removed | 63.9 ms | 95.6 ms | 87.1 ms | 128.5 ms |

Connection acquisition is 0.1 ms at p95 on a warm instance, and installing the
request claims costs 8.5 to 9.0 ms at p95 on all three. Neither moves between
conditions, which is what makes the query the only thing that changed.

### Which half of the fix did the work

The third row is the counterfactual, and it is why the conclusion is not simply
"it was the policy".

| Step | Query p95 |
|---|---|
| Membership subquery policy, index present but unused | 92.5 ms |
| Policy rewritten, index removed | 63.9 ms |
| Policy rewritten, index present | 9.5 ms |

Of the 83.1 ms removed at p95, the policy rewrite accounts for 28.6 ms and the
index for the remaining 54.5 ms. Neither alone was enough. The index was already on the table
in the first row and the plan never used it, so the index could not have helped
while the policy was there, and the policy alone would have left the page at
63.9 ms.

### Reproduced on the deployment this report describes

The 1000 sample run was taken on deployment `dpl_Fip4rc3LsJLEv3oMgRd9E9SYKgin`
(commit `3343305`). Later commits changed comments, documentation and the bench,
not the request path, and rather than assert that, a second run of 300 requests
per condition was taken on the deployment this repository now serves,
`dpl_BVxxhE4FJV7C5XP5Td1zGyVNC7yH` (commit `f73ea58`). 900 attempted, 0 failed.

| Condition | Query p95 | Query p99 |
|---|---|---|
| Membership subquery policy | 95.7 ms | 135.3 ms |
| Account claim policy | 8.2 ms | 11.2 ms |
| Account claim policy, index removed | 60.6 ms | 84.4 ms |

Full run: [`bench/out/http-confirmation.md`](bench/out/http-confirmation.md).

### The tail

`before` and `after, index removed` both have a maximum near four seconds against
a p99 near 100 ms: 989 of 995 observations land in the first bucket of the
distribution and two land above three seconds. That tail belongs to the shared
instance the free plan runs on, not to the fix. The `after` condition has no such
tail: its maximum over 1000 requests is 17.1 ms.

### First request on an instance

Four observations per slow condition, zero for `after`. They are reported as
observations and not as a percentile, and they are not called cold starts: what
was measured is that the module instance had not served a request before, which
is not the same claim. Connection acquisition on those was 79 to 103 ms against
0.1 ms warm.

---

## 2. Raw evidence

### 2.1 One request, from the browser to the statement

The response headers exactly as the deployment returned them. This is the text
the network panel renders in its timing section.

```
GET /api/trace?variant=before
HTTP/2 200
server-timing: connect;dur=132.43, claims;dur=8.40, query;dur=3242.17;desc="Membership subquery", handler;dur=3392.42
x-pt-region: iad1
x-pt-db-region: us-east-1
x-pt-first-on-instance: 1
x-pt-trace-id: gru1::z4rdm-1789134895052-06bb0ce93c11
x-vercel-id: gru1::iad1::z4rdm-1789134895052-06bb0ce93c11
x-vercel-cache: MISS
```

The same request, as the browser parsed it out of
`PerformanceResourceTiming.serverTiming` in a real Chromium:

```json
{
  "url": "/api/trace?variant=before&spans=1",
  "requestToResponseStartMs": 3411.6,
  "serverTiming": [
    { "name": "connect", "duration": 132.43, "description": "" },
    { "name": "claims",  "duration": 8.4,   "description": "" },
    { "name": "query",   "duration": 3242.17, "description": "Membership subquery" },
    { "name": "handler", "duration": 3392.42, "description": "" }
  ]
}
```

The statement that ran, carrying the same request id into the SQL:

```sql
/* pt variant=before trace=gru1::z4rdm-1789134895052-06bb0ce93c11 */
select id, account_id, symbol, event_at, event_type, price_cents
  from trace.watchlist_before
 where event_at >= $1
 order by event_at desc, id desc
 limit 50
```

And the span tree the request produced, through the OpenTelemetry points
Next.js emits plus the four spans this code adds, exported by a processor that
runs inside the function:

```
db.connect          132.49 ms   span ae9ad0e8ecf238cd  parent fe649d872496e8fe  trace d998ab04...
db.set_claims         8.45 ms   span 278a3de728cf22e8  parent af06b7ba7b5bf495  trace d998ab04...
db.query           3242.23 ms   span 161d0432d36c2ddb  parent af06b7ba7b5bf495  trace d998ab04...
db.transaction     3258.54 ms   span af06b7ba7b5bf495  parent fe649d872496e8fe  trace d998ab04...
```

Full capture: [`bench/out/evidence.txt`](bench/out/evidence.txt).

**Where the trace id is visible, checked rather than assumed.**
`bench/trace-link.mjs` ran one statement carrying a known id and read it back
from another connection at the same time.

- `pg_stat_activity` carries the comment. A request in flight can be matched to
  the statement it is waiting on.
- `pg_stat_statements` does not. It keys on the normalised parse tree, and a
  comment is not part of it, so 1472 calls collapsed into one entry whose stored
  text keeps whichever id arrived first. It identifies the statement, not the
  request. That is also why no percentile in this report comes from it: it
  exposes calls, a mean, a standard deviation and two extremes.
- Postgres logs would carry it too, but only with `log_min_duration_statement`
  set. It is not set on this project, and no log line here contains the comment.

Result: [`bench/out/trace-link.json`](bench/out/trace-link.json).

### 2.2 The plans

Replayed with the application role, with the same claims, with row level security
on. The service key is never used anywhere in this repository: it bypasses the
policy, and a measurement taken with the policy bypassed says nothing about a page
that runs with it on.

```
=== before (trace.watchlist_before) ===
Limit (actual time=77.962..77.969 rows=50 loops=1)
  Buffers: shared hit=9201
  ->  Sort (actual time=77.960..77.964 rows=50 loops=1)
        Sort Key: watchlist_before.event_at DESC, watchlist_before.id DESC
        Sort Method: top-N heapsort  Memory: 28kB
        ->  Seq Scan on watchlist_before (actual time=0.035..75.428 rows=13356 loops=1)
              Filter: ((ANY (account_id = (hashed SubPlan 1).col1)) AND (event_at >= ...))
              Rows Removed by Filter: 586644
              SubPlan 1
                ->  Index Only Scan using account_members_pkey on account_members m
Execution Time: 78.013 ms
```

The table carries `watchlist_before_account_time` on `(account_id, event_at desc)`.
The plan does not mention it. The policy predicate became a hashed SubPlan tested
per row, which no index on this table can serve.

```
=== after (trace.watchlist_after) ===
Limit (actual time=0.079..0.100 rows=50 loops=1)
  Buffers: shared hit=27
  InitPlan 1
    ->  Result (actual time=0.010..0.011 rows=1 loops=1)
  ->  Incremental Sort (actual time=0.078..0.095 rows=50 loops=1)
        ->  Index Scan using watchlist_after_account_time on watchlist_after
              Index Cond: ((account_id = (InitPlan 1).col1) AND (event_at >= ...))
Execution Time: 0.129 ms
```

```
=== after-noindex (trace.watchlist_after_noindex) ===
Limit (actual time=51.241..51.249 rows=50 loops=1)
  Buffers: shared hit=9198
  InitPlan 1 -> Result
  ->  Sort -> Seq Scan on watchlist_after_noindex
              Filter: ((event_at >= ...) AND (account_id = (InitPlan 1).col1))
              Rows Removed by Filter: 586644
Execution Time: 51.284 ms
```

Two sequential scans over the same 600 000 rows, 78.0 ms and 51.3 ms. The
difference, 26.7 ms, is the per row cost of probing the hashed SubPlan. The HTTP
population put the same gap at 28.6 ms at p95, measured a different way, on a
different day's worth of requests.

Full plans: [`bench/out/plans.txt`](bench/out/plans.txt).

### 2.3 The guard, red then green

`.github/workflows/perf-budget.yml` waits until the live deployment carries the
commit being tested, runs the isolation and same result tests, benches the
deployment, and checks `perf-budget.json`.

The budget is not a round number. It comes from the spread that was observed:
`budget = max(p99 * 1.5, p99 + 2 * (p99 - p95))`, computed by
`bench/propose-budget.mjs` from the 1000 sample run. Query p95 9.5 and p99 11.0
give 17 ms. Handler p95 28.9 and p99 35.3 give 53 ms.

Connection acquisition is reported and deliberately not guarded: it is bimodal,
a fraction of a millisecond when pooled and around a hundred when newly opened,
and a single p95 budget over the two would be either flaky or meaningless.

The guard has three outcomes, not two. A run with fewer than 100 samples, or with
more failures than the budget allows, exits inconclusive rather than green,
because a test that cannot fail is not a passing test.

What it detects: regressions covered by this scenario and this budget. It says
nothing about behaviour under concurrency, about other accounts, about other query
shapes, or about any region other than the one the deployment runs in.

**It was made to fail, on purpose, on a real regression.** The policy rewrite lives
in the database and the page points at a table, so the mistake this scenario is
most likely to suffer is pointing the fixed page at the table that still carries
the slow policy. That commit was pushed, deployed to production, benched by the
workflow and reverted.

| Run | Commit | `after` query p95 over 120 samples | Result |
|---|---|---|---|
| [34610353346](https://github.com/fred1433/percentile-trace/actions/runs/34610353346) | `a87319c` | 10.92 ms | green |
| [34610803745](https://github.com/fred1433/percentile-trace/actions/runs/34610803745) | `f24f8d1`, regression | **92.73 ms** | **red** |
| [34611333391](https://github.com/fred1433/percentile-trace/actions/runs/34611333391) | `37d30f7`, reverted | 10.36 ms | green |

All three are production deployments benched from `ubuntu-latest`, 360 requests
each, 0 failures. The red run also names the budget it broke and why:

```
OVER        after queryMs p95 92.73 ms over 120 samples, budget 17 ms
            One index scan plus the round trip from the function to the database.
            A policy that stops being index friendly, an index that gets dropped,
            a function moved away from the database: all three land here first.
OVER        after handlerMs p95 113.65 ms over 120 samples, budget 53 ms
2 budget(s) over. Failing.
```

The 17 tests ran green in all three, including the regression: isolation and
identical results are properties of the data, and the regression was a
performance one.

---

## 3. What the fix costs

The slow policy asks the database, on every read, which accounts this user belongs
to. The fast one trusts an `account_id` claim in the verified token. That moves the
authorisation decision out of the database and into whatever mints the token.

`tests/trust-boundary.test.mjs` asserts both directions, so the trade is on the
record rather than in a footnote:

- with the membership policy, a token claiming an account the user does not belong
  to returns the user's own rows and not the claimed ones;
- with the claim policy, the same token returns the claimed account's rows.

Adopting the fast policy therefore means minting `account_id` from verified
membership, in a Supabase custom access token hook or equivalent, and never
accepting it from a client. `tests/isolation.test.mjs` keeps the property that
matters either way: on all three variants, one account sees only its own rows, an
unauthenticated statement reads nothing, and the runtime role can neither write
nor turn the policy off.

## 4. What these numbers do not say

- **Same result, not merely a faster one.** `tests/same-result.test.mjs` checks
  that the three variants return the same fifty ids in the same order for the same
  caller, and that pagination agrees. A fix that returns different rows is a
  different feature.
- **No cache is doing the work.** Every response is `cache-control: no-store`, the
  API route is dynamic, and the observed `x-vercel-cache: MISS` is reported as what
  it is: a statement about one cache, not proof that every cache was cold.
- **The region was not changed.** The function runs in `iad1` and the database in
  `us-east-1` in every condition. An empty round trip from the function to the
  database measured 3.1 to 3.5 ms. No claim is made here about what moving the
  function would cost, because that was not measured.
- **Fluid Compute, as read from the project on 2026-09-11**, is on:
  `fluid: true`, `functionDefaultRegions: ["iad1"]`, `elasticConcurrencyEnabled:
  true`, `functionDefaultMemoryType: "standard"`, Node `24.x`. No claim is made
  about what it changes in CPU allocation, because that was not measured either.
- **One concurrency level.** Everything here is a closed loop with one request in
  flight. Nothing in this report describes behaviour under load.
- **One place to measure from.** From Asuncion the trip dominates what a visitor
  experiences: the fix removes 127 ms at p95 from a 479 ms total. Closer to
  `iad1` the same query time is a much larger share of a much smaller total. That
  is the reason the budget is set on segments the server measures about itself.
- **The web vitals do not see it.** Measured, not assumed: TTFB 205 against
  190 ms and LCP 444 against 420 ms at p95, while navigation to usable rows goes
  from 617 to 488 ms. The largest paint is in the prerendered shell, which left
  the edge before the query was issued.

## 5. Method

**The scenario.** One authenticated page. 600 000 watchlist events across 40
accounts, seeded from a fixed seed with deliberately uneven account sizes, from
112 505 rows on the largest to 6 640 on the smallest. The caller is one user on
account 12, which holds 13 356 rows. Three tables hold the same rows and differ
only in the policy and the index, and all three stay live, because checking out an
old commit does not restore a database state.

**The page.** The shell of `/watchlist/[variant]` is prerendered and the rows are
awaited inside a Suspense boundary, so the query sits in the middle of the stream.
That is why the symptom is a page that arrives and then waits, and why the headline
measurement starts at a click and ends at verified content.

**The path to the database.** A Postgres connection through the Supavisor
transaction pooler, opened by the function. The Supabase Data API is not used, so
there is no Data API round trip in this report. Claims are installed with
`set_config('request.jwt.claims', ..., true)` inside an explicit transaction,
which is what guarantees the claims and the select reach the same backend in
transaction pooling mode.

**The instrumentation.** OpenTelemetry, registered through `instrumentation.ts`,
with a span processor that writes each span as a JSON line and attaches it to the
request that produced it. The collector lives in `AsyncLocalStorage`, not in a
module level object, so two requests on one instance cannot write into each
other's numbers.

**The statistics.** Nearest rank on the sorted sample, p95 and p99 only. There is
no average anywhere in this repository, and `tests/stats.test.mjs` asserts that no
summary field is one. A sample too small to resolve a p99 is labelled
`p99IsMax`, and the reports say "exploratory empirical p99" rather than printing a
number with more resolution than the sample carries.

**The environment.** Recorded in `bench/out/manifest.json`: commit, deployment id,
pinned versions, function region, database version and region, planner row
estimate, index definitions, policy expressions, and what the measured caller can
actually see through the policy.

## Reproducing it

```
cp .env.example .env.local          # a Postgres URL through the pooler
npm ci
npm test                            # isolation, same result, trust boundary, statistics
npm run bench -- --target <url> --windows 4 --per-window 250
npm run bench:browser -- --target <url> --windows 3 --per-window 35
npm run bench:explain
npm run bench:evidence
npm run manifest
npm run budget
```

`db/001_schema.sql` and `db/002_seed.sql` are applied with a role that owns the
schema. The role the application runs as holds `SELECT` and `EXECUTE` and nothing
else, and row level security applies to it.
