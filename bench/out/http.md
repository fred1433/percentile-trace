
https://percentile-trace.theaipipe.com  commit 3343305  deployment dpl_Fip4rc3LsJLEv3oMgRd9E9SYKgin
2026-09-11T13:20:11.768Z to 2026-09-11T13:33:57.520Z | function iad1 | database us-east-1 | 9 instance(s) | from Asuncion, Paraguay
3000 requests attempted, 1 failed

condition        segment        n      p95        p99        max
before           client         995         336.6      497.8     4021.0
before           handler        995         113.5      144.2     3830.5
before           query          995          92.5      123.8     3815.9
before           connect        995           0.1        0.7       78.8
before           claims         995           8.6       15.1       37.3
  same result: 50 rows, first id 6, accounts 12
  first request on an instance: 4 observation(s), not a confirmed cold start

after            client         1000        256.4      360.6      432.6
after            handler        1000         28.9       35.3       66.6
after            query          1000          9.5       11.0       17.1
after            connect        1000          0.1        0.2        0.8
after            claims         1000          8.5       11.3       38.4
  same result: 50 rows, first id 6, accounts 12
  first request on an instance: 0 observation(s), not a confirmed cold start

after-noindex    client         996         311.9      422.9     4308.9
after-noindex    handler        996          87.1      128.5     4121.7
after-noindex    query          996          63.9       95.6     4102.9
after-noindex    connect        996           0.1        1.0       79.2
after-noindex    claims         996           9.0       12.7       36.8
  same result: 50 rows, first id 6, accounts 12
  first request on an instance: 4 observation(s), not a confirmed cold start
