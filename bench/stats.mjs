/**
 * Percentiles, nearest rank, on the sorted sample.
 *
 * There is no average anywhere in this repository, on purpose. A mean over a
 * long tailed latency distribution is the one number that describes nobody:
 * it moves when the tail moves and it moves when the floor moves, and it never
 * says which. p95 and p99 are values of requests that actually happened, so a
 * budget written against them can be argued about later.
 *
 * With n samples the p-th percentile is the ceil(p/100 * n)-th value. p99 of
 * 50 samples is therefore just the slowest of the 50, and the summary says so
 * in `p99IsMax` rather than printing a number with more resolution than the
 * sample can carry.
 */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

/** The smallest sample size at which the p-th percentile is not simply the maximum. */
export function resolvedAt(p) {
  return Math.ceil(100 / (100 - p)) + 1;
}

export function summarise(values) {
  return {
    n: values.length,
    min: values.length ? Math.min(...values) : null,
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: values.length ? Math.max(...values) : null,
    p99IsMax: values.length > 0 && values.length < resolvedAt(99),
  };
}

export function round(n, digits = 2) {
  if (n === null || n === undefined) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function roundAll(s, digits = 2) {
  return Object.fromEntries(
    Object.entries(s).map(([k, v]) =>
      typeof v === "number" ? [k, round(v, digits)] : [k, v],
    ),
  );
}
