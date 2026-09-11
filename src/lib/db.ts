import postgres from "postgres";

/**
 * One client per function instance. In transaction pooling mode Supavisor hands
 * a different backend to every transaction, so prepared statements have to be
 * off: a statement prepared on one backend is not there on the next.
 */
declare global {
  // eslint-disable-next-line no-var
  var __ptSql: ReturnType<typeof postgres> | undefined;
}

function create() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return postgres(url, {
    prepare: false,
    max: 2,
    idle_timeout: 30,
    connect_timeout: 10,
    ssl: "require",
    max_lifetime: 60 * 30,
  });
}

export const sql = globalThis.__ptSql ?? (globalThis.__ptSql = create());

export const DB_REGION = process.env.PT_DB_REGION ?? "unknown";
