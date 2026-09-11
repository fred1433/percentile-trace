import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function loadEnv() {
  const path = join(root, ".env.local");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

loadEnv();

export const DB_URL = process.env.DATABASE_URL_SESSION ?? process.env.DATABASE_URL ?? null;

export const TABLES = {
  before: "watchlist_before",
  after: "watchlist_after",
  "after-noindex": "watchlist_after_noindex",
};

export const MEMBER_OF_12 = "11111111-2222-4333-8444-555555555555";
/** A real member of account 5, from the seed: user index (4 * 40 + 1). */
export const MEMBER_OF_5 = "00000000-0000-4000-8000-000000000161";

export function connect() {
  if (!DB_URL) throw new Error("DATABASE_URL_SESSION is not set");
  return postgres(DB_URL, { prepare: false, max: 1, ssl: "require", idle_timeout: 5 });
}

/** Reads a variant exactly as the application does: same role, same claims, same statement. */
export async function readAs(sql, variant, claims, { days = 30, limit = 50 } = {}) {
  const from = new Date(Date.UTC(2026, 8, 11) - days * 86_400_000);
  return sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
    return tx.unsafe(
      `select id, account_id, symbol, event_at, event_type, price_cents
         from trace.${TABLES[variant]}
        where event_at >= $1
        order by event_at desc, id desc
        limit ${limit}`,
      [from],
    );
  });
}
