-- 600 000 watchlist events, identical in all three tables, generated server
-- side from a fixed seed so the dataset is reproducible.
--
-- Account sizes are deliberately uneven: account_id = 1 + floor(40 * u^2.2)
-- with u uniform turns a flat draw into a skew, so the largest account holds
-- roughly a fifth of the rows and the smallest around one percent. A benchmark
-- where every account is the same size is a benchmark that cannot see a plan
-- behaving differently for a large account than for a small one.
--
-- The exact row count per account is recorded in bench/out/manifest.json, so a
-- reader can check the dataset they are looking at against the one the numbers
-- came from. Checking out an old commit does not restore a database state.

select setseed(0.20260911);

truncate trace.watchlist_before, trace.watchlist_after, trace.watchlist_after_noindex
  restart identity;
truncate trace.account_members;

insert into trace.watchlist_before (account_id, symbol, event_at, event_type, price_cents, note)
select
  1 + floor(40 * power(random(), 2.2))::int,
  (array['ARVX','BLTN','CNDR','DRFT','EQNX','FLRA','GLPH','HVNS','IONA','JRVS',
         'KLDR','LMBR','MRTH','NVLA','ORCA','PLTA','QRUM','RDNT','SVLT','TRDN',
         'UMBR','VRTA','WNDL','XYLO'])[1 + (i % 24)],
  timestamptz '2026-09-11 00:00:00+00' - ((i % 15552000) * interval '1 second'),
  (array['quote','fill','alert','note','rebalance','dividend'])[1 + (i % 6)],
  (((i::bigint * 7919) % 900000) + 100)::int,
  'watchlist event ' || i || ' captured in window ' || ((i / 500) + 1)
from generate_series(1, 600000) as g(i);

insert into trace.watchlist_after
  (id, account_id, symbol, event_at, event_type, price_cents, note)
select id, account_id, symbol, event_at, event_type, price_cents, note
  from trace.watchlist_before;

insert into trace.watchlist_after_noindex
  (id, account_id, symbol, event_at, event_type, price_cents, note)
select id, account_id, symbol, event_at, event_type, price_cents, note
  from trace.watchlist_before;

-- 40 users per account, plus the fixed user the measurements are taken as.
insert into trace.account_members (user_id, account_id)
select ('00000000-0000-4000-8000-' || lpad((a * 40 + u)::text, 12, '0'))::uuid, a + 1
from generate_series(0, 39) as a, generate_series(1, 40) as u;

insert into trace.account_members (user_id, account_id)
values ('11111111-2222-4333-8444-555555555555', 12)
on conflict do nothing;

select setval(pg_get_serial_sequence('trace.watchlist_after', 'id'),
              (select max(id) from trace.watchlist_after));
select setval(pg_get_serial_sequence('trace.watchlist_after_noindex', 'id'),
              (select max(id) from trace.watchlist_after_noindex));

analyze trace.watchlist_before;
analyze trace.watchlist_after;
analyze trace.watchlist_after_noindex;
analyze trace.account_members;
