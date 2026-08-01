# Issue triage — 2026-08-01

Every one of the **122 open issues**, with a verdict and a reason. All "already shipped" and "still
broken" claims were verified against the working tree at `1e5fd7c` — none are taken from issue text.

Nothing has been closed, relabelled or commented on. This is the proposal.

| Verdict | Count |
|---|---|
| Close — already implemented | 9 |
| Close — noise / out of scope | 6 |
| Close — duplicate | 7 |
| Close — decline | 4 |
| Rewrite — unactionable as filed | 5 |
| Postpone — blocked outside this repo | 6 |
| Keep and work | 85 |

**26 issues close, 122 → 96.**

---

## 1. Close — already implemented (9)

| Issue | Verified in tree | Close reason |
|---|---|---|
| [#180](https://github.com/apify/apify-mcp-server/issues/180) Gate `add-actor` on client `listChanged` | `add-actor` deleted; inert entry in `RETIRED_SELECTOR_NAMES`, `src/const.ts:68` | Moot — `add-actor` was deleted in the stateless migration, so there is no tool left to gate. |
| [#447](https://github.com/apify/apify-mcp-server/issues/447) Send debug/info logs to MCP client | `logging: {}` capability declared (`legacy_server.ts:141`); `setupLoggingProxy` filters by level (`:210`); `sendLoggingMessage` used in `task_execution.ts:126` | Shipped — the server declares the `logging` capability and forwards level-filtered logs to the client. |
| [#538](https://github.com/apify/apify-mcp-server/issues/538) Capability-based widget rendering | `isUiSupportedByClient(clientContext)` at `server.ts:251` feeds `resolveServerMode('auto', …)`; `SERVER_MODE_AUTO_DETECTION_ENABLED = true`; `ui=openai` is now a deprecated alias | Shipped — widget mode resolves from the client's advertised MCP Apps capability, and `ui=openai` is retained only as a deprecated alias. |
| [#713](https://github.com/apify/apify-mcp-server/issues/713) Migrate to oxlint/oxfmt | `oxlint.config.ts` present; `oxlint`, `oxfmt`, `oxlint-tsgolint`, `@apify/oxlint-config` in `package.json`; zero eslint/biome deps | Shipped — the toolchain is already oxlint + oxfmt with no ESLint or Biome dependency left. |
| [#733](https://github.com/apify/apify-mcp-server/issues/733) Missing `outputSchema` | All 7 named tools declare it (`abort_actor_run.ts:37`, `get_actor_run_log`, `get_actor_run_list`, `get_dataset`, `get_dataset_schema`, `get_dataset_list`, `get_key_value_store_list`) | Shipped — every tool listed in this issue now declares `outputSchema`. |
| [#765](https://github.com/apify/apify-mcp-server/issues/765) Use MCP Conformance Framework | `scripts/test_conformance.sh` runs `pnpm exec conformance sdk`; `@modelcontextprotocol/conformance@0.2.0-alpha.9` installed; both eras gated in CI | Shipped — `pnpm run test:conformance` runs the official framework across both protocol eras with per-era expected-failure files. |
| [#852](https://github.com/apify/apify-mcp-server/issues/852) Direct actor tools → `RunResponse` | `callActorGetDataset` and `buildActorResponseContent` both absent from `src/` | Shipped — direct Actor tools return the canonical `RunResponse` and the old path is deleted. |
| [#1016](https://github.com/apify/apify-mcp-server/issues/1016) Normalize `required` in `inputSchema` | `fixZodInputSchemaRequired` applied in `getToolPublicFieldOnly` (`src/utils/tools.ts:102`) — the single tools/list path | Shipped — the fix is applied centrally on the tools/list path, so all tools are normalized, not just `get-actor-run`. |
| [#1153](https://github.com/apify/apify-mcp-server/issues/1153) Remove dead tool-removal API | Zero occurrences of `removeToolsByName` in `src/` | Shipped — `removeToolsByName` and its helper are already gone. |

**Knock-on:** [#1064](https://github.com/apify/apify-mcp-server/issues/1064)'s first checkbox is
covered by the #1016 fix — tick it, don't open PRs for it.

**Correction:** [#900](https://github.com/apify/apify-mcp-server/issues/900) is *not* closeable —
part 1 is fixed, part 2 is still live (see §7).

---

## 2. Close — noise / out of scope (6)

| Issue | Close reason |
|---|---|
| [#546](https://github.com/apify/apify-mcp-server/issues/546) AgentWard audit | The headline finding — `call-actor` runs any Store Actor — describes the product, not a defect, and the one legitimate sub-point is already tracked by #612 and #973. |
| [#548](https://github.com/apify/apify-mcp-server/issues/548) Agent memory layer | A pitch for a separate MCP server users can already run alongside this one; nothing to implement here. |
| [#634](https://github.com/apify/apify-mcp-server/issues/634) YellowMCP badge | Vendor badge solicitation, not a change request against this repo. |
| [#756](https://github.com/apify/apify-mcp-server/issues/756) SATS-402 wrapper | Unsolicited third-party proof of concept; Bitcoin-native paid delivery is not on the payments roadmap alongside x402 and Skyfire. |
| [#962](https://github.com/apify/apify-mcp-server/issues/962) CodeGuilds listing | Third-party listing announcement; the author explicitly invites closing it. |
| [#1086](https://github.com/apify/apify-mcp-server/issues/1086) HVTrust badge | Vendor badge solicitation, not a change request against this repo. |

#546 deserves a short public reply before closing — an open issue titled "Arbitrary cloud code
execution" on a public repo is a cost in itself.

---

## 3. Close — duplicate (7)

| Close | Keep | Close reason |
|---|---|---|
| [#638](https://github.com/apify/apify-mcp-server/issues/638) | [#683](https://github.com/apify/apify-mcp-server/issues/683) | Same defect — still no final `statusMessage` written before `storeTaskResult` (`task_execution.ts:173`) — and #683 asks for the better end state, the Actor's real final message rather than a generic `SUCCEEDED`. |
| [#670](https://github.com/apify/apify-mcp-server/issues/670) | [#645](https://github.com/apify/apify-mcp-server/issues/645) | The unguarded 402 path is one instance of the terminal-state-vs-cancellation race #645 covers generally; fixing the general case makes this a test case. |
| [#709](https://github.com/apify/apify-mcp-server/issues/709) | [#744](https://github.com/apify/apify-mcp-server/issues/744) | #744 states it outright: this is the narrow `call-actor` symptom of the repo-wide structured-content gap it tracks. |
| [#773](https://github.com/apify/apify-mcp-server/issues/773) | [#941](https://github.com/apify/apify-mcp-server/issues/941) | "Look at TOON and mcp-compressor" is the exploratory version of #941, which is the actual TOON programme with sub-issues and an eval gate. |
| [#788](https://github.com/apify/apify-mcp-server/issues/788) | [#1017](https://github.com/apify/apify-mcp-server/issues/1017) | #1017 is the finalized spec that supersedes this Slack-link placeholder and already states "closes #788". |
| [#797](https://github.com/apify/apify-mcp-server/issues/797) | [#1176](https://github.com/apify/apify-mcp-server/issues/1176) | The title says `getApifyAPIBaseUrl` is no longer needed while its own body says the opposite; #1176 is the same problem stated correctly and evidenced against production. |
| [#1085](https://github.com/apify/apify-mcp-server/issues/1085) | [#1052](https://github.com/apify/apify-mcp-server/issues/1052) | Same defect class — internal `toolTelemetry` reaching the wire because a path bypasses `extractToolTelemetry` — and one boundary fix ([PR #1083](https://github.com/apify/apify-mcp-server/pull/1083)) closes both. |

---

## 4. Close — decline (4)

| Issue | Decline reason |
|---|---|
| [#448](https://github.com/apify/apify-mcp-server/issues/448) "I'm feeling lucky" prompt | No UX defined, no demand signal and no owner after six months — refile if a user actually asks. |
| [#747](https://github.com/apify/apify-mcp-server/issues/747) Required `rationale` on every tool | Charges every user tokens on every turn so Segment can aggregate intent, directly contradicting #666 in the same repo — take intent from the tool-call sequence telemetry already records. |
| [#749](https://github.com/apify/apify-mcp-server/issues/749) Seed context params | Same objection in weaker form; if it happens at all, one optional enum on `search-actors` and nothing on `call-actor`, removed on any eval regression. |
| [#902](https://github.com/apify/apify-mcp-server/issues/902) Agent-authored Actor reviews | An agent rating the Actor it just ran is a ratings system with no cost to gaming — commit `7142233` removed the "Runs succeeded" stat for exactly this reason; redirect to #748 for developer-facing feedback. |

---

## 5. Rewrite — unactionable as filed (5)

| Issue | Reason |
|---|---|
| [#362](https://github.com/apify/apify-mcp-server/issues/362) Telemetry for long-running tasks | Body is **empty** — nobody can pick this up; write it or close it. |
| [#367](https://github.com/apify/apify-mcp-server/issues/367) Redis task-store TTL and consts | Body is **empty**. |
| [#435](https://github.com/apify/apify-mcp-server/issues/435) LLM evals research | Body is **empty**. |
| [#436](https://github.com/apify/apify-mcp-server/issues/436) Tool search / code execution experiment | Body is **empty**, and #1017 now covers the code-execution half. |
| [#673](https://github.com/apify/apify-mcp-server/issues/673) Improve tool call accuracy | Umbrella whose entire Planned section reads "_(to be designed)_" four months on — design it or fold into #666. |

---

## 6. Postpone — blocked outside this repo (6)

| Issue | Postpone reason |
|---|---|
| [#580](https://github.com/apify/apify-mcp-server/issues/580) Reduced store-search response | Cannot start until apify-core#26549 ships the MCP-optimized response. |
| [#761](https://github.com/apify/apify-mcp-server/issues/761) Serve Apify Skills (SEP-2640) | SEP-2640 is still an open PR against the MCP spec; building on an unmerged `skill://` convention risks a rewrite. |
| [#804](https://github.com/apify/apify-mcp-server/issues/804) Drop redundant store-search call | Blocked on apify-core adding `pictureUrl` to `GET /v2/acts/:actorId`. |
| [#866](https://github.com/apify/apify-mcp-server/issues/866) apify-cli credential move | Correctly filed as a watch item; nothing to do until apify-cli#1115 lands. |
| [#970](https://github.com/apify/apify-mcp-server/issues/970) Re-evaluate KV inline cap | The task is explicitly "decide from Mixpanel data" and that data doesn't exist yet. |
| [#997](https://github.com/apify/apify-mcp-server/issues/997) Search private Actors | The Apify API exposes no private-Actor listing at all, so the fix has to originate upstream. |

---

## 7. Keep — bugs where the server misleads the model (11)

Highest correctness-per-hour on the board. Each one makes an agent draw a confidently wrong
conclusion, and each is small.

| Issue | Why it's worth it |
|---|---|
| [#1193](https://github.com/apify/apify-mcp-server/issues/1193) `get-actor-log` on missing run | Returns `isError: false` and an empty log, so the agent concludes the run produced no output — `get-actor-run` gets it right on the same input. |
| [#1183](https://github.com/apify/apify-mcp-server/issues/1183) `abort-actor-run` dataset wording | Always reports "Dataset metadata unavailable", implying a fetch failed when none was ever attempted. |
| [#1176](https://github.com/apify/apify-mcp-server/issues/1176) URIs from egress host | Every client-facing Apify API URI names the internal host — the URIs don't resolve for clients and the internal hostname is returned verbatim. |
| [#1052](https://github.com/apify/apify-mcp-server/issues/1052) `toolTelemetry` on the wire | A server-internal field escapes on uncaught errors because the outer catch bypasses the stripper; [PR #1083](https://github.com/apify/apify-mcp-server/pull/1083) already exists. |
| [#726](https://github.com/apify/apify-mcp-server/issues/726) Cancellation returns `{}` | `{}` has no `content` and is not a valid `CallToolResult` — still live at `src/mcp/tool_dispatch.ts:246`. |
| [#786](https://github.com/apify/apify-mcp-server/issues/786) Stale Crawlee doc URLs | `search-apify-docs` returns pinned URLs that 404 in `fetch-apify-docs`, breaking the exact workflow our own server instructions prescribe. |
| [#1170](https://github.com/apify/apify-mcp-server/issues/1170) Server card auth claim | Declares auth unconditionally required while four tools serve anonymously, and discovery metadata is read *before* anyone connects — this costs adoption silently. |
| [#1121](https://github.com/apify/apify-mcp-server/issues/1121) Output schema → TS | `storages.datasets.default` is optional in the schema but required by the mapped signature, so generated TypeScript is wrong; reported by an external integrator. **Retitle** — the current title says nothing. |
| [#900](https://github.com/apify/apify-mcp-server/issues/900) `get-dataset-schema` empty | Still live at `get_dataset_schema.ts:72`: says "Dataset is empty" when the default `clean=true` filtered everything out, so the caller stops investigating. **Narrow to part 2** — part 1 is fixed. |
| [#1067](https://github.com/apify/apify-mcp-server/issues/1067) KV record buffering | Buffers the whole record before the 256 KiB decision, so a multi-GB record OOMs the multi-node server and takes other sessions with it; the fix pattern is 40 lines away at `api_resources.ts:216`. |
| [#1004](https://github.com/apify/apify-mcp-server/issues/1004) Non-expiring signed links | Signed KV links are HMACs over the record key with no timestamp — bearer credentials that never expire. |

---

## 8. Keep — product: what makes this the best MCP server (17)

| Issue | Why it's worth it |
|---|---|
| [#1119](https://github.com/apify/apify-mcp-server/issues/1119) Long-running runs | The largest product gap on the board — Apify's differentiated work *is* 20–60 minute runs, and today an agent polls ~80 times to babysit one; every MCP server handles short calls, nobody handles this well. |
| [#666](https://github.com/apify/apify-mcp-server/issues/666) Token footprint | ~5,700 tokens of schema shipped before the user says anything — the cost every user pays every turn, and the most direct lever on both price and accuracy. |
| [#941](https://github.com/apify/apify-mcp-server/issues/941) TOON adoption | The output-side half of the same lever, and the only one of the three with sub-issues and an eval gate already structured. |
| [#744](https://github.com/apify/apify-mcp-server/issues/744) Standardize result shape | The audit is blunt — *no* tool is compliant — and clients reading only `structuredContent` lose the next-step hints entirely; most of §7 stops recurring once this lands. |
| [#1053](https://github.com/apify/apify-mcp-server/issues/1053) Read-only lookup tools | The strongest evidence in the backlog: given both this server and a shell, agents reliably choose raw `curl` — a measured verdict on tool coverage. |
| [#1120](https://github.com/apify/apify-mcp-server/issues/1120) 2026-07-28 tasks extension | The spec went final on 2026-07-28 and our task path still runs on the 2025-11-25 *experimental* API; being visibly behind on the spec is the opposite of the goal. |
| [#741](https://github.com/apify/apify-mcp-server/issues/741) OAuth / SSO | A named organisation calls long-lived tokens a blocker for approval — this is the enterprise adoption gate. |
| [#1015](https://github.com/apify/apify-mcp-server/issues/1015) EMA extension | Atlassian, Linear, Figma and Supabase already ship it; worth it, but it is the layer *on top of* #741 and cannot go first. |
| [#954](https://github.com/apify/apify-mcp-server/issues/954) `whoami` | One endpoint, and the model can state which account it is spending — cheapest agent-UX win here. |
| [#998](https://github.com/apify/apify-mcp-server/issues/998) Storages as resources | Real protocol depth — subscribe, live local copies — instead of yet more tools; merge with #587 Phase 4 and #1053. |
| [#612](https://github.com/apify/apify-mcp-server/issues/612) Full-permission hint | Trust is what makes an agent willing to call `call-actor` at all, and this is the honest half of #546. |
| [#973](https://github.com/apify/apify-mcp-server/issues/973) Non-destructive hint | The inverse of #612 — dropping the scary hint where it's provably wrong keeps the remaining hints credible. |
| [#184](https://github.com/apify/apify-mcp-server/issues/184) Input-schema subset | Actor input schemas are the single largest token sink after tool descriptions; this is #666's biggest individual line item and should be sequenced with it. |
| [#337](https://github.com/apify/apify-mcp-server/issues/337) Protocol vs execution errors | "Tool execution failed" for an out-of-range `limit` gives the model nothing to correct; good error text is the cheapest accuracy fix available. |
| [#704](https://github.com/apify/apify-mcp-server/issues/704) `model-immediate-response` | Gives the model run ID and status the moment a task starts instead of after the first poll — directly reduces the polling burden #1119 is about. |
| [#1017](https://github.com/apify/apify-mcp-server/issues/1017) Code Mode | Potentially the biggest differentiator here, but it is a new Actor plus a `workerd` sandbox — **hold until [PR #1124](https://github.com/apify/apify-mcp-server/pull/1124)'s A/B eval reports**, then promote or close. |
| [#587](https://github.com/apify/apify-mcp-server/issues/587) Post-#582 roadmap | Phase 2 has shipped and Phase 4 overlaps #998/#1053 — **rewrite around what's left or retire it**; as filed it now overstates the remaining work. |

---

## 9. Keep — maintainability and contributor experience (23)

External contribution is already real: **seven of the fifteen open PRs are from outside the team**
([#1186](https://github.com/apify/apify-mcp-server/pull/1186),
[#1185](https://github.com/apify/apify-mcp-server/pull/1185),
[#1181](https://github.com/apify/apify-mcp-server/pull/1181),
[#1083](https://github.com/apify/apify-mcp-server/pull/1083),
[#1079](https://github.com/apify/apify-mcp-server/pull/1079),
[#1054](https://github.com/apify/apify-mcp-server/pull/1054),
[#1048](https://github.com/apify/apify-mcp-server/pull/1048)). Ranked on: *how much does this change
what a first-time contributor experiences?*

**What already works:** `CONTRIBUTING.md` is a real 364-line standards document; seven `AGENTS.md`
files give per-directory context and `pnpm run check:agents` keeps the link tree honest; a PR
template exists; `src/mcp/server.ts` is down to **577 lines** because the #658 dispatch work largely
landed. The items below are where that foundation leaks.

| Issue | Why it's worth it |
|---|---|
| [#1065](https://github.com/apify/apify-mcp-server/issues/1065) `defineHelperTool` factory | Highest-leverage item here — adding a tool means hand-repeating `z.toJSONSchema()` twice, `title` twice, a 4-line annotations block copied verbatim in ~15 tools and the `Object.freeze` envelope (~250 lines of boilerplate), so a newcomer copies whichever tool they opened first and inherits its drift. |
| [#776](https://github.com/apify/apify-mcp-server/issues/776) Split `suite.ts` | **Now 3,292 lines, up from the 2,813 quoted in the issue** — it got worse since filing, and the issue notes reviewers are already blocking test additions on it. |
| [#935](https://github.com/apify/apify-mcp-server/issues/935) `respond*` constructors | Telemetry classification is opt-in today: a handler can return `isError: true`, forget the telemetry and land silently in the wrong bucket with neither compiler nor review catching it — exactly the mistake an outside contributor will make unnoticed. |
| [#924](https://github.com/apify/apify-mcp-server/issues/924) Enum naming vs CONTRIBUTING | `CONTRIBUTING.md:194-206` specifies one convention and the code does something else in several places; a contributor who follows the standards doc gets a review comment, which corrodes the doc faster than anything. |
| [#1111](https://github.com/apify/apify-mcp-server/issues/1111) Object params | Same failure mode — the rule is enforced only by review, and review caught two fresh violations in #1105 alone; either lint it or drop it. **Sequence behind #1120** (see §11). |
| [#847](https://github.com/apify/apify-mcp-server/issues/847) Test fixtures | Nine `mcp.server.*.test.ts` files now rebuild the same bootstrap, so every new wiring test pays the tax and the setups drift. |
| [#1066](https://github.com/apify/apify-mcp-server/issues/1066) Quick-win cleanups | Explicitly scoped one checkbox per 15–60 minute PR sharing no state — **the best `good first issue` material in the repo**, currently labelled as neither. |
| [#1064](https://github.com/apify/apify-mcp-server/issues/1064) Sweep defects | Same shape, same value; drop the already-fixed first checkbox (§1) and the rest are ideal onboarding PRs. |
| [#758](https://github.com/apify/apify-mcp-server/issues/758) Loader naming | `getActors` and `getActorsAsTools` both still exist and both return `ToolEntry[]` at different abstraction levels — confusing exactly where a newcomer starts reading. |
| [#668](https://github.com/apify/apify-mcp-server/issues/668) Sentry noise | ~160K events/month, ~99% not our bugs — real defects are invisible in that, so contributors can't use Sentry to find work. |
| [#554](https://github.com/apify/apify-mcp-server/issues/554) Node 20 actions | The June 2 2026 deadline has passed; `EndBug/add-and-commit` is gone but `DamianReeves/write-file-action@master` remains at `_update_release_metadata.yaml:79` — releases still succeed (`1e5fd7c`), so not on fire, but it's a live dependency on a deprecated runtime and the fix is one shell line. |
| [#649](https://github.com/apify/apify-mcp-server/issues/649) Sign the `.mcpb` bundle | CI-only change that gives the desktop bundle verifiable provenance for enterprise admins. |
| [#675](https://github.com/apify/apify-mcp-server/issues/675) Input-schema transformation | We reimplement normalisation that an internal Apify library already solves, and #637 patched the symptom while leaving the root corruption behind a TODO. |
| [#798](https://github.com/apify/apify-mcp-server/issues/798) Widget metadata injection | Attaching widget `_meta` early then scrubbing it back out is the root cause of the `setPublicUrl` bug — fixing the shape removes a whole class of mode-dependent surprises. |
| [#1114](https://github.com/apify/apify-mcp-server/issues/1114) Unify not-found check | Last inline copy of logic the shared `getHttpStatusCode` helper already does better, including an `error.code` fallback the inline version misses. |
| [#1115](https://github.com/apify/apify-mcp-server/issues/1115) 429/5xx messages | Telling a caller to "verify the tool name and input parameters" after a rate limit or upstream outage is actively misleading. |
| [#604](https://github.com/apify/apify-mcp-server/issues/604) Skyfire cleanup | Mostly done — **narrow it** to the single remaining `redactSkyfirePayId` TODO at `src/payments/skyfire.ts:79`. |
| [#892](https://github.com/apify/apify-mcp-server/issues/892) Drop `_meta.x402` shim | Two shapes for the same data invites drift and forces every reader to branch; delete once consumers read `accepts[]`. |
| [#1154](https://github.com/apify/apify-mcp-server/issues/1154) Simplify input normalization | Behaviour-preserving cleanup in the loader that a contributor has to read through today. |
| [#1166](https://github.com/apify/apify-mcp-server/issues/1166) Stateless adapter follow-ups | Grouped review findings deliberately deferred under one-thing-per-change, including `subscriptions/listen` not actually being refused. |
| [#848](https://github.com/apify/apify-mcp-server/issues/848) Concurrent integration tests | A two-line change against a suite that dominates iteration time; [PR #1137](https://github.com/apify/apify-mcp-server/pull/1137) is open. |
| [#1149](https://github.com/apify/apify-mcp-server/issues/1149) Seed mcpc with a prompt | Test-infra only, but without it the `prompts/get` success path has no live-wire coverage at all. |
| [#1169](https://github.com/apify/apify-mcp-server/issues/1169) v2 SDK client migration | Correctly parked until the v2 SDK leaves beta — keep, don't schedule. |

### Process findings

- **Only 2 of 122 open issues carry `good first issue`** (#736, #758). If broad outside contribution
  is the goal, this is the cheapest fix on the list — #1066 and #1064 alone yield a dozen.
- **The dominant label `t-ai` is an ownership tag, not a triage signal.** `bug` appears on 6 issues,
  `debt` on 5; a contributor filtering the tracker cannot separate a broken-behaviour report from a
  design proposal.
- **Two stale PRs block issues in this triage:**
  [PR #680](https://github.com/apify/apify-mcp-server/pull/680) (draft, targets #638, untouched since
  2026-04-15) and [PR #1101](https://github.com/apify/apify-mcp-server/pull/1101) (fixes #905,
  untouched since 2026-07-17).

---

## 10. Keep — test coverage, all under [#777](https://github.com/apify/apify-mcp-server/issues/777) (11)

Attach these to #777 so the board shows one line, not twelve.

| Issue | Why it's worth it |
|---|---|
| [#753](https://github.com/apify/apify-mcp-server/issues/753) Session isolation | Highest-stakes gap in the plan — `mcpServers[sessionId]` is per-session while `taskStore` is shared, and a leak across sessions would corrupt hosted multi-tenant traffic with nothing catching it. |
| [#907](https://github.com/apify/apify-mcp-server/issues/907) Sync + task paths | PR #893's bypass shipped precisely because every guard test used `callTool` only; tools declaring `taskSupport` go through both paths in production and are tested through one. |
| [#750](https://github.com/apify/apify-mcp-server/issues/750) Protocol + prompt errors | Locks down what `initialize` advertises — the contract every client reads first. |
| [#751](https://github.com/apify/apify-mcp-server/issues/751) Resources end-to-end | We declare `resources` in capabilities and clients probe it on connect, yet only unit tests touch the service. |
| [#752](https://github.com/apify/apify-mcp-server/issues/752) Progress + logging | Both capabilities are declared and neither is exercised end-to-end, so a wiring regression ships silently. |
| [#754](https://github.com/apify/apify-mcp-server/issues/754) `_meta.apifyToken` | The hosted server depends on this path; the issue itself marks it optional since internal likely covers it — **lowest priority in this group**. |
| [#766](https://github.com/apify/apify-mcp-server/issues/766) Payment headers | Payment regressions currently land unnoticed because header forwarding is only ever validated by hand. |
| [#911](https://github.com/apify/apify-mcp-server/issues/911) Array-index collapse | The helper has unit coverage but nothing pins the contract on the wire; needs a nested-shape fixture Actor first. |
| [#1173](https://github.com/apify/apify-mcp-server/issues/1173) 2026-07-28 coverage gaps | Six payment scenarios skip entirely on the new protocol dimension — a blind spot in exactly the era we're migrating to. |
| [#558](https://github.com/apify/apify-mcp-server/issues/558) Flaky statusMessage tests | A known-flaky test in CI trains everyone to ignore red, and the root cause is understood (poll never fires for fast runs). |
| [#1189](https://github.com/apify/apify-mcp-server/issues/1189) Host-side Apps testing | The Claude Desktop `structuredContent` strip broke every widget for weeks before anyone noticed manually — our whole test surface exercises our server, not the hosts. |

---

## 11. Keep — the refactor cluster (5)

[#1110](https://github.com/apify/apify-mcp-server/issues/1110),
[#1116](https://github.com/apify/apify-mcp-server/issues/1116),
[#1156](https://github.com/apify/apify-mcp-server/issues/1156) and
[#1111](https://github.com/apify/apify-mcp-server/issues/1111) all rewrite the same call path, each
declaring itself blocked-by or follow-up-to another — and
[#1120](https://github.com/apify/apify-mcp-server/issues/1120) will rewrite that path *again* for the
2026-07-28 tasks extension.

| Issue | Reason |
|---|---|
| [#658](https://github.com/apify/apify-mcp-server/issues/658) Umbrella | Keep as the tracking issue — most of it landed (`server.ts` is down to 577 lines); update it to show what's left. |
| [#1110](https://github.com/apify/apify-mcp-server/issues/1110) Orchestration core | The remaining real duplication: telemetry bookkeeping and the error-kind if-chains are still written twice with no exhaustiveness guard. |
| [#1116](https://github.com/apify/apify-mcp-server/issues/1116) Split by tool type | Worth it — `dispatchToolCall`'s parameter list is the union of three unrelated paths' dependencies. |
| [#1156](https://github.com/apify/apify-mcp-server/issues/1156) Lifetime-scoped contexts | Worth it — ~20 flat params threaded through every layer means one added value touches four signatures. |
| [#1111](https://github.com/apify/apify-mcp-server/issues/1111) Object params | Worth it, and it says so itself: "converting signatures the orchestration dedup deletes is wasted churn". |

**Decision needed:** sequence all four explicitly behind #1120, or land them first as one unit.
Running both programmes against the same files wastes one of them.

---

## 12. Keep — everything else (18)

| Issue | Reason |
|---|---|
| [#324](https://github.com/apify/apify-mcp-server/issues/324) Forward headers to Actorized MCP | A reproduced user report from Discord — a second auth header is dropped, so the proxied server can't authenticate. |
| [#857](https://github.com/apify/apify-mcp-server/issues/857) One-shot MCP-server Actors | A guard added to steer LLMs toward `actor:tool` syntax also blocks legitimate plain-input runs; a real regression with a known cause. |
| [#860](https://github.com/apify/apify-mcp-server/issues/860) `call-actor` dual semantics | The pass-through path fakes `runId: 'mcp-passthrough'` and empty storages to satisfy a schema it doesn't fit — dishonest values the model will act on. Pairs with #857. |
| [#1158](https://github.com/apify/apify-mcp-server/issues/1158) `report-problem` UX | Our own feedback channel returns empty content and then vanishes from `tools/list` — the one tool that must not be broken, reported by an external user. |
| [#1049](https://github.com/apify/apify-mcp-server/issues/1049) `resources/read` in payment mode | `resources/read` is unusable for every Apify URL in payment mode, and payment headers aren't forwarded, so billing-by-headers can't work there either. |
| [#645](https://github.com/apify/apify-mcp-server/issues/645) Cancellation TOCTOU | Produces terminal-transition conflicts and noisy error logs in hosted deployments; absorbs #670. |
| [#683](https://github.com/apify/apify-mcp-server/issues/683) Final task `statusMessage` | Completed tasks show a frozen intermediate message; absorbs #638. **Its fix plan needs updating** — it references `callActorGetDataset`, which no longer exists. |
| [#905](https://github.com/apify/apify-mcp-server/issues/905) Widget pricing mismatch | User-visible inconsistency between the widget and the public Actor page; [PR #1101](https://github.com/apify/apify-mcp-server/pull/1101) is open but stale since 2026-07-17. |
| [#1188](https://github.com/apify/apify-mcp-server/issues/1188) Widget `_meta` placement | Claude's host warns about it at runtime today, and the spec is explicit that `csp`/`permissions` belong on the resource; [PR #1190](https://github.com/apify/apify-mcp-server/pull/1190) is open. |
| [#1177](https://github.com/apify/apify-mcp-server/issues/1177) Empty search widget | Same tool renders a widget for a hit and plain text for a miss — **needs a decision, not code**; the issue says so. |
| [#790](https://github.com/apify/apify-mcp-server/issues/790) Server card shape | Partly done — top-level `name` exists, `serverUrl` is still absent and `tools` is still the string `'dynamic'`; **merge with #1170**, both edit `src/server_card.ts`. |
| [#844](https://github.com/apify/apify-mcp-server/issues/844) `failure_detail` everywhere | Today Segment shows that `get-actor-run` and `fetch-apify-docs` failed but never why, which blinds every downstream reliability question. |
| [#736](https://github.com/apify/apify-mcp-server/issues/736) Validate input before calling | Catching a bad input before the Actor starts saves the user a billed run and gives the model a correctable error; already labelled `good first issue`. |
| [#705](https://github.com/apify/apify-mcp-server/issues/705) Shorter task ID | Small, and task IDs are read by humans debugging and by models echoing them back. |
| [#982](https://github.com/apify/apify-mcp-server/issues/982) Client-based user-agent | Without it we can't separate Claude Code from Apify AI traffic in Mongo or Snowflake — cheap, and every later usage question depends on it. |
| [#270](https://github.com/apify/apify-mcp-server/issues/270) Docker Hub listings | Two near-identical listings make users pick wrong before they ever reach the server; registry hygiene, not code. |
| [#433](https://github.com/apify/apify-mcp-server/issues/433) Package rename | Decided on Slack and unscheduled since February — **pick a release or close it**; a breaking rename gets more expensive each month. |
| [#198](https://github.com/apify/apify-mcp-server/issues/198) Proxy country selection | A year old and blocked on an apify-core dependency nobody has filed — **open that dependency or close this**. |

---

## Suggested order

1. **Close §1–§4** — 26 issues, no code, reasons above are paste-ready.
2. **Rewrite or close §5**, and retitle #1121, narrow #900 and #604, update #587 and #658.
3. **Label #1066 and #1064 checkboxes as `good first issue`** — cheapest contribution unlock here.
4. **§7** — eleven fixes, each a day or less.
5. **#1119 and the #666/#941/#184 programme in parallel** — one product, one cost.
6. **#744, then #1120**, with the §11 decision made before either starts.
