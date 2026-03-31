# Benchmark results — mcp-native (claude-opus-4-6)

**Date:** 2026-03-31
**Session:** 10223c3d-7644-4448-8d8e-7788d93ad254
**Scenarios run:** 6

| scenario | ctx_start | ctx_delta | cache_write | cache_read | total | cost | dur | success |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| _baseline | - | - | 0 | 0 | 0 | - | 0s | - |
| search_actor | 21972 | +4080 | 7487 | 89630 | 97414 | $0.296741 | 14s | true |
| get_actor_details | 26514 | +1431 | 2569 | 107038 | 110096 | $0.245041 | 17s | true |
| run_actor | 28469 | +2199 | 4566 | 174408 | 179420 | $0.380074 | 21s | true |
| compare_actors | 31029 | +975 | 2672 | 123390 | 126537 | $0.27057 | 10s | true |
| lead_gen | 32589 | +18440 | 31083 | 142530 | 174173 | $0.838361 | 29s | true |
| ecommerce_scrape | 51599 | +6207 | 12410 | 206603 | 219394 | $0.570927 | 29s | true |
| **TOTAL** | - | - | 60787 | 843599 | 907034 | $2.601714 | 120s | |
