# Issue triage — 2026-08-01

Point-in-time triage of all **122 open issues**. Every "already done" and "still broken" claim
below was verified against the working tree at `1e5fd7c`, not taken from the issue text.

Nothing has been closed, relabelled or commented on. This is the proposal.

---

## Summary

| Bucket | Count |
|---|---|
| Close — already implemented (stale) | 8 |
| Close — noise, promo, out of scope | 6 |
| Close — duplicate of another open issue | 8 |
| Rewrite — empty or misleading, unactionable as filed | 8 |
| Decline — proposed, argued against | 4 |
| Blocked elsewhere — park, don't schedule | 5 |
| Keep and work | 83 |

Net: **34 issues off the board**, from 122 to 88.

---

## 1. Close — already implemented

Verified fixed in the working tree. These are stale, not open work.

| Issue | Claim | Evidence |
|---|---|---|
| #713 | Migrate eslint/biome → oxlint/oxfmt | `oxlint.config.ts` exists; `package.json` has `oxlint`, `oxfmt`, `@apify/oxlint-config`; no eslint/biome deps remain |
| #765 | Use MCP Conformance Test Framework | `scripts/test_conformance.sh` runs `pnpm exec conformance sdk` across both protocol eras |
| #1153 | Remove dead `removeToolsByName` API | Zero occurrences in `src/` |
| #180 | Gate `add-actor` on client `tools.listChanged` | `add-actor` was deleted; it is now an inert entry in `RETIRED_SELECTOR_NAMES` (`src/const.ts:68`). The issue's subject no longer exists |
| #852 | Migrate direct actor tools to canonical `RunResponse` | `callActorGetDataset` and `buildActorResponseContent` are both gone from `src/` |
| #1016 | Normalize `required` array in published `inputSchema` | `fixZodInputSchemaRequired` is applied centrally in `getToolPublicFieldOnly` (`src/utils/tools.ts:102`) — the tools/list path, all tools |
| #733 | Missing `outputSchema` on storage/run tools | Every file declaring `TOOL_TYPE.INTERNAL` declares `outputSchema`; spot-checked `abort_actor_run.ts:37` |
| #900 (part 1) | `get-key-value-store-record` mangles binary records | Fixed — `get_key_value_store_record.ts:88` now branches on `Buffer.isBuffer` and inline-vs-link-out. **Re-verify part 2 before closing the issue** |

Knock-on: **#1064's first checkbox** (defaulted fields advertised as required in ~9 helper tools) is
covered by the same #1016 fix — remove the checkbox rather than opening PRs for it.

---

## 2. Close — noise, promo, out of scope

| Issue | Why |
|---|---|
| #634 | YellowMCP badge solicitation |
| #962 | CodeGuilds listing announcement; the author says "feel free to close it" |
| #1086 | HVTrust badge solicitation |
| #548 | Third-party product pitch (MCP Memory Gateway). Nothing to implement here — it is a separate server a user can already add |
| #756 | Unsolicited SATS-402 / Lightning wrapper proof. Bitcoin-native paid delivery is not on the payments roadmap next to x402/Skyfire |
| #546 | Automated "AgentWard" audit. The headline finding — `call-actor` can run any Store Actor — is the product, not a defect. The one real sub-point (users should know when an Actor holds full permissions) is already tracked properly by #612 and #973. Close with a short reply pointing at those two, don't leave an open "arbitrary code execution" title sitting on a public repo |

---

## 3. Close — duplicate

| Close | Keep | Why |
|---|---|---|
| #638 | #683 | Both are "completed tasks show a stale intermediate `statusMessage`". #683 carries the root cause (`progressTracker.stop()` fires before the last poll) and the fix plan; #638 only has the symptom. Note: draft PR #680 targets #638 and has not moved since 2026-04-15 — close or rebase it onto #683 |
| #709 | #744 | #744 says it outright: "#709 is the narrow `call-actor` symptom. This issue tracks the broader fix." Convert #709 to a sub-issue or close it |
| #1085 | #1052 | Same defect, same class: internal `toolTelemetry` reaching the wire because a path bypasses `extractToolTelemetry`. One boundary-level fix kills both, which is exactly what draft PR #1083 does |
| #797 | #1176 | #797's *title* says `getApifyAPIBaseUrl` is no longer needed; its own *body* says the opposite ("still needed in its current form"). #1176 is the precise, production-evidenced version of the same problem. Fold #797's "remove it once `baseUrl` is threaded through the constructor" step into #1176 |
| #773 | #941 | #773 is "decrease output tokens, look at mcp-compressor / TOON". #941 *is* the TOON program, with sub-issues and an eval gate |
| #852 | — | Also #587's Phase 2 verbatim; already shipped (§1) |
| #645 + #670 | one issue | Same defect class: a terminal-state write racing a cancellation in task execution. #670 is one specific unguarded path (402), #645 is the general race. Fix the general one and #670 is a test case |
| #1110, #1116, #1156, #1111 | one sequenced issue under #658 | Four issues rewriting the same call path, each declaring itself blocked-by or follow-up-to another. **And #1120 will rewrite that path again** for the 2026-07-28 tasks extension. Sequence them explicitly behind #1120 or land them first as one unit — do not run both programs against the same file |

**Not duplicates, but link them:** #741 (OAuth/SSO) → #1015 (Enterprise-Managed Authorization).
#1015 is the enterprise layer on top of #741; it cannot ship first.

**Umbrella hygiene:** eleven test issues (#750–#754, #766, #776, #847, #848, #907, #911, #1149,
#1169, #1173) sit at top level. Attach them all to #777 so the board shows one line, not thirteen.

---

## 4. Rewrite — unactionable as filed

Nobody can pick these up. Either write them properly or close them.

| Issue | Problem |
|---|---|
| #362 | Body is **empty** ("Telemetry - add tracking for long running tasks") |
| #367 | Body is **empty** |
| #435 | Body is **empty** |
| #436 | Body is **empty** |
| #788 | One Slack link, nothing else — and #1017 already states it "closes #788". Close it |
| #673 | Umbrella whose entire Planned section reads "_(to be designed)_". 4 months old. Either design it or fold into #666 |
| #797 | Title contradicts body (§3) |
| #1121 | Title "Output schema issue" tells a reader nothing; the body is precise and actionable. Retitle: *`storages.datasets.default` is optional in the output schema but required by the mapped signature* |

#198 (proxy country selection) is a year old, blocked on a MongoDB/API dependency that nobody has
opened, with no movement. Either open the apify-core dependency or close it.

---

## 5. Decline

Recommending against these, with the argument, so the decision is on the record.

**#747 — required `rationale` parameter on every tool.**
This adds a mandatory free-text field to every tool call, on every turn, for every user, so that
Segment can aggregate intent. It costs tokens on the input schema *and* the output, it is one more
thing the model can get wrong or omit, and it directly contradicts #666 (reduce token footprint) —
the same repo, filed by the same author. Analytics should not be paid for out of the customer's
context window. If intent signal is genuinely needed, take it from the tool-call *sequence* the
telemetry already records.

**#749 — seed context params on high-traffic tools.**
Same objection at lower intensity. If it happens, exactly one optional enum on `search-actors`,
nothing on `call-actor`, and it gets removed if the eval shows any accuracy regression.

**#902 — let agents leave Actor reviews via MCP.**
An agent that just ran an Actor rating that Actor is a ratings system with no cost to gaming it.
Commit `7142233` removed the "Runs succeeded" stat from search and details for precisely this
reason. Agent *feedback* to the developer is worth having; agent *ratings* on a public Store are
not. Redirect to #748.

**#448 — "I'm feeling lucky" prompt.**
No UX defined, no demand signal, no owner, 6 months old. Close; refile if a user asks.

---

## 6. Blocked elsewhere — park

Real, correct, and not schedulable here. Move them out of the active board and track the upstream
dependency instead.

- **#580** — needs apify-core#26549 (MCP-optimized store search response)
- **#804** — needs `pictureUrl` on `GET /v2/acts/:actorId` in apify-core
- **#997** — Apify API does not expose private Actor listing at all
- **#866** — waiting on apify-cli#1115; correct to track, nothing to do until it lands
- **#970** — waiting on Mixpanel data

---

## 7. Worth fixing — ranked

Ranked on one question: *does this make the server better for the agent on the other end?*

### Tier 1 — the server is lying to the model (fix these first)

Each of these makes an agent draw a confidently wrong conclusion. They are small.

1. **#1193** — `get-actor-log` on a missing run returns `isError: false` and an empty log. The agent
   concludes the run produced no output. `get-actor-run` gets this right on the same input.
2. **#1183** — `abort-actor-run` always says "Dataset metadata unavailable", including when the
   dataset has items. The wording claims a fetch failed; no fetch is attempted.
3. **#1176** — every client-facing Apify API URI (resource templates, server instructions, read-gate
   errors) is built from the internal egress host. On production those URIs name a host that only
   resolves inside the deployment, and the internal hostname is returned verbatim. Broken *and*
   leaky.
4. **#1052** (+#1085) — server-internal `toolTelemetry` reaches the wire on uncaught errors, because
   `CallToolResultSchema` is a loose object and the outer catch bypasses the stripper. Draft PR
   #1083 exists — finish it.
5. **#726** — cancellation returns `{}`, which has no `content` and so is not a valid
   `CallToolResult`. Still live at `src/mcp/tool_dispatch.ts:246`.
6. **#786** — `search-apify-docs` returns pinned Crawlee URLs that 404 when handed to
   `fetch-apify-docs`. This breaks the exact search→fetch workflow the server's own instructions
   tell agents to follow.
7. **#1170** — the server card and `server.json` both declare authentication unconditionally
   required, but four tools serve anonymously (verified against production in the issue). Discovery
   metadata is read *before* anyone connects; this one costs adoption silently.
8. **#1121** — `storages.datasets.default` is optional in the published output schema but required
   by the mapped signature, so generated TypeScript is wrong. Reported by an external integrator.

### Tier 1b — hosted-server safety

9. **#1067** — `get-key-value-store-record` downloads the entire record into memory *before* the
   256 KiB inline-vs-link decision. A multi-GB record OOMs the process, and on the multi-node hosted
   server that takes other sessions with it. The fix pattern already exists in
   `src/resources/api_resources.ts:216` (`maxContentLength` on the axios request) — copy it.
10. **#1004** — signed KV record links in `resources/read` are HMACs over the record key with no
    timestamp. They are bearer credentials that never expire.

### Tier 2 — what actually makes this the best MCP server

This is the part that matters for the stated goal. Ranked.

11. **#1119 — long-running Actor runs (20–60 min).** The single largest product gap on the board.
    Apify's differentiated work *is* long runs, and today an agent must poll roughly 80 times to
    babysit one, because `nextStep` always suggests `waitSecs=30` regardless of elapsed time and
    task mode isn't reliable for quiet runs. Every competing MCP server handles short calls fine;
    nobody handles this well. Fix it and it is a genuine advantage.

12. **#666 + #941 + #673 — token footprint, TOON, tool-call accuracy.** ~5,700 tokens of schema
    shipped into every conversation before the user has said anything. This is the cost every
    single user pays on every single turn, and it is the most direct lever on both price and
    accuracy. #666 needs its sub-issues actually filed; #941 has the structure. Treat as one
    program with an eval gate.

13. **#744 — standardize tool result shape.** The audit's finding is blunt: *no tool* satisfies the
    structured-content rule. Clients that read only `structuredContent` lose the LLM-facing
    next-step hints entirely. Foundational — most of Tier 1 stops recurring once this lands.

14. **#1053 — read-only lookup tools so agents stop reaching for curl.** The strongest evidence in
    the whole backlog: given both this server and a shell, agents reliably choose raw
    `curl https://api.apify.com/...`. That is a measured verdict on tool coverage. Four small
    read-only tools.

15. **#1120 — migrate the task path to the 2026-07-28 tasks extension.** The spec is final as of
    2026-07-28. Our task path is built on the 2025-11-25 *experimental* API. Being visibly behind on
    the spec is the opposite of the stated goal, and #658's dispatch work was explicitly the prep
    for doing this once instead of twice.

16. **#741 → #1015 — OAuth/SSO, then EMA.** #741 is a named organisation saying long-lived tokens
    are a blocker for approval. Atlassian, Linear, Figma, Canva and Supabase already ship EMA. This
    is the enterprise-adoption gate.

17. **#954 — `whoami`.** Trivial (`GET /v2/users/me`), and it lets a model state which account it is
    burning credits on. Cheap win, ship it.

18. **#998 — datasets and KV stores as MCP resources.** Real protocol depth (subscribe, up-to-date
    local copies) rather than more tools. Overlaps #587 Phase 4 — merge them.

19. **#612 + #973 — permission hints for full-permission Actors.** The honest half of #546, and
    trust is the thing that makes an agent willing to call `call-actor` at all.

20. **#668 — Sentry noise.** ~160K events/month, ~99% not our bugs. Real defects are invisible in
    that. Pure hygiene, high leverage.

21. **#554 — Node 20 actions in the release workflow.** The June 2 2026 deadline has passed.
    `EndBug/add-and-commit` is already gone; `DamianReeves/write-file-action@master` remains
    (`_update_release_metadata.yaml:79`). Releases still succeed today (commit `1e5fd7c` is one),
    so it is not on fire — but it is a live dependency on a deprecated runtime, and the replacement
    is one shell line.

### Tier 3 — internal quality, opportunistic

Correct, worth doing, none of it visible to a user. Take them when touching the file anyway.

Refactors: #658-cluster (§3), #675, #798, #935, #1064, #1065, #1066, #1114, #1115, #1154, #1166,
#604 (now down to one TODO in `src/payments/skyfire.ts:79`), #758, #924, #892, #1177, #1188
(PR #1190 open), #905 (PR #1101 open, stale since 2026-07-17).

Tests, all under #777: #750–#754, #766, #776 (`suite.ts` is now **3,292 lines**, up from the 2,813
quoted in the issue — this got worse, not better), #847 (nine `mcp.server.*` unit files now rebuild
the same bootstrap), #848 (PR #1137 open), #907, #911, #1149, #1169, #1173, #1189.

### Needs a decision, not a schedule

- **#1017 — Code Mode.** Large: a new Actor, a `workerd` V8 isolate, a sandbox security model.
  PRs #1123/#1124 are already probing it, and #1124 is the A/B eval. Do not commit until that eval
  reports. If it wins, it jumps to Tier 2; if it doesn't, close it.
- **#587** — Phase 2 has shipped (§1), Phase 4 overlaps #998 and #1053. Rewrite the roadmap around
  what's left or retire it.
- **#433** — package rename. Decided on Slack, unscheduled. Pick a release or close it.

---

## Suggested order

1. Close §1, §2, §3, §5 — 26 issues, no code.
2. Rewrite or close §4 — 8 issues, no code.
3. Tier 1 + 1b — ten small fixes, each a day or less. Biggest correctness gain per hour on the board.
4. #1119 and the #666/#941/#673 program in parallel — one product, one cost.
5. #744, then #1120.
