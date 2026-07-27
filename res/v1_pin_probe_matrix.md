# v1 pin — differential probe matrix

Design for an **ad-hoc, disposable** harness that proves the v1 (legacy sessionful) protocol
surface is unchanged by the stateless migration (#1128). Not a CI suite. Not a permanent test
suite. Delete it when #1128 closes.

> **Implemented, then pivoted away from the design below.** The harness lives in `tests/e2e/`;
> [`tests/e2e/README.md`](../tests/e2e/README.md) is the doc to trust. The differential approach
> this document describes — no assertions, capture two builds, diff — was abandoned: in practice it
> moved the cost from "write assertions" to "write and debug a redaction filter" (wrong-shape IDs,
> corrupted scientific notation, missed `resources/read`'s `contents` vs `tools/call`'s `content`),
> plus a baseline worktree to keep built and in sync. Every case in `cases.json` now has a real `jq`
> assertion instead. The rest of this document is historical — read it for the reasoning that led to
> the probe *matrix* (still accurate: which configs, which tool calls, which quirks matter), not for
> how results are checked. Corrections that implementation forced on the matrix itself are still
> marked **[measured]** below.

## Why differential

There are no expected values in this harness. The pre-migration build **is** the oracle: run the
same probes against baseline and HEAD, redact the fields that legitimately vary, diff.

This is what makes it cheap enough to be exhaustive. We never write down "call-actor should
return X" for each quirk, so there is nothing to keep current when a quirk intentionally changes —
we re-baseline instead. The probe list is **data** (a table), not code (assertions).

It also beats committed golden fixtures: actor tool descriptions and input schemas are pulled live
from the platform (`src/tools/actors/actor_tools_factory.ts:126`), so a checked-in fixture rots.
Capturing both builds minutes apart against the same platform state cancels that drift out.

## Baseline

`0ca21c6` — the last commit before `432289e` (#1127), the first migration PR.

Deliberately **not** `b1018cc`: that is 6 commits earlier and includes `780fd40` (#1117, APIFY_AI
run origin) and `0ca21c6` (#1125, hardened error-mapper), both of which changed observable
behavior on purpose. Baselining there mixes intentional changes into every diff report.

## Non-goals

- Not wired into CI. Run by hand before releasing the migration.
- Does not replace `tests/integration/suite.ts`. That stays the permanent, assertive suite.
- Does not cover v2 / `2026-07-28`. mcpc cannot negotiate it (see #1132). This pins v1 only.
- No new permanent assertions. If a probe reveals a gap worth keeping, that is a separate PR
  against `suite.ts`.

## Layout

```
tests/v1-pin/
  probes.tsv        # the matrix: config-id, probe-id, mcpc argv
  configs.tsv       # config-id → stdio args / HTTP query string
  redact.jq         # normalizes non-deterministic fields
  run.sh            # loops probes.tsv against one session, writes out/<side>/<config>/<probe>.json
  diff.sh           # runs both sides, diff -r, summarizes
  README.md         # how to run, expected diffs, when to delete
```

Baseline build lives in a worktree, so both builds coexist:

```
git worktree add ../v1-base 0ca21c6 && (cd ../v1-base && pnpm install && pnpm run build)
pnpm run build
```

`run.sh` generates a scratch `.mcp.json` with one session per config per side, pointing at
`../v1-base/dist/stdio.js` and `dist/stdio.js` respectively. mcpc cannot take server args inline —
they must come from named `.mcp.json` entries — so the file is generated from `configs.tsv`.

mcpc is a devDependency (`@apify/mcpc@^0.2.0`); invoke as `pnpm exec mcpc`.

---

## Dimension A — server configurations

From `src/stdio.ts:83-127`. Each row is one `.mcp.json` session entry per side.

| # | Config id | stdio args | Pins |
|---|---|---|---|
| 1 | `default` | *(none)* | `actors`+`docs` categories, `defaults.actors`, auto-injection |
| 2 | `cat-actors` | `--tools=actors` | single category resolution |
| 3 | `cat-docs` | `--tools=docs` | |
| 4 | `cat-runs` | `--tools=runs` | |
| 5 | `cat-storage` | `--tools=storage` | |
| 6 | `cat-dev` | `--tools=dev` | `report-problem`, telemetry-gated |
| 7 | `cat-all` | `--tools=actors,docs,runs,storage` | full set, dedup vs auto-injected |
| 8 | `tools-empty` | `--tools=` | empty selector → no tools |
| 9 | `actors-empty` | `--actors=` | |
| 10 | `both-empty` | `--tools= --actors=` | |
| 11 | `actor-single` | `--actors=apify/rag-web-browser` | |
| 12 | `actor-multi` | `--actors=apify/rag-web-browser,apify/normal-mode-test-actor` | |
| 13 | `actor-via-tools` | `--tools=apify/rag-web-browser` | slash ⇒ treated as Actor name |
| 14 | `tool-by-name` | `--tools=search-actors` | single tool by exact name |
| 15 | `retired-add-actor` | `--tools=add-actor` | resolves to nothing, no token needed |
| 16 | `retired-experimental` | `--tools=experimental` | `RETIRED_SELECTOR_NAMES` (`src/const.ts:68`) |
| 17 | `retired-preview` | `--tools=preview` | |
| 18 | `retired-mixed` | `--tools=actors,add-actor` | retired dropped, valid kept |
| 19 | `merge-compat` | `--tools=actors --actors=apify/rag-web-browser` | `actors` merges into selectors |
| 20 | `ui-apps` | `--ui=apps` | widget siblings added |
| 21 | `ui-default` | `--ui=default` | forced standard set |
| 22 | `ui-auto` | `--ui=auto` | resolves from mcpc's advertised caps |
| 23 | `full-apps` | `--tools=actors,docs,runs,storage --ui=apps` | widest surface |
| 24 | `mcp-proxy` | `--tools=apify/example-mcp-server` | Actorized MCP server as tool |
| 25 | `no-token` | `--tools=docs`, `APIFY_TOKEN` unset | public tool set without a token |

**[measured] `no-token` cannot use the default tool set.** `stdio.ts:161` calls `process.exit(1)`
when auth is required and no token exists, so mcpc `connect` fails and there is no session to probe.
Only public-tool configs are connectable tokenless.

**[measured] Config 24 (`mcp-proxy`) legitimately loads zero tools** when the Actor is unreachable —
loading an MCP-server Actor means connecting to it and enumerating its tools. Its live probe was
moved to `cat-all`, where `call-actor` can route `actor:tool` dynamically.

---

## Dimension B — static probes (Tier 1)

Run against **every** config. No live Actor runs, no platform writes, seconds each. This tier is
the exhaustive one and it is free.

| Probe id | mcpc command | Pins |
|---|---|---|
| `info` | *(bare `mcpc @session`)* | `initialize`: serverInfo, version, capabilities block, instructions text |
| `ping` | `ping` | liveness |
| `logging-set-level` | `logging-set-level debug`, then `... error` | `logging/setLevel` round-trip is accepted |
| `tools-list` | `tools-list --full` | names, **order**, descriptions, full inputSchema |
| `tools-get:<name>` | `tools-get <name>` | per-tool annotations, outputSchema, `_meta` (incl. `ui.*`) |
| `prompts-list` | `prompts-list` | currently empty (`src/prompts/index.ts:6`) — pin that it stays empty rather than throwing |
| `resources-list` | `resources-list` | widget resources in apps mode |
| `resources-templates` | `resources-templates-list` | the 5 API templates (`resource_service.ts:179-208`) |
| `resources-read:widget` | `resources-read ui://widget/search-actors.html` | apps mode only |
| | `resources-read ui://widget/actor-run.html` | `WIDGET_URIS` (`src/resources/widgets.ts:49`) |

**[measured] The `tools-get` fan-out was dropped as redundant.** `mcpc tools-get <name>` returns
output byte-identical to that tool's entry in `tools-list --full`, so one probe per config covers
the whole per-tool surface (annotations, `outputSchema`, `_meta`) and ~180 planned probes disappear.

Verified tool-count anchors: `default` = 10 (5 from `actors`+`docs`, 1 from `defaults.actors`, 4
auto-injected — plus `report-problem` in real stdio use, which the telemetry-off integration suite
never sees), `cat-all` = 17, `full-apps` = 21 (17 + the 4 `*-widget` siblings).

**Tool order is part of the contract** — `tools_loader.ts:274` injects `AUTO_INJECTED_TOOLS`
directly after `call-actor`. Do not sort before diffing.

**[measured] Actual size: 29 configs, 52 cases, 220 captures per side, ~5 min per side.**

---

## Dimension C — error paths (Tier 1)

Error text is exactly the kind of quirk that drifts silently in a refactor, and almost all of these
cost no Actor run. High value per second.

| Probe id | Command | Pins |
|---|---|---|
| `err-unknown-tool` | `tools-call does-not-exist` | JSON-RPC error, not a 500 |
| `err-missing-required` | `tools-call get-key-value-store-record` | AJV message text |
| `err-forbidden-url` | `tools-call fetch-apify-docs url:="https://example.com"` | domain allowlist |
| `err-crawlee-allowed` | `tools-call fetch-apify-docs url:="https://crawlee.dev"` | **[measured]** dropped: passes the allowlist, then depends on outbound reach. Replaced by a `docs.apify.com` fetch. |
| `err-actor-not-found` | `tools-call call-actor actorId:="does/not-exist-xyz"` | not-found mapping |
| `err-mcp-no-toolname` | `tools-call call-actor actorId:="apify/example-mcp-server"` | `CALL_ACTOR_MCP_MISSING_TOOL_NAME_MSG` |
| `err-waitsecs-high` | `tools-call get-actor-run runId:="x" waitSecs:=99` | >45 rejection |
| `err-prompt-unknown` | `prompts-get nonexistent` | `InvalidParams` |
| `err-resource-missing` | `resources-read "http://api.apify.internal:3333/v2/datasets/nope/items"` | JSON-RPC error |
| `err-resource-foreign` | `resources-read "https://example.com"` | non-Apify URL rejected |
| `err-subscribe-unsupported` | `resources-subscribe ui://widget/actor-run.html` | subscriptions are **not** advertised — must error, not silently succeed |
| `err-no-token` | any tool call under config 25 | unauthorized message |

Run against `cat-all` and `full-apps` (plus `no-token` for the last row) — not all 25 configs.

---

## Dimension D — live calls (Tier 2)

Needs `redact.jq`. Run against `cat-all` and `full-apps` only. This is the tier to defer if Tier 1
comes back clean.

| Probe id | Command | Pins |
|---|---|---|
| `call-sync` | `call-actor apify/normal-mode-test-actor` | canonical RunResponse, `summary`/`nextStep`, `_meta.usageTotalUsd` |
| `call-wait0` | same, `callOptions.waitSecs:=0` | non-terminal response shape |
| `call-maxitems` | same, `callOptions.maxItems:=1` | |
| `call-deprecated-preview` | same, `previewOutput:=true` | accepted-but-ignored |
| `call-direct` | direct actor tool for `normal-mode-test-actor` | non-`call-actor` path |
| `call-proxy` | `call-actor actorId:="apify/example-mcp-server:add"` | `actor:tool` routing |
| `search-actors` | `search-actors keywords:="web scraper" limit:=5` | ordering unstable → sort in redact |
| `details:*` | `fetch-actor-details` × each `output` combination | 10 variants: default, `inputSchema`, `description`, `stats`, `pricing`, `readme`, `mcpTools`, all-on, `{description,readme}`, `{rating,metadata}` |
| `details-mcptools-regular` | `fetch-actor-details` `output.mcpTools` on a non-MCP Actor | graceful note |
| `docs-search` | `search-apify-docs query:="actor input"` | |
| `docs-fetch` | `fetch-apify-docs url:=<allowed>` | |
| `run-get` | `get-actor-run runId:=<from call-sync>` | |
| `run-list` | `get-actor-run-list` | |
| `run-log` | `get-actor-log runId:=<from call-sync>` | |
| `ds-items` | `get-dataset-items datasetId:=<from call-sync>` | default `limit` 20 |
| `ds-items-flatten` | same, 3-level nested fields | flattening |
| `ds-meta` / `ds-schema` / `ds-list` | `get-dataset`, `get-dataset-schema`, `get-dataset-list` | |
| `kv-meta` / `kv-keys` / `kv-record` / `kv-list` | the 4 KV tools against the run's default store | |
| `res-read-ds` | `resources-read <dataset items URL>` | API-as-resource path |
| `res-read-kv` | `resources-read <KV record URL>` | |
| `task-*` | `tools-call --detach`, then `tasks-list`, `tasks-get`, `tasks-result`, `tasks-cancel` | task lifecycle |

**[measured] `--task` / `--detach` are subcommand-level flags** (`tools-call --detach <tool>`), not
global ones. Placed before the session they are rejected as unknown options. Tasks are v1-only —
an explicit non-goal for 2026-07-28 — so this is the highest-value block in the table.
`tasks-result` errors while the task is still working, so it must run well after task creation.

Sequencing: `call-sync` runs first; its `runId` / `defaultDatasetId` /
`defaultKeyValueStoreId` feed the storage and run probes. Those IDs differ per side by
construction — capture them into shell vars, and redact them from output.

### Redaction rules (`redact.jq`)

Null out, recursively, by key: `runId`, `actorRunId`, `id`, `buildId`, `datasetId`,
`defaultDatasetId`, `keyValueStoreId`, `defaultKeyValueStoreId`, `requestQueueId`, `startedAt`,
`finishedAt`, `durationMillis`, `usageTotalUsd`, `usageUsd`, `usage`, `taskId`, `containerUrl`,
`statusMessage`, `exitCode`.

Also: replace any ISO-8601 timestamp and any 17-char Apify ID inside `text` bodies with a
placeholder, and sort `search-actors` result arrays by `id`.

Everything nulled here is a field whose *presence and position* we still pin — only the value is
dropped. That is the distinction that keeps the diff meaningful.

---

## Dimension E — session and HTTP behavior

stdio gives one session per process, so session semantics need the `@dev` HTTP server
(`pnpm run dev`, `src/dev_server.ts`).

| Probe id | Method | Pins |
|---|---|---|
| `sess-restart` | `mcpc @dev restart`, re-run `tools-list` | no state leaks across sessions |
| `sess-isolation` | two `.mcp.json` entries on the same URL, different `?tools=` | per-session tool sets do not bleed (`mcpServers[sessionId]`) |
| `sess-task-isolation` | long task on session A, `tasks-list` on B | B sees zero tasks |
| `q-ui-apps` | `?ui=apps` | query-param mode wiring |
| `q-ui-true` | `?ui=true` | treated as `apps` |
| `q-tools` | `?tools=actors,docs` | |
| `q-actors` | `?actors=apify/rag-web-browser` | |
| `q-payment-skyfire` | `?payment=skyfire` | `SKYFIRE_ENABLED_TOOLS`, no token required, readme resource |
| `http-405` | `curl -X GET /` | raw HTTP, outside mcpc |
| `http-404` | `curl -X POST /` no session, non-initialize body | raw HTTP |
| `http-delete` | `DELETE /` | session termination |

The last three bypass mcpc — plain `curl`, captured the same way.

---

## Known-expected diffs

Accept once, record in `README.md`, ignore thereafter:

1. **`add-actor` is gone in HEAD** (#1144, deliberate breaking change). Baseline lists it in
   configs 1, 2, 7, 19, 23; HEAD does not. Config 15 (`--tools=add-actor`) also differs: baseline
   may load it, HEAD resolves to nothing.
2. **Version strings** — `serverInfo.version` and `manifest`/`server.json` bumps in `help` output.
   Redact rather than eyeball.

Anything else is a finding.

## Effort

- `configs.tsv` + `.mcp.json` generation + `run.sh`: ~1.5 h
- Tier 1 + Tier 2 + error probe tables: ~1 h (they are tables)
- `redact.jq`: ~1 h — the only real engineering
- Dimension E: ~1 h (needs `pnpm run dev` running, two sides sequentially)

~4.5 h total. Tier 1 alone is ~2.5 h and delivers most of the confidence.

## Lifecycle

Merged to `master` so it is easy to run from any checkout, but **excluded from CI**. Run before
releasing each migration PR. When #1128 closes, `git rm -r tests/v1-pin` and drop this doc — it is
scaffolding, not a deliverable.
