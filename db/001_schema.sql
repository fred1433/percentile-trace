-- Percentile Trace: the measured object.
--
-- Two tables hold exactly the same rows. One has the composite index the query
-- needs, the other does not. Keeping both live is deliberate: the "before" of
-- the index fix stays reproducible forever, instead of living only in a report
-- written the day the index was created.

create schema if not exists trace;

create table if not exists trace.events_no_index (
  id           bigserial primary key,
  tenant_id    integer      not null,
  occurred_at  timestamptz  not null,
  kind         text         not null,
  amount_cents integer      not null,
  label        text         not null
);

create table if not exists trace.events_indexed (
  id           bigserial primary key,
  tenant_id    integer      not null,
  occurred_at  timestamptz  not null,
  kind         text         not null,
  amount_cents integer      not null,
  label        text         not null
);

-- The only structural difference between the two tables.
create index if not exists events_indexed_tenant_time
  on trace.events_indexed (tenant_id, occurred_at desc);

comment on table trace.events_no_index is
  'Before state: primary key only. Same rows as events_indexed.';
comment on table trace.events_indexed is
  'After state: primary key plus (tenant_id, occurred_at desc). Same rows as events_no_index.';

-- pg_stat_statements is readable only by privileged roles. The runtime role
-- reads this project''s own statements through a view owned by a role that can.
create or replace view trace.query_stats
with (security_invoker = false) as
select
  s.queryid,
  s.query,
  s.calls,
  s.total_exec_time,
  s.min_exec_time,
  s.max_exec_time,
  s.mean_exec_time,
  s.stddev_exec_time,
  s.rows,
  s.shared_blks_hit,
  s.shared_blks_read
from extensions.pg_stat_statements s
where s.query ilike '%trace.events%';

grant usage on schema trace to trace_app;
grant select on all tables in schema trace to trace_app;
alter default privileges in schema trace grant select on tables to trace_app;
