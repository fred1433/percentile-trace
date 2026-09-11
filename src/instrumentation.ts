import { registerOTel } from "@vercel/otel";
import { LocalJsonSpanProcessor } from "@/lib/observation";

/**
 * Turns on the OpenTelemetry points Next.js already emits and sends them to a
 * processor that lives in this process. Nothing leaves the function: each span
 * is attached to the request that produced it and printed as a JSON line.
 */
export function register() {
  registerOTel({
    serviceName: "percentile-trace",
    spanProcessors: [new LocalJsonSpanProcessor()],
  });
}
