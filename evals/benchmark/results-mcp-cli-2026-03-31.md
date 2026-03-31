# Benchmark results — mcp-cli (claude-opus-4-6)

**Date:** 2026-03-31
**Session:** 03055703-3991-40e7-bf77-c91dda8c04f3
**Scenarios run:** 6

| scenario | ctx_start | ctx_delta | cache_write | cache_read | total | cost | dur | success |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| _baseline | - | - | 0 | 0 | 0 | - | 0s | - |
| search_actor | 34157 | +2278 | 4531 | 136857 | 141841 | $0.323977 | 49s | true |
| get_actor_details | 36783 | +2998 | 4811 | 336968 | 342971 | $0.684518 | 33s | true |
| run_actor | 40345 | +1829 | 3262 | 203072 | 206972 | $0.41332 | 26s | true |
| compare_actors | 42570 | +9890 | 20216 | 169840 | 190726 | $0.68382 | 15s | true |
| lead_gen | 53204 | +12346 | 24900 | 159401 | 184842 | $0.746371 | 37s | true |
| ecommerce_scrape | 66170 | +7403 | 14547 | 265429 | 280520 | $0.71146 | 21s | true |
| **TOTAL** | - | - | 72267 | 1271567 | 1347872 | $3.563466 | 181s | |
