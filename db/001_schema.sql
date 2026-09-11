-- The measured object: an authenticated watchlist.
--
-- Three tables hold exactly the same rows. They differ only in how a row is
-- authorised and whether the index the query needs exists:
--
--   watchlist_before          RLS policy = membership subquery,      index present
--   watchlist_after           RLS policy = account claim from token, index present
--   watchlist_after_noindex   RLS policy = account claim from token, no index
--
-- All three stay live on purpose. The "before" of a fix stays reproducible
-- instead of living only in a report written the day the fix shipped, and the
-- third table is what separates the share of the gain owed to the policy from
-- the share owed to the index. Checking out an old commit would not restore a
-- database state, so the states are kept side by side instead.
--
-- Applied with a role that owns the schema. The role the application uses at
-- runtime holds SELECT and EXECUTE and nothing else, and row level security
-- applies to it. The service key is never used anywhere in this repository:
-- it bypasses RLS, which would make every measurement here meaningless.

create schema if not exists trace;

-- How a direct Postgres connection sees the caller.
--
-- PostgREST puts the verified JWT into the GUC request.jwt.claims before it
-- runs a statement, and Supabase's auth.uid() and auth.jwt() read it back out.
-- A function holding its own connection does the same thing, inside the
-- transaction, which is what makes a policy written for Supabase measurable
-- from a Vercel function on a pooled Postgres connection.
create or replace function trace.jwt_claim(name text)
returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> name
$$;

create or replace function trace.current_user_id()
returns uuid language sql stable as $$ select trace.jwt_claim('sub')::uuid $$;

create or replace function trace.current_account_id()
returns integer language sql stable as $$ select trace.jwt_claim('account_id')::integer $$;

create table if not exists trace.account_members (
  user_id    uuid    not null,
  account_id integer not null,
  primary key (user_id, account_id)
);

create table if not exists trace.watchlist_before (
  id          bigserial primary key,
  account_id  integer      not null,
  symbol      text         not null,
  event_at    timestamptz  not null,
  event_type  text         not null,
  price_cents integer      not null,
  note        text         not null
);

create table if not exists trace.watchlist_after
  (like trace.watchlist_before including all);
create table if not exists trace.watchlist_after_noindex
  (like trace.watchlist_before including all);

create index if not exists watchlist_before_account_time
  on trace.watchlist_before (account_id, event_at desc);
create index if not exists watchlist_after_account_time
  on trace.watchlist_after (account_id, event_at desc);
-- watchlist_after_noindex gets no index. That is the point of it.

alter table trace.watchlist_before        enable row level security;
alter table trace.watchlist_after         enable row level security;
alter table trace.watchlist_after_noindex enable row level security;

-- Before. The accounts a caller may read are looked up through a subquery over
-- another table, so the predicate is not something the planner can turn into an
-- index condition on this one. Every row is read and then tested.
drop policy if exists account_read on trace.watchlist_before;
create policy account_read on trace.watchlist_before
  for select to trace_app
  using (
    account_id in (
      select m.account_id
        from trace.account_members m
       where m.user_id = trace.current_user_id()
    )
  );

-- After. The account is already in the verified token, so the policy is an
-- equality against one value computed once before the scan, and the index on
-- (account_id, event_at desc) becomes usable. The scalar subquery is what makes
-- it an InitPlan rather than a per row call.
drop policy if exists account_read on trace.watchlist_after;
create policy account_read on trace.watchlist_after
  for select to trace_app
  using (account_id = (select trace.current_account_id()));

drop policy if exists account_read on trace.watchlist_after_noindex;
create policy account_read on trace.watchlist_after_noindex
  for select to trace_app
  using (account_id = (select trace.current_account_id()));

-- pg_stat_statements is readable only by privileged roles. The runtime role
-- reads this project's own statements through a view owned by a role that can.
-- It is used to identify a statement and corroborate the work it did. It is
-- never used to produce a percentile: it exposes aggregates.
drop view if exists trace.query_stats;
create view trace.query_stats
with (security_invoker = false) as
select
  s.queryid, s.query, s.calls, s.rows,
  s.total_exec_time, s.min_exec_time, s.max_exec_time,
  s.mean_exec_time, s.stddev_exec_time,
  s.shared_blks_hit, s.shared_blks_read
from extensions.pg_stat_statements s
where s.query ilike '%trace.watchlist%';

grant usage on schema trace to trace_app;
grant select on all tables in schema trace to trace_app;
grant execute on function trace.jwt_claim(text)        to trace_app;
grant execute on function trace.current_user_id()      to trace_app;
grant execute on function trace.current_account_id()   to trace_app;
alter default privileges in schema trace grant select on tables to trace_app;
