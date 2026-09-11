import { AsyncLocalStorage } from "node:async_hooks";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { context, trace, type Span } from "@opentelemetry/api";

/**
 * One observation is one request, with every span it produced attached to it.
 *
 * There is no global mutable timer anywhere in this file: the collector lives
 * in AsyncLocalStorage, so two requests handled by the same instance at the
 * same time cannot write into each other's numbers.
 */
export type SpanRecord = {
  name: string;
  spanId: string;
  parentSpanId: string | null;
  traceId: string;
  startedAtMs: number;
  durationMs: number;
  attributes: Record<string, unknown>;
  status?: string;
};

type Collector = { spans: SpanRecord[] };

/**
 * Next.js bundles instrumentation.ts and the route handlers into separate
 * chunks, so a module level AsyncLocalStorage would give the span processor one
 * store and the handler another, and every request would report zero spans.
 * One instance, held on globalThis, is what makes the two halves the same
 * request.
 */
declare global {
  // eslint-disable-next-line no-var
  var __ptStore: AsyncLocalStorage<Collector> | undefined;
}

const store =
  globalThis.__ptStore ??
  (globalThis.__ptStore = new AsyncLocalStorage<Collector>());

export function withObservation<T>(fn: (c: Collector) => Promise<T>): Promise<T> {
  const collector: Collector = { spans: [] };
  return store.run(collector, () => fn(collector));
}

export function currentCollector() {
  return store.getStore();
}

const hr = (t: [number, number]) => t[0] * 1e3 + t[1] / 1e6;

/**
 * The local exporter. Every span that ends is written to the request's own
 * collector, and printed as one JSON line so the same span is also in the
 * platform's runtime log for the same request id. No collector endpoint, no
 * third party, nothing to pay for.
 */
export class LocalJsonSpanProcessor implements SpanProcessor {
  onStart(): void {}

  onEnd(span: ReadableSpan): void {
    const record: SpanRecord = {
      name: span.name,
      spanId: span.spanContext().spanId,
      parentSpanId: span.parentSpanId ?? null,
      traceId: span.spanContext().traceId,
      startedAtMs: hr(span.startTime),
      durationMs: hr(span.duration),
      attributes: { ...span.attributes },
      status: span.status?.code === 2 ? "error" : undefined,
    };
    store.getStore()?.spans.push(record);
    if (process.env.PT_LOG_SPANS !== "0") {
      console.log(JSON.stringify({ pt_span: record }));
    }
  }

  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

const tracer = () => trace.getTracer("percentile-trace", "1.0.0");

/** Wraps one step in a span and returns both its value and its duration. */
export async function step<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<{ value: T; durationMs: number; spanId: string }> {
  const span = tracer().startSpan(name, { attributes });
  const started = performance.now();
  try {
    const value = await context.with(trace.setSpan(context.active(), span), () =>
      fn(span),
    );
    return {
      value,
      durationMs: performance.now() - started,
      spanId: span.spanContext().spanId,
    };
  } catch (e) {
    span.setStatus({ code: 2, message: String(e) });
    throw e;
  } finally {
    span.end();
  }
}
