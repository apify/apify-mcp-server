# Issue triage — 2026-08-01

All **122 open issues**, by category, with a reason for each. Every "already shipped" and "still
broken" claim was verified against the working tree at `1e5fd7c` — none are taken from issue text.

Nothing has been closed, relabelled or commented on. This is the proposal.

| Category | Count |
|---|---|
| [1. Close — already implemented](#1-close--already-implemented-9) | 9 |
| [2. Close — noise / out of scope](#2-close--noise--out-of-scope-6) | 6 |
| [3. Close — duplicate](#3-close--duplicate-7) | 7 |
| [4. Close — decline](#4-close--decline-4) | 4 |
| [5. Rewrite — unactionable as filed](#5-rewrite--unactionable-as-filed-5) | 5 |
| [6. Postpone — blocked outside this repo](#6-postpone--blocked-outside-this-repo-6) | 6 |
| [7. Keep — the server misleads the model](#7-keep--the-server-misleads-the-model-11) | 11 |
| [8. Keep — product](#8-keep--product-17) | 17 |
| [9. Keep — maintainability and contributor experience](#9-keep--maintainability-and-contributor-experience-22) | 22 |
| [10. Keep — test coverage](#10-keep--test-coverage-11) | 11 |
| [11. Keep — the refactor cluster](#11-keep--the-refactor-cluster-5) | 5 |
| [12. Keep — everything else](#12-keep--everything-else-18) | 18 |

**26 close, 122 → 96.**

---

## 1. Close — already implemented (9)

| Issue | Title | Reason to close |
|---|---|---|
| [#180](https://github.com/apify/apify-mcp-server/issues/180) | Client/server capability negotiations | `add-actor` was deleted in the stateless migration and is now only an inert entry in `RETIRED_SELECTOR_NAMES` (`src/const.ts:68`). There is no tool left to gate on the client's `listChanged` capability, so the issue's subject no longer exists. |
| [#447](https://github.com/apify/apify-mcp-server/issues/447) | Add logging - sent debug/info logs to MCP client | The server already declares the `logging` capability (`legacy_server.ts:141`) and forwards level-filtered messages through `setupLoggingProxy` (`:210`), with `sendLoggingMessage` in active use on the task path. Every acceptance point in the issue is met. |
| [#538](https://github.com/apify/apify-mcp-server/issues/538) | feat: capability-based widget rendering using MCP Apps client negotiation | Widget mode now resolves from the client's advertised MCP Apps capability — `isUiSupportedByClient(clientContext)` at `server.ts:251` feeds `resolveServerMode('auto', …)`, with auto-detection enabled. `ui=openai` survives only as a deprecated alias, which is exactly what the issue asked for. |
| [#713](https://github.com/apify/apify-mcp-server/issues/713) | Migrate from eslint/biome to oxlint/oxfmt | `oxlint.config.ts` is in the repo and `package.json` carries `oxlint`, `oxfmt`, `oxlint-tsgolint` and `@apify/oxlint-config`. No ESLint or Biome dependency remains. |
| [#733](https://github.com/apify/apify-mcp-server/issues/733) | Missing `outputSchema` on storage/run collection tools | All seven tools named in the issue declare `outputSchema` today — verified in `abort_actor_run.ts:37`, `get_actor_run_log`, `get_actor_run_list`, `get_dataset`, `get_dataset_schema`, `get_dataset_list` and `get_key_value_store_list`. |
| [#765](https://github.com/apify/apify-mcp-server/issues/765) | Use MCP Conformance Test Framework to verify server implementation | `pnpm run test:conformance` runs the official `@modelcontextprotocol/conformance` framework via `scripts/test_conformance.sh`, across both the `2026-07-28` and `2025-11-25` eras. CI gates both with per-era expected-failure files. |
| [#852](https://github.com/apify/apify-mcp-server/issues/852) | feat: migrate direct actor tools to canonical RunResponse shape | Direct Actor tools already return the canonical `RunResponse`, and the old execution path is gone — `callActorGetDataset` and `buildActorResponseContent` have no occurrences left in `src/`. |
| [#1016](https://github.com/apify/apify-mcp-server/issues/1016) | fix: Normalize required-array in published tool inputSchema across all tools | `fixZodInputSchemaRequired` is now applied inside `getToolPublicFieldOnly` (`src/utils/tools.ts:102`), which is the single tools/list serialization path. All tools are normalized, not just `get-actor-run` — the 1-of-19 problem the issue describes is gone. |
| [#1153](https://github.com/apify/apify-mcp-server/issues/1153) | chore: remove the dead tool-removal API after add-actor cleanup | `removeToolsByName` and its private helper have zero occurrences in `src/`. The deletion this issue asks for has already happened. |

**Knock-on:** the first checkbox of [#1064](https://github.com/apify/apify-mcp-server/issues/1064) is
covered by the same #1016 fix — tick it rather than opening PRs.

**Correction to an earlier draft:** [#900](https://github.com/apify/apify-mcp-server/issues/900) is
*not* closeable — part 1 is fixed, part 2 is still live. It stays open in §7.

---

## 2. Close — noise / out of scope (6)

| Issue | Title | Reason to close |
|---|---|---|
| [#546](https://github.com/apify/apify-mcp-server/issues/546) | [Security] AgentWard Audit: Arbitrary cloud code execution via call-actor + no actor allowlist | The headline finding — `call-actor` can run any Store Actor without an allowlist — describes the product rather than a defect; running user-chosen Actors is what the server is for. The one legitimate sub-point, surfacing Actors that hold full permissions, is already tracked properly by #612 and #973. |
| [#548](https://github.com/apify/apify-mcp-server/issues/548) | Integration: Agent memory layer — learn from past scraping failures | This is a pitch for a separate third-party MCP server that users can already run alongside this one over stdio. There is no change to make in this repo. |
| [#634](https://github.com/apify/apify-mcp-server/issues/634) | Your MCP server ranks in the top 0.1% for reliability out of 20,000+ servers | Vendor badge solicitation, not a change request against this repository. |
| [#756](https://github.com/apify/apify-mcp-server/issues/756) | Permissionless SATS-402 wrapper: Bitcoin-native paid delivery for Apify Actor results | An unsolicited third-party proof of concept built on top of the server rather than a change to it. Bitcoin-native paid delivery is not on the payments roadmap alongside x402 and Skyfire. |
| [#962](https://github.com/apify/apify-mcp-server/issues/962) | Your project is now listed on CodeGuilds | Third-party listing announcement; the author explicitly writes "feel free to close it". |
| [#1086](https://github.com/apify/apify-mcp-server/issues/1086) | Add your HVTrust badge to the README? | Vendor badge solicitation, not a change request against this repository. |

#546 deserves a short public reply before closing — an open issue titled "Arbitrary cloud code
execution" on a public repo is a cost in itself.

---

## 3. Close — duplicate (7)

| Issue | Title | Reason to close |
|---|---|---|
| [#638](https://github.com/apify/apify-mcp-server/issues/638) | tasks/list shows stale statusMessage for completed tasks | Same defect as [#683](https://github.com/apify/apify-mcp-server/issues/683) — still no final `statusMessage` written before `storeTaskResult` (`task_execution.ts:173`). #683 asks for the better end state, the Actor's real closing message rather than a generic `SUCCEEDED`, so keep that one. |
| [#670](https://github.com/apify/apify-mcp-server/issues/670) | 402 error path in executeToolAndUpdateTask missing cancellation check | The unguarded 402 path is one instance of the terminal-state-vs-cancellation race that [#645](https://github.com/apify/apify-mcp-server/issues/645) covers generally. Fix the general case and this becomes a test case under it. |
| [#709](https://github.com/apify/apify-mcp-server/issues/709) | [Bug]: `call-actor` tool result doesn't conform MCP standard | [#744](https://github.com/apify/apify-mcp-server/issues/744) says so outright: "#709 is the narrow `call-actor` symptom. This issue tracks the broader fix." The audit there found no tool is compliant, so fixing only `call-actor` would leave the same bug in ~23 others. |
| [#773](https://github.com/apify/apify-mcp-server/issues/773) | Decrease number of output tokens | "Look at mcp-compressor and TOON" is the exploratory version of [#941](https://github.com/apify/apify-mcp-server/issues/941), which is the actual TOON programme with sub-issues, a telemetry prerequisite and an eval gate already sequenced. |
| [#788](https://github.com/apify/apify-mcp-server/issues/788) | Sub-agent specification | A single Slack link with no content, superseded by [#1017](https://github.com/apify/apify-mcp-server/issues/1017), which is the finalized spec and already states "closes #788". |
| [#797](https://github.com/apify/apify-mcp-server/issues/797) | Remove getApifyAPIBaseUrl this is no longer needed | The title says the function is no longer needed while its own body says the opposite ("still needed in its current form"). [#1176](https://github.com/apify/apify-mcp-server/issues/1176) states the same problem correctly and backs it with production evidence. |
| [#1085](https://github.com/apify/apify-mcp-server/issues/1085) | fix: Standby rejection leaks internal toolTelemetry onto the wire and into stored task results | Same defect class as [#1052](https://github.com/apify/apify-mcp-server/issues/1052) — internal `toolTelemetry` reaching the wire because a path bypasses `extractToolTelemetry`. One boundary-level fix ([PR #1083](https://github.com/apify/apify-mcp-server/pull/1083)) closes both. |

---

## 4. Close — decline (4)

| Issue | Title | Reason to close |
|---|---|---|
| [#448](https://github.com/apify/apify-mcp-server/issues/448) | MCP prompts – "I'm feeling lucky" feature | No UX defined, no demand signal and no owner after six months; the issue is a title plus three bullet points restating the title. Refile if a user actually asks for it. |
| [#747](https://github.com/apify/apify-mcp-server/issues/747) | feat: Add a required `rationale` parameter to every tool | Charges every user tokens on every turn — in the input schema and again in the call — so Segment can aggregate intent, and adds one more field the model can get wrong. It directly contradicts [#666](https://github.com/apify/apify-mcp-server/issues/666) in the same repo; intent should come from the tool-call sequence telemetry already records. |
| [#749](https://github.com/apify/apify-mcp-server/issues/749) | feat: Add seed context parameters to high-traffic tools | Same objection in weaker form: analytics funded out of the customer's context window. If it happens at all, it should be one optional enum on `search-actors`, nothing on `call-actor`, and removed on any eval regression. |
| [#902](https://github.com/apify/apify-mcp-server/issues/902) | feat: Let agents leave Actor reviews via API/MCP | An agent rating the Actor it just ran is a ratings system with no cost to gaming it, and commit `7142233` removed the "Runs succeeded" stat from search and details for exactly that reason. Agent feedback *to the developer* is worth having — that is #748 — but agent ratings on a public Store are not. |

---

## 5. Rewrite — unactionable as filed (5)

| Issue | Title | Reason |
|---|---|---|
| [#362](https://github.com/apify/apify-mcp-server/issues/362) | Telemetry - add tracking for long running tasks | Body is **empty**. Nobody can pick it up — write it or close it. |
| [#367](https://github.com/apify/apify-mcp-server/issues/367) | Revisit the MCP long running task redis store - TTL and other consts | Body is **empty**. |
| [#435](https://github.com/apify/apify-mcp-server/issues/435) | LLM Evals: research possible solutions (Arize, W&B, or other) | Body is **empty**, though the work is real — evals gate #941 and #1017. |
| [#436](https://github.com/apify/apify-mcp-server/issues/436) | Experiment with the advanced tool usage (tool search and code-execution) - in Claude | Body is **empty**, and #1017 now covers the code-execution half. |
| [#673](https://github.com/apify/apify-mcp-server/issues/673) | Improve tool call accuracy | Umbrella whose entire Planned section reads "_(to be designed)_" four months on. Design it or fold it into #666. |

---

## 6. Postpone — blocked outside this repo (6)

| Issue | Title | Reason to postpone |
|---|---|---|
| [#580](https://github.com/apify/apify-mcp-server/issues/580) | Use reduced store search response for search-actors tool | Cannot start until apify-core#26549 ships the MCP-optimized store-search response. |
| [#761](https://github.com/apify/apify-mcp-server/issues/761) | feat: Serve Apify Skills through MCP Server (SEP-2640) | SEP-2640 is still an open PR against the MCP spec; building on an unmerged `skill://` convention risks a rewrite when it changes. |
| [#804](https://github.com/apify/apify-mcp-server/issues/804) | perf: Drop redundant store-search call in fetchActorDetails | Blocked on apify-core adding `pictureUrl` to `GET /v2/acts/:actorId`; the extra search call cannot go until it does. |
| [#866](https://github.com/apify/apify-mcp-server/issues/866) | Track apify-cli #1115: credential storage change will break stdio auth fallback | Correctly filed as a watch item — there is nothing to do until apify-cli#1115 lands, and then it becomes urgent. |
| [#970](https://github.com/apify/apify-mcp-server/issues/970) | Re-evaluate the binary KV-record inline size cap with Mixpanel data | The task is explicitly "decide from Mixpanel data", and that data does not exist yet. |
| [#997](https://github.com/apify/apify-mcp-server/issues/997) | [Feature]: Enable search across private Actors via MCP | The Apify API exposes no private-Actor listing at all, so the fix has to originate upstream; the MCP-side change is a parameter. |

---

## 7. Keep — the server misleads the model (11)

Best correctness-per-hour on the board. Each makes an agent draw a confidently wrong conclusion, and
each is small.

| Issue | Title | Reason to keep |
|---|---|---|
| [#1193](https://github.com/apify/apify-mcp-server/issues/1193) | fix: get-actor-log should error when run is not found | Returns `isError: false` and an empty log for a missing run, so the agent concludes the run produced no output — `get-actor-run` handles the same input correctly. |
| [#1183](https://github.com/apify/apify-mcp-server/issues/1183) | abort-actor-run summary says "Dataset metadata unavailable" even when the dataset has items | The wording implies a fetch was attempted and failed; no fetch is ever attempted. The model is told data is missing when it is there. |
| [#1176](https://github.com/apify/apify-mcp-server/issues/1176) | [Bug]: Client-facing Apify API URIs are built from the API egress host | Every client-facing Apify API URI names the internal host, so the URIs don't resolve for clients and the internal hostname is returned verbatim in production responses. |
| [#1052](https://github.com/apify/apify-mcp-server/issues/1052) | fix: Uncaught tool errors leak toolTelemetry to the wire | A server-internal field escapes on uncaught errors because the outer catch bypasses the stripper and `CallToolResultSchema` is a loose object. [PR #1083](https://github.com/apify/apify-mcp-server/pull/1083) already exists — finish it. |
| [#726](https://github.com/apify/apify-mcp-server/issues/726) | Bug: cancellation returns `{}` (missing required `content`) instead of suppressing response | `{}` has no `content` and is not a valid `CallToolResult`. Still live at `src/mcp/tool_dispatch.ts:246`. |
| [#786](https://github.com/apify/apify-mcp-server/issues/786) | search-apify-docs returns stale versioned Crawlee URLs that 404 on fetch | Breaks the exact search→fetch workflow our own server instructions tell agents to follow, so the failure lands on agents who did the right thing. |
| [#1170](https://github.com/apify/apify-mcp-server/issues/1170) | fix: server card and server.json claim authentication is always required | Declares auth unconditionally required while four tools serve anonymously. Discovery metadata is read *before* anyone connects, so this costs adoption silently. |
| [#1121](https://github.com/apify/apify-mcp-server/issues/1121) | Output schema issue | `storages.datasets.default` is optional in the published schema but required by the mapped signature, so generated TypeScript is wrong. External integrator report — **retitle it**, the current title says nothing. |
| [#900](https://github.com/apify/apify-mcp-server/issues/900) | fix: Storage tools surface misleading content for edge cases | Part 2 is still live at `get_dataset_schema.ts:72`: reports "Dataset is empty" when the default `clean=true` filtered everything out, so the caller stops investigating. **Narrow to part 2** — part 1 is fixed. |
| [#1067](https://github.com/apify/apify-mcp-server/issues/1067) | get-key-value-store-record buffers the whole record in memory before the size check | A multi-GB record OOMs the process before the 256 KiB decision runs, and on the multi-node hosted server that takes other sessions with it. The fix pattern is 40 lines away at `api_resources.ts:216`. |
| [#1004](https://github.com/apify/apify-mcp-server/issues/1004) | Signed key-value-store record links in resources/read never expire | The links are HMACs over the record key with no timestamp — bearer credentials valid until the store's signing secret rotates, i.e. never. |

---

## 8. Keep — product (17)

| Issue | Title | Reason to keep |
|---|---|---|
| [#1119](https://github.com/apify/apify-mcp-server/issues/1119) | [spec] Long-running Actor runs (20–60 min): poll guidance + reliable Task-mode fire-and-collect | The largest product gap here. Apify's differentiated work *is* 20–60 minute runs, and today an agent polls ~80 times to babysit one. Every MCP server handles short calls; nobody handles this well. |
| [#666](https://github.com/apify/apify-mcp-server/issues/666) | Reduce MCP server token footprint (tracking) | ~5,700 tokens of schema shipped into every conversation before the user says anything — the cost every user pays every turn, and the most direct lever on both price and accuracy. |
| [#941](https://github.com/apify/apify-mcp-server/issues/941) | TOON format adoption: measure, validate, ship, tell the story | The output-side half of the same lever, and the only one of the three with sub-issues, a telemetry prerequisite and an eval gate already structured. |
| [#744](https://github.com/apify/apify-mcp-server/issues/744) | refactor: Standardize tool result shape for MCP spec conformance | The audit is blunt — *no* tool satisfies the structured-content rule — and clients reading only `structuredContent` lose the next-step hints entirely. Most of §7 stops recurring once this lands. |
| [#1053](https://github.com/apify/apify-mcp-server/issues/1053) | feat(tools): add read-only lookup tools so agents stop reaching for raw curl | The strongest evidence in the backlog: given both this server and a shell, agents reliably choose raw `curl`. That is a measured verdict on tool coverage, and the fix is four small read-only tools. |
| [#1120](https://github.com/apify/apify-mcp-server/issues/1120) | [spec] Migrate the task path to the 2026-07-28 tasks extension | The spec went final on 2026-07-28 and our task path still runs on the 2025-11-25 *experimental* API. Being visibly behind on the spec is the opposite of the goal. |
| [#741](https://github.com/apify/apify-mcp-server/issues/741) | OAuth / SSO support for MCP server authentication | A named organisation calls long-lived tokens a blocker for approval. This is the enterprise adoption gate. |
| [#1015](https://github.com/apify/apify-mcp-server/issues/1015) | [Feature]: Support MCP Enterprise-Managed Authorization (EMA) extension | Atlassian, Linear, Figma and Supabase already ship it. Worth doing, but it is the layer *on top of* #741 and cannot go first. |
| [#954](https://github.com/apify/apify-mcp-server/issues/954) | Add a `whoami` tool to the Apify MCP server | One endpoint (`GET /v2/users/me`) and the model can state which account it is spending. Cheapest agent-UX win on the list. |
| [#998](https://github.com/apify/apify-mcp-server/issues/998) | [Feature]: Expose datasets and key-value stores as MCP resources | Real protocol depth — subscribe, live local copies — instead of more tools. Merge with #587 Phase 4 and #1053. |
| [#612](https://github.com/apify/apify-mcp-server/issues/612) | feat: Add hint for full-permissions Actors | Trust is what makes an agent willing to call `call-actor` at all, and this is the honest half of #546. |
| [#973](https://github.com/apify/apify-mcp-server/issues/973) | [Feature]: Flag directly added public Actors with limited permissions with non-destructive hint | The inverse of #612 — removing the scary hint where it is provably wrong keeps the remaining hints credible. |
| [#184](https://github.com/apify/apify-mcp-server/issues/184) | Add support for exposing a subset of input schema attributes | Actor input schemas are the largest token sink after tool descriptions, making this #666's biggest single line item. Sequence it with that programme. |
| [#337](https://github.com/apify/apify-mcp-server/issues/337) | Revisit errors returned: Protocol Errors vs Tool Execution Errors | "Tool execution failed" for an out-of-range `limit` gives the model nothing to correct. Good error text is the cheapest accuracy fix available. |
| [#704](https://github.com/apify/apify-mcp-server/issues/704) | [Feature]: Use `io.modelcontextprotocol/model-immediate-response` to pass Actor run info for tasks | Gives the model run ID and status the instant a task starts instead of after the first poll, directly reducing the polling burden #1119 is about. |
| [#1017](https://github.com/apify/apify-mcp-server/issues/1017) | feat: Code Mode — experimental run-code + get-code-docs tools | Potentially the biggest differentiator here, but it is a new Actor plus a `workerd` sandbox. **Hold until [PR #1124](https://github.com/apify/apify-mcp-server/pull/1124)'s A/B eval reports**, then promote or close. |
| [#587](https://github.com/apify/apify-mcp-server/issues/587) | feat: Post-#582 roadmap | Phase 2 has shipped and Phase 4 overlaps #998/#1053, so as filed it overstates the remaining work. **Rewrite around what's left or retire it.** |

---

## 9. Keep — maintainability and contributor experience (22)

External contribution is already real: **seven of the fifteen open PRs are from outside the team**
(#1186, #1185, #1181, #1083, #1079, #1054, #1048). Ranked on: *how much does this change what a
first-time contributor experiences?*

**What already works:** `CONTRIBUTING.md` is a real 364-line standards document; seven `AGENTS.md`
files give per-directory context with `pnpm run check:agents` keeping the link tree honest; a PR
template exists; `src/mcp/server.ts` is down to **577 lines** because the #658 dispatch work largely
landed. The rows below are where that foundation leaks.

| Issue | Title | Reason to keep |
|---|---|---|
| [#1065](https://github.com/apify/apify-mcp-server/issues/1065) | refactor: defineHelperTool factory + shared test helpers | Highest-leverage item here. Adding a tool means hand-repeating `z.toJSONSchema()` twice, `title` twice, a 4-line annotations block copied verbatim in ~15 tools and the `Object.freeze` envelope — ~250 lines of boilerplate, so a newcomer copies whichever tool they opened first and inherits its drift. |
| [#776](https://github.com/apify/apify-mcp-server/issues/776) | refactor: Split integration suite.ts into per-capability files | **Now 3,292 lines, up from the 2,813 the issue quotes** — it got worse since filing, and reviewers are already blocking test additions on it. |
| [#935](https://github.com/apify/apify-mcp-server/issues/935) | refactor: Tool response contract via respond* constructors (Option F) | Telemetry classification is opt-in today: a handler can return `isError: true`, forget the telemetry and land silently in the wrong bucket, with neither compiler nor review catching it. Exactly the mistake an outside contributor makes unnoticed. |
| [#924](https://github.com/apify/apify-mcp-server/issues/924) | chore: align enum-like const objects with CONTRIBUTING.md naming | `CONTRIBUTING.md:194-206` specifies one convention and the code does something else in several places. A contributor who reads the standards doc and follows it gets a review comment — nothing corrodes a standards doc faster. |
| [#847](https://github.com/apify/apify-mcp-server/issues/847) | test: Consolidate duplicated MCP server test fixtures | Nine `mcp.server.*.test.ts` files now rebuild the same bootstrap, so every new wiring test pays the tax and the setups drift apart. |
| [#1066](https://github.com/apify/apify-mcp-server/issues/1066) | chore: Quick-win cleanups from codebase sweep | Explicitly scoped one checkbox per 15–60 minute PR, sharing no state. **The best `good first issue` material in the repo**, currently labelled as neither. |
| [#1064](https://github.com/apify/apify-mcp-server/issues/1064) | fix: Sweep defects — tool metadata, config, payment client | Same shape and value; drop the already-fixed first checkbox (§1) and the rest are ideal onboarding PRs. |
| [#758](https://github.com/apify/apify-mcp-server/issues/758) | Improve name for getActors and getActorsAsTools | Both still exist and both return `ToolEntry[]` at different abstraction levels — confusing exactly where a newcomer starts reading the loader. |
| [#668](https://github.com/apify/apify-mcp-server/issues/668) | Reduce Sentry noise: normalize install-corruption / stale-Node / EPIPE events | ~160K events/month, ~99% not our bugs. Real defects are invisible in that, so contributors cannot use Sentry to find work. |
| [#554](https://github.com/apify/apify-mcp-server/issues/554) | Replace Node.js 20 actions in release workflow | The June 2 2026 deadline has passed; `EndBug/add-and-commit` is gone but `DamianReeves/write-file-action@master` remains at `_update_release_metadata.yaml:79`. Releases still succeed (`1e5fd7c`), so not on fire — but it is a live dependency on a deprecated runtime and the fix is one shell line. |
| [#649](https://github.com/apify/apify-mcp-server/issues/649) | ci: sign .mcpb bundle with code-signing certificate in release pipeline | CI-only change giving the desktop bundle verifiable provenance for enterprise admins. |
| [#675](https://github.com/apify/apify-mcp-server/issues/675) | Align Actor input-schema transformation with the canonical Apify pattern | We reimplement normalisation an internal Apify library already solves, and #637 patched the symptom while leaving the root corruption behind a TODO. |
| [#798](https://github.com/apify/apify-mcp-server/issues/798) | refactor: Keep widget linkage explicit, inject runtime widget metadata | Attaching widget `_meta` early then scrubbing it back out is the root cause of the `setPublicUrl` bug; fixing the shape removes a whole class of mode-dependent surprises. |
| [#1114](https://github.com/apify/apify-mcp-server/issues/1114) | refactor: Unify getActorDefinition not-found check onto getHttpStatusCode | The last inline copy of logic the shared helper already does better, including an `error.code` fallback the inline version misses. |
| [#1115](https://github.com/apify/apify-mcp-server/issues/1115) | feat: Dedicated user messages for 429 and 5xx in getToolCallErrorUserText | Telling a caller to "verify the tool name and input parameters" after a rate limit or an upstream outage is actively misleading. |
| [#604](https://github.com/apify/apify-mcp-server/issues/604) | chore: remove stale Skyfire-specific utilities after PaymentProvider refactor | Mostly done already — `applySkyfireAugmentation` and `isSkyfireEligible` are gone. **Narrow it** to the single remaining `redactSkyfirePayId` TODO at `src/payments/skyfire.ts:79`. |
| [#892](https://github.com/apify/apify-mcp-server/issues/892) | Remove the flat-fields back-compat shim from `_meta.x402` | Two shapes for the same data invites drift and forces every reader to branch. Delete once consumers read `accepts[]`. |
| [#1154](https://github.com/apify/apify-mcp-server/issues/1154) | chore: simplify input normalization and retired-selector coverage | Behaviour-preserving cleanup in the loader that a contributor has to read through today. |
| [#1166](https://github.com/apify/apify-mcp-server/issues/1166) | chore: Follow-ups from the 2026-07-28 stateless adapter work | Grouped review findings deliberately deferred under one-thing-per-change, including that `subscriptions/listen` is not actually refused. |
| [#848](https://github.com/apify/apify-mcp-server/issues/848) | chore: Try concurrent integration tests | A two-line change against the suite that dominates iteration time; [PR #1137](https://github.com/apify/apify-mcp-server/pull/1137) is open. |
| [#1149](https://github.com/apify/apify-mcp-server/issues/1149) | test: Seed mcpc harness with a prompt for live prompts/get coverage | Test-infra only, but without it the `prompts/get` success path has no live-wire coverage at all. |
| [#1169](https://github.com/apify/apify-mcp-server/issues/1169) | test: Migrate integration suite to the v2 SDK client | Correctly parked until the v2 SDK leaves beta — keep it, don't schedule it. |

### Process findings

- **Only 2 of 122 open issues carry `good first issue`** (#736, #758). If broad outside contribution
  is the goal, this is the cheapest fix on the list — #1066 and #1064 alone yield about a dozen.
- **The dominant label `t-ai` is an ownership tag, not a triage signal.** `bug` appears on 6 issues,
  `debt` on 5. A contributor filtering the tracker cannot separate a broken-behaviour report from a
  design proposal.
- **Two stale PRs block issues in this triage:**
  [PR #680](https://github.com/apify/apify-mcp-server/pull/680) (draft, targets #638, untouched since
  2026-04-15) and [PR #1101](https://github.com/apify/apify-mcp-server/pull/1101) (fixes #905,
  untouched since 2026-07-17).

---

## 10. Keep — test coverage (11)

Attach all of these to [#777](https://github.com/apify/apify-mcp-server/issues/777) so the board
shows one line, not twelve.

| Issue | Title | Reason to keep |
|---|---|---|
| [#777](https://github.com/apify/apify-mcp-server/issues/777) | test: Integration test coverage audit follow-ups (umbrella) | The tracking issue for this group; keep it and hang the rest off it. |
| [#753](https://github.com/apify/apify-mcp-server/issues/753) | test: Add streamable-HTTP wire-level and session isolation tests | Highest-stakes gap in the plan — `mcpServers[sessionId]` is per-session while `taskStore` is shared, and a leak across sessions would corrupt hosted multi-tenant traffic with nothing catching it. |
| [#907](https://github.com/apify/apify-mcp-server/issues/907) | test(integration): exercise both sync and task-mode paths for every tool that supports tasks | PR #893's bypass shipped precisely because every guard test used `callTool` only. Tools declaring `taskSupport` run both paths in production and are tested through one. |
| [#750](https://github.com/apify/apify-mcp-server/issues/750) | test: Add base protocol and prompt error path tests | Locks down what `initialize` advertises — the contract every client reads first. |
| [#751](https://github.com/apify/apify-mcp-server/issues/751) | test: Add resources/list, templates, and read end-to-end tests | We declare `resources` in capabilities and clients probe it on connect, yet only unit tests touch the service. |
| [#752](https://github.com/apify/apify-mcp-server/issues/752) | test: Add progress notification and logging level tests | Both capabilities are declared and neither is exercised end-to-end, so a wiring regression ships silently. |
| [#754](https://github.com/apify/apify-mcp-server/issues/754) | test: Add _meta.apifyToken propagation tests | The hosted server depends on this path, but the issue itself marks it optional since internal likely covers it — **lowest priority in this group**. |
| [#766](https://github.com/apify/apify-mcp-server/issues/766) | Add automated integration tests for agentic payment headers | Payment regressions currently land unnoticed because header forwarding is only ever validated by hand. |
| [#911](https://github.com/apify/apify-mcp-server/issues/911) | test(integration): add coverage for array-index collapse in structured dataset.fields | The helper has unit coverage but nothing pins the contract on the wire; needs a nested-shape fixture Actor first. |
| [#1173](https://github.com/apify/apify-mcp-server/issues/1173) | chore: Follow-ups from MCP 2026-07-28 test coverage | Six payment scenarios skip entirely on the new protocol dimension — a blind spot in exactly the era we are migrating to. |
| [#558](https://github.com/apify/apify-mcp-server/issues/558) | Flaky: task statusMessage integration tests on streamable HTTP transport | A known-flaky test trains everyone to ignore red CI, and the root cause is already understood (the poll never fires for fast runs). |

---

## 11. Keep — the refactor cluster (5)

#1110, #1116, #1156 and #1111 all rewrite the same call path, each declaring itself blocked-by or
follow-up-to another — and #1120 will rewrite that path *again* for the 2026-07-28 tasks extension.
**Decision needed: sequence all four explicitly behind #1120, or land them first as one unit.**
Running both programmes against the same files wastes one of them.

| Issue | Title | Reason to keep |
|---|---|---|
| [#658](https://github.com/apify/apify-mcp-server/issues/658) | [umbrella] Deduplicate sync + task tool-call paths in server.ts | Keep as the tracking issue — most of it landed and `server.ts` is down to 577 lines. Update it to show what is left. |
| [#1110](https://github.com/apify/apify-mcp-server/issues/1110) | refactor: Extract shared tool-call orchestration core (sync/task dedup) | The remaining real duplication: telemetry bookkeeping and the error-kind if-chains are still written twice with no exhaustiveness guard. |
| [#1116](https://github.com/apify/apify-mcp-server/issues/1116) | refactor: Split tool execution by tool type | `dispatchToolCall`'s parameter list is the union of three unrelated paths' dependencies, plus task-only logging and two inverse flags. |
| [#1156](https://github.com/apify/apify-mcp-server/issues/1156) | refactor: Group tool-call params into lifetime-scoped contexts | ~20 flat params threaded through every layer means adding or removing one value touches four signatures. |
| [#1111](https://github.com/apify/apify-mcp-server/issues/1111) | refactor: Convert >3-positional-param functions to object params | The CONTRIBUTING rule is enforced only by review, which caught two fresh violations in #1105 alone — either lint it or drop it. Worth doing, and it says so itself: "converting signatures the orchestration dedup deletes is wasted churn." Strictly last. |

---

## 12. Keep — everything else (18)

| Issue | Title | Reason to keep |
|---|---|---|
| [#324](https://github.com/apify/apify-mcp-server/issues/324) | Forward headers to Actorized MCP Server | A reproduced user report from Discord — a second auth header is dropped, so the proxied MCP Actor cannot authenticate. |
| [#857](https://github.com/apify/apify-mcp-server/issues/857) | fix: Allow calling MCP server actors in normal (one-shot) mode | A guard added to steer LLMs toward `actor:tool` syntax also blocks legitimate plain-input runs — a real regression with a known cause and a one-line locus. |
| [#860](https://github.com/apify/apify-mcp-server/issues/860) | call-actor mixes Apify-run and MCP-tool pass-through under one schema | The pass-through path fakes `runId: 'mcp-passthrough'` and empty storages to satisfy a schema it does not fit — dishonest values the model will act on. Pairs with #857. |
| [#1158](https://github.com/apify/apify-mcp-server/issues/1158) | report-problem: no receipt, no way to check report status, and the tool silently disappears from tools/list | Our own feedback channel returns empty content and then vanishes from `tools/list`. The one tool that must not be broken, reported by an external user who had to file here instead. |
| [#1049](https://github.com/apify/apify-mcp-server/issues/1049) | feat: Support resources/read in payment mode (x402/Skyfire) | `resources/read` is unusable for every Apify URL in payment mode, and payment headers are not forwarded there either, so billing-by-headers cannot work. |
| [#645](https://github.com/apify/apify-mcp-server/issues/645) | Handle task cancellation TOCTOU race in async task execution | Produces terminal-transition conflicts and noisy error logs in hosted deployments. Absorbs #670. |
| [#683](https://github.com/apify/apify-mcp-server/issues/683) | Show final Actor run statusMessage in task statusMessage | Completed tasks show a frozen intermediate message instead of the Actor's real result. Absorbs #638 — but **its fix plan needs updating**, it references `callActorGetDataset`, which no longer exists. |
| [#905](https://github.com/apify/apify-mcp-server/issues/905) | [Bug]: MCP Apps shows different Pricing info than the public Actor page | User-visible inconsistency between the widget and the public Actor page; [PR #1101](https://github.com/apify/apify-mcp-server/pull/1101) is open but stale since 2026-07-17. |
| [#1188](https://github.com/apify/apify-mcp-server/issues/1188) | Widget _meta places csp/prefersBorder on the tool instead of the UI resource | Claude's host warns about it at runtime today, and the spec is explicit that `csp`/`permissions` belong on the resource; [PR #1190](https://github.com/apify/apify-mcp-server/pull/1190) is open. |
| [#1189](https://github.com/apify/apify-mcp-server/issues/1189) | Automated MCP Apps testing across ChatGPT, claude.ai, Claude Desktop, Cursor | The Claude Desktop `structuredContent` strip broke every widget for weeks before anyone noticed manually — our whole test surface exercises our server, not the hosts. |
| [#1177](https://github.com/apify/apify-mcp-server/issues/1177) | search-actors-widget returns no widget metadata when the search finds no Actors | The same tool renders a widget for a hit and plain text for a miss. **Needs a decision, not code** — the issue says so explicitly. |
| [#790](https://github.com/apify/apify-mcp-server/issues/790) | Update MCP server card at /.well-known/mcp/server-card.json to hybrid shape | Partly done — top-level `name` exists, `serverUrl` is still absent and `tools` is still the string `'dynamic'`. **Merge with #1170**; both edit `src/server_card.ts`. |
| [#844](https://github.com/apify/apify-mcp-server/issues/844) | feat(telemetry): track error details for all tool calls in Segment | Today Segment shows *that* `get-actor-run` and `fetch-apify-docs` failed but never *why*, which blinds every downstream reliability question. |
| [#736](https://github.com/apify/apify-mcp-server/issues/736) | Validate input schema before calling an Actor (especially for task) | Catching bad input before the Actor starts saves the user a billed run and hands the model a correctable error. Already labelled `good first issue`. |
| [#705](https://github.com/apify/apify-mcp-server/issues/705) | [Feature]: Use shorter and more useful Task ID | Small, and task IDs are read by humans debugging and echoed back by models. |
| [#982](https://github.com/apify/apify-mcp-server/issues/982) | Add user-agent based on a client | Without it we cannot separate Claude Code from Apify AI traffic in Mongo or Snowflake, and every later usage question depends on that split. |
| [#270](https://github.com/apify/apify-mcp-server/issues/270) | Make the Docker Hub local and remote server more distinguishable | Two near-identical listings make users pick the wrong one before they ever reach the server. Registry hygiene, not code. |
| [#433](https://github.com/apify/apify-mcp-server/issues/433) | Rename npm package @apify/actors-mcp-server to @apify/mcp-server | Decided on Slack and unscheduled since February. **Pick a release or close it** — a breaking rename gets more expensive every month. |
| [#198](https://github.com/apify/apify-mcp-server/issues/198) | Add country selection to Proxy input schema | A year old and blocked on an apify-core dependency nobody has filed. **Open that dependency or close this.** |

---

## Suggested order

1. **Close §1–§4** — 26 issues, no code; the reasons above are paste-ready.
2. **Rewrite or close §5**; retitle #1121, narrow #900 and #604, update #587, #658 and #683.
3. **Label #1066 and #1064 checkboxes `good first issue`** — cheapest contribution unlock here.
4. **§7** — eleven fixes, each a day or less.
5. **#1119 and the #666 / #941 / #184 programme in parallel** — one product, one cost.
6. **#744, then #1120**, with the §11 sequencing decided before either starts.
