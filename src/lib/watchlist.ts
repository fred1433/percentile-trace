import { sql } from "@/lib/db";
import { step } from "@/lib/observation";

/**
 * One scenario: an authenticated watchlist. The page shows its structure
 * immediately and the rows arrive when the database answers.
 *
 * The three variants read the same 600 000 rows and must return the same rows
 * in the same order for the same caller. What differs is how a row is
 * authorised and whether the index the query needs exists.
 *
 * The path to the database is a direct Postgres connection through the
 * Supavisor transaction pooler. The Supabase Data API is not used anywhere in
 * this repository, so there is no data_api_roundtrip to report.
 */
export const VARIANTS = {
  before: {
    table: "watchlist_before",
    policy:
      "account_id in (select account_id from account_members where user_id = auth.uid())",
    indexed: true,
    title: "Membership subquery",
  },
  after: {
    table: "watchlist_after",
    policy: "account_id = (select (auth.jwt() ->> 'account_id')::int)",
    indexed: true,
    title: "Account claim",
  },
  "after-noindex": {
    table: "watchlist_after_noindex",
    policy: "account_id = (select (auth.jwt() ->> 'account_id')::int)",
    indexed: false,
    title: "Account claim, index removed",
  },
} as const;

export type Variant = keyof typeof VARIANTS;
export const VARIANT_NAMES = Object.keys(VARIANTS) as Variant[];
export const isVariant = (v: string): v is Variant => v in VARIANTS;

/**
 * The claims PostgREST would have installed after verifying the token. A
 * function holding its own connection sets the same GUC itself, inside the
 * transaction, so the policy sees what it would see through Supabase. The
 * caller is always the same user, on account 12, for every variant.
 */
export const CALLER = {
  sub: "11111111-2222-4333-8444-555555555555",
  account_id: "12",
  role: "authenticated",
};
const CLAIMS = JSON.stringify(CALLER);

export const WINDOW_DAYS = 30;
export const PAGE_SIZE = 50;

export type Event = {
  id: string;
  account_id: number;
  symbol: string;
  event_at: string;
  event_type: string;
  price_cents: number;
};

export type Reading = {
  rows: Event[];
  connectMs: number;
  claimsMs: number;
  queryMs: number;
  traceId: string;
  statement: string;
};

/** A trace id travels into the SQL text, so it must not be able to close the comment. */
export function safeTraceId(raw: string | null | undefined) {
  const cleaned = (raw ?? "").replace(/[^A-Za-z0-9:_.-]/g, "");
  return cleaned.slice(0, 80) || "none";
}

export function since(days = WINDOW_DAYS) {
  return new Date(Date.UTC(2026, 8, 11) - days * 86_400_000);
}

export async function readWatchlist(
  variant: Variant,
  rawTraceId: string | null,
  days = WINDOW_DAYS,
): Promise<Reading> {
  const { table } = VARIANTS[variant];
  const traceId = safeTraceId(rawTraceId);
  const from = since(days);

  const statement = `/* pt variant=${variant} trace=${traceId} */
         select id, account_id, symbol, event_at, event_type, price_cents
           from trace.${table}
          where event_at >= $1
          order by event_at desc, id desc
          limit ${PAGE_SIZE}`;

  const connect = await step("db.connect", { "db.system": "postgresql" }, () =>
    sql.reserve(),
  );
  const conn = connect.value;

  try {
    // An explicit transaction, so the claims and the select are guaranteed to
    // reach the same backend. In transaction pooling mode that guarantee is the
    // whole point: a GUC set outside a transaction can land on one backend and
    // the query on another, and the policy would then read nothing.
    const inner = await step(
      "db.transaction",
      { "db.system": "postgresql", "pt.variant": variant },
      async () => {
        await conn.unsafe("begin");
        try {
          const claims = await step(
            "db.set_claims",
            { "db.statement": "select set_config('request.jwt.claims', $1, true)" },
            () => conn`select set_config('request.jwt.claims', ${CLAIMS}, true)`,
          );

          const query = await step(
            "db.query",
            {
              "db.system": "postgresql",
              "db.sql.table": `trace.${table}`,
              "pt.trace_id": traceId,
              "pt.variant": variant,
              "pt.window_days": days,
              "pt.page_size": PAGE_SIZE,
            },
            () => conn.unsafe(statement, [from]),
          );

          await conn.unsafe("commit");
          return {
            rows: query.value as unknown as Event[],
            claimsMs: claims.durationMs,
            queryMs: query.durationMs,
          };
        } catch (e) {
          await conn.unsafe("rollback").catch(() => {});
          throw e;
        }
      },
    );

    return {
      rows: inner.value.rows,
      connectMs: connect.durationMs,
      claimsMs: inner.value.claimsMs,
      queryMs: inner.value.queryMs,
      traceId,
      statement: statement.replace(/\s+/g, " ").trim(),
    };
  } finally {
    conn.release();
  }
}
