/**
 * Percentiles, nearest rank, on the sorted sample. No interpolation and no
 * average anywhere in this file: p95 is the value of a real request that
 * happened, which is the only thing a budget can be argued about later.
 *
 * With n samples, the p-th percentile is the ceil(p/100 * n)-th value.
 * That means p99 of 50 samples is the slowest of the 50, and the script says
 * so rather than printing a number that pretends to more resolution than it has.
 */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

/** The smallest n for which the p-th percentile is not just the maximum. */
export function resolvedAt(p) {
  return Math.ceil(100 / (100 - p)) + 1;
}

export function summarise(values) {
  return {
    n: values.length,
    min: values.length ? Math.min(...values) : null,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: values.length ? Math.max(...values) : null,
    p99IsMax: values.length < resolvedAt(99),
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
