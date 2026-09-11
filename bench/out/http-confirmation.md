
https://percentile-trace.theaipipe.com  commit f73ea58  deployment dpl_BVxxhE4FJV7C5XP5Td1zGyVNC7yH
2026-09-11T13:56:48.222Z to 2026-09-11T14:00:51.989Z | function iad1 | database us-east-1 | 4 instance(s) | from Asuncion, Paraguay
900 requests attempted, 0 failed

condition        segment        n      p95        p99        max
before           client         297         397.7      732.0     1427.2
before           handler        297         112.4      191.8     1235.5
before           query          297          95.7      135.3     1221.0
before           connect        297           0.2        0.8       81.1
before           claims         297           7.9       11.2       34.3
  same result: 50 rows, first id 6, accounts 12
  first request on an instance: 3 observation(s), not a confirmed cold start

after            client         300         247.8      369.7      698.4
after            handler        300          25.4       30.3       56.5
after            query          300           8.2       11.2       16.1
after            connect        300           0.1        0.3        0.5
after            claims         300           6.5        9.1       19.7
  same result: 50 rows, first id 6, accounts 12
  first request on an instance: 0 observation(s), not a confirmed cold start

after-noindex    client         300         315.4      422.8     3813.4
after-noindex    handler        300          76.5      106.0     3611.6
after-noindex    query          300          60.6       84.4     3588.5
after-noindex    connect        300           0.1        0.1        0.9
after-noindex    claims         300           6.3        9.8       18.5
  same result: 50 rows, first id 6, accounts 12
  first request on an instance: 0 observation(s), not a confirmed cold start
