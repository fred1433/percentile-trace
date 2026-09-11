-- 600 000 rows per table, identical in both, generated server side.
-- 64 tenants, 180 days of history, so the query under test still has a few
-- thousand candidate rows to sort once the time filter has been applied.

truncate trace.events_no_index, trace.events_indexed restart identity;

insert into trace.events_no_index (tenant_id, occurred_at, kind, amount_cents, label)
select
  (i % 64) + 1,
  timestamptz '2026-09-11 00:00:00+00' - ((i % 15552000) * interval '1 second'),
  (array['charge','refund','payout','adjustment','fee','transfer'])[(i % 6) + 1],
  (((i::bigint * 7919) % 900000) + 100)::int,
  'ledger entry ' || i || ' reconciled against batch ' || ((i / 500) + 1)
from generate_series(1, 600000) as g(i);

insert into trace.events_indexed (id, tenant_id, occurred_at, kind, amount_cents, label)
select id, tenant_id, occurred_at, kind, amount_cents, label from trace.events_no_index;

select setval(pg_get_serial_sequence('trace.events_indexed', 'id'),
              (select max(id) from trace.events_indexed));

analyze trace.events_no_index;
analyze trace.events_indexed;
