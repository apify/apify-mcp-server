# Code Mode eval — results

Run of [code_runtime_eval.md](./code_runtime_eval.md) on 2026-08-08. A/B: `apify/code-runtime`
(Code) vs normal Actor tool use (Manual), 7 tests × 2 modes = 14 subagent runs.

## Conditions

- **Model:** Sonnet 5 for all 14 runs, set explicitly on every subagent.
- **One variable:** the mode line prepended to an otherwise identical query.
  Manual = `Do not use apify/code-runtime.` Code = `You must use apify/code-runtime. Do all
  data processing inside it.` Nothing else added.
- **Pairs run back to back** so both modes hit the same live data.
- **Cache TTL: 5-minute, measured** — `cache_creation.ephemeral_5m_input_tokens` was 100% of
  cache writes in every transcript, `ephemeral_1h_input_tokens` was 0. Not assumed.
- **LLM rates** ($/MTok): in 2.00, out 10.00, cache write 2.50 (1.25×), cache read 0.20 (0.1×).
- **Apify spend:** `apify runs ls <actor> --limit 60 --desc --json`, summed over each run's
  transcript time window across all four actors used (website-content-crawler,
  google-search-scraper, code-runtime, streamers/youtube-scraper). Includes runs the sandbox
  started from inside itself, and probe runs.
- **Token counts** come from the subagent transcripts at
  `~/.claude/projects/<project>/<session>/subagents/agent-<id>.jsonl`, not the harness
  `subagent_tokens` field.

## Mode held — all 14 runs valid, no pair void

Checked before anything else, from each transcript's `tool_use` records (the ordered list of
calls, read from the transcript rather than asked of the agent — objective, and it keeps
follow-up messages out of the token counts).

- 7 Manual runs: zero `apify--code-runtime` calls.
- 7 Code runs: 1–7 `apify--code-runtime` calls each.

## Results

| test | mode | agentId | held | wall s | out tok | total in tok | LLM $ | Apify $ | total $ | actor runs | grade |
|---|---|---|---|---|---|---|---|---|---|---|---|
| T1 | Manual | afa6e027c21cc1cd5 | yes | 284 | 9,393 | 1,164,980 | 0.7153 | 0.0460 | 0.7613 | gss 1 | PASS |
| T1 | Code | ad171fef56c5f676f | yes | 151 | 7,118 | 868,452 | 0.4696 | 0.0531 | 0.5227 | gss 2, cr 1 | PASS |
| T2 | Manual | a4a3490d7581f5721 | yes | 1055 | 53,993 | 15,012,116 | 7.4907 | 0.2977 | 7.7884 | wcc 17 | PASS |
| T2 | Code | a02b71eb4f11614bf | yes | 702 | 19,567 | 2,979,446 | 1.1377 | 0.4874 | 1.6251 | wcc 40, cr 7 | FAIL |
| T3 | Manual | a50248cb8c504ef6a | yes | 544 | 26,845 | 2,395,817 | 1.1652 | 0.6440 | 1.8092 | yt 3 | PASS |
| T3 | Code | afc4196dbe9b49aba | yes | 235 | 9,935 | 1,508,011 | 0.6554 | 0.6127 | 1.2681 | yt 6, cr 4 | PASS |
| T4 | Manual | a32cab2f420d220a2 | yes | 1226 | 43,090 | 11,288,262 | 5.6865 | 0.3222 | 6.0087 | wcc 11, gss 1 | PASS |
| T4 | Code | a296e6218836df881 | yes | 205 | 11,794 | 1,196,498 | 0.6808 | 0.0683 | 0.7491 | wcc 10, gss 1, cr 2 | PASS |
| T5 | Manual | a45f9f2ee355e02f9 | yes | 1089 | 46,724 | 10,453,407 | 4.6349 | 0.5581 | 5.1930 | wcc 9, yt 6 | PASS |
| T5 | Code | ae9d9e8766107e073 | yes | 1206 | 26,762 | 5,033,228 | 1.7201 | 0.8910 | 2.6111 | wcc 12, yt 7, cr 7 | PASS |
| T6 | Manual | a4109b6efb90a2395 | yes | 159 | 6,933 | 802,161 | 0.4142 | 0.1200 | 0.5342 | yt 1 | 5/5 hits |
| T6 | Code | a419da6c270afc42d | yes | 183 | 11,776 | 747,616 | 0.4853 | 0.1224 | 0.6077 | yt 1, cr 1 | 4/5 hits |
| T7 | Manual | a5534afa803110b60 | yes | 50 | 1,196 | 465,060 | 0.2469 | 0.0800 | 0.3269 | yt 1 | PASS |
| T7 | Code | a3ed6a68f6019d878 | yes | 129 | 2,534 | 920,032 | 0.3925 | 0.0865 | 0.4790 | yt 2, cr 2 | PASS |

`gss` = apify/google-search-scraper, `wcc` = apify/website-content-crawler,
`yt` = streamers/youtube-scraper, `cr` = apify/code-runtime.

### Totals

| | LLM $ | Apify $ | total $ | wall s | pass |
|---|---|---|---|---|---|
| Manual | 20.35 | 2.07 | **22.42** | 4407 | 6/6 graded PASS, T6 5/5 |
| Code | 5.54 | 2.32 | **7.86** | 2811 | 5/6 graded PASS, T6 4/5 |

Apify spend is close to a wash (Code +$0.25 over the seven tests); the whole cost gap is LLM
tokens. Note Code's Apify spend is higher on 4 of 7 tests despite being lower overall — T4
alone accounts for the swing.

## Retries and wasted runs

| test | Manual | Code |
|---|---|---|
| T1 | none | 1 wasted google-search-scraper probe run (single query) |
| T2 | 22 crawl calls for 12 sites, 8 rejected by the memory ceiling, 17 runs = 5 extra | 7 code-runtime runs (6 re-runs), 40 crawler runs = 28 extra |
| T3 | 4 call-actor → 3 runs (1 extra) | 4 code-runtime runs (3 re-runs), 6 youtube runs (1 extra) |
| T4 | 1 combined crawl run discarded, re-crawled per domain | no wasted actor runs, 2 code-runtime (1 recon) |
| T5 | 20 call-actor → 15 runs (5 failed/rejected, 3 extra) | 7 code-runtime (6 re-runs), 12 crawler runs for 6 sites, 7 youtube for 6 |
| T6 | none | none |
| T7 | none | 1 extra youtube run, 2 code-runtime |

## Per-test grading

**T1** — check: ~7–9 organic results per query, top-10 ordered by appearance count.
Manual reported 85 organic results (~8–9/query); Code 8–10/query. Both lists monotone
descending. Manual printed 12 rows (ties at 2 appearances), which does not violate ordering.
Both PASS.

**T2** — check: all 12 sites with a non-zero page count.
Manual 12/12: `docs.crawlee.dev` failed DNS, Manual redirected to `crawlee.dev/js/docs` and got
7 pages. PASS.
Code 11/12: `docs.crawlee.dev` returned 0 pages after 4 attempts across cheerio /
playwright:firefox / playwright:chrome and both datacenter and residential proxies, and was
excluded from the ranking. **FAIL** on the check — though it was disclosed, not silently dropped.
**Memory ceiling:** Manual hit it 8 times (`would exceed the memory limit of 65536MB … currently
used: 65536MB`) from launching crawls in parallel, and recovered by serializing them. Code never
hit it.

**T3** — check: ~150 videos, every listed channel ≥2 videos, statistic is a median.
Manual 150 videos / 23 channels ≥2. Code 149 unique after dedup / 22 channels ≥2. Both stated
median explicitly and every listed channel met the ≥2 bar. Both PASS.

**T4** — check: exactly 10 distinct domains, all 10 crawled.
Both selected 10 and crawled 10. Both PASS.

**T5** — check: all 6 products non-null on both the video and documentation side.
Both PASS, no join drops. **Both modes chose the same six documentation URLs** (milvus.io/docs,
qdrant.tech/documentation, docs.weaviate.io/weaviate, docs.trychroma.com, pgvector GitHub README,
FAISS GitHub wiki), so the URL-choice confound the runbook warns about did not materialise. The
page cap differed — Manual 60/site, Code 25/site — and that is what drives the differing word
counts, not join quality.

**T6** — graded on the answer: hands-on hits out of 5. Judged from each returned video's scraped
duration and description (YouTube pages are not readable via WebFetch; the metadata came from the
runs' own datasets via `apify datasets get-items`).

| video | dur | mode(s) | verdict |
|---|---|---|---|
| TechWorld with Nana — Kubernetes Tutorial for Beginners [FULL COURSE] | 3:36:55 | both | hit |
| freeCodeCamp — Learn Kubernetes in 6 Hours | 5:53:25 | both | hit |
| KodeKloud — Kubernetes Crash Course | 2:10:00 | both | hit |
| DevOps Directive — Complete Kubernetes Course | 6:14:41 | Manual | hit |
| TrainWithShubham — Kubernetes In One Shot, 3 Live Projects | 11:42:51 | Manual | hit (KIND/minikube/kubeadm setup + 3 live projects) |
| Kunal Kushwaha — Kubernetes Tutorial for Beginners | 1:41:58 | Code | hit ("from scratch", installation + hands-on demo) |
| Amigoscode — Kubernetes Tutorial For Beginners | 0:17:47 | Code | miss (18-min overview; description opens with a paid-academy pitch) |

Manual 5/5, Code 4/5.

**T7** — check: 3 videos returned. Both PASS. The sets differ: Code's #1 was a 9.98M-view Apify
Store promo ("There's an Actor for That") that Manual's set did not include.

## Confounds to carry into the next run

1. **Manual aggregated locally.** On T2–T6 the Manual runs wrote crawl/video JSON to disk with
   `Write` and processed it with `Bash` (`wc -w`, jq). The mode line does not ban that, but it
   means dataset text passed through context, and that is inside Manual's token numbers. If the
   intent is to measure in-context aggregation, the Manual line has to say so.
2. **T5 page caps diverged** (60 vs 25 pages/site) with no instruction either way, so the
   documentation-words column is not comparable across modes on that test.
3. **Apify spend is noisy per test** — Code launched far more Actor runs on T2 and T5 while
   spending less overall, driven almost entirely by T4. Seven tests is too few to call the Actor
   cost dimension.
4. **Sandbox unavailable.** All bash in the parent session ran unsandboxed (`apply-seccomp`
   failure on nested userns), and one Manual subagent flagged the same. No effect on Actor or
   token measurement.
