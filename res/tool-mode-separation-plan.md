# Tool Mode Separation: UI vs Normal Mode Architecture

## Executive Summary

**What**: Separate UI-mode (OpenAI) and normal-mode tool behavior into independent, self-contained modules with a shared core logic layer and a mode-aware Actor Executor pattern.

**Why**:
- `if (uiMode === 'openai')` is scattered across 8+ files with substantial behavioral differences (sync vs async execution, different schemas, different response formats, widget metadata)
- Direct actor tools (`type: 'actor'`) are completely UI-mode-unaware — they always run synchronously without widgets, even in OpenAI mode
- The tools-loader uses a fragile deep-clone hack (JSON.parse/stringify with function reattachment) to customize tool descriptions per mode
- Two tools (`search-actors-internal`, `fetch-actor-details-internal`) already use separate definitions, but three others (`call-actor`, `search-actors`, `get-actor-run`) use inline branching — inconsistent patterns

**Impact**:
- Clean separation of concerns — each mode variant is self-contained
- Direct actor tools become mode-aware (currently broken in UI mode)
- Adding a new UI mode (e.g., `'anthropic'`) becomes additive, not invasive
- Eliminates the deep-clone hack in tools-loader
- Deduplicates actor dispatch logic in server.ts (main handler + task handler)
- Fixes Skyfire schema mutation safety (tool definitions become immutable via `Object.freeze`)

**Effort**: 6-10 developer days

**Risk**: Medium — requires coordination with `apify-mcp-server-internal`, no public API name changes

---

## Design Decisions

Explicit decisions made during planning, for future reference.

| Decision | Choice | Rationale |
|----------|--------|-----------|
| `actor-mcp` proxy tools | **Passthrough only, no mode awareness** | Proxy tools forward to external MCP servers; we don't control their response format. No widget wrapping. |
| `add-actor` tool | **Leave as-is, do not make mode-aware** | Likely to be deprecated. Not worth the investment. It stays in `common/`. |
| Skyfire schema mutation | **`Object.freeze` tool definitions; apply Skyfire fields at build time during server init** | Skyfire mutation of shared tool objects has caused production bugs. Tool definitions must be immutable. Skyfire `skyfire-pay-id` injection happens once when the server builds its tool set, producing new frozen objects. |
| Task lifecycle semantics | **"Task completed" = tool handler returned** | For async actor starts, "completed" means the `call` function finished (i.e., Actor was started), not that the Actor run finished. This matches current behavior. Async task rework is planned separately. |
| Phases 2+3 shipping | **Ship together as a single PR** | Executor wiring (Phase 2) changes runtime behavior for direct actor tools. Shipping without the tool split (Phase 3) would leave `call-actor` branching inline while direct actors use the executor — an inconsistent intermediate state. |
| Tool names and categories | **No renames. External API unchanged.** | `ToolCategory` type, tool names, and `tools` input parameter remain identical. `'actors'` selector resolves to mode-correct tools internally. `get-actor-run` stays inside the `runs` category (no new `runs_status` category). |
| `openai/` `_meta` stripping | **Retain `getToolPublicFieldOnly` filter** | Cheap defense-in-depth. Even after separation, a future regression could leak openai `_meta` into a non-openai response. The filter is a few lines and prevents catastrophic leakage. |

---

## Current Architecture Analysis

### How Tool Dispatch Works Today

```
server.ts → CallToolRequestSchema handler
  ├── tool.type === 'internal'  → tool.call(args)            ← call-actor, search-actors, etc.
  ├── tool.type === 'actor-mcp' → connectMCPClient(...)       ← MCP proxy tools (passthrough, unchanged)
  └── tool.type === 'actor'     → callActorGetDataset(...)    ← direct actor tools (e.g., apify/rag-web-browser)
```

**Critical gap**: The `type: 'actor'` dispatch path (lines 851-892 in server.ts) has **zero** UI-mode awareness. `callActorGetDataset()` always runs synchronously, and `buildActorResponseContent()` never attaches widget metadata. This means direct actor tools behave identically regardless of `uiMode`.

A second copy of this dispatch logic exists in `executeToolAndUpdateTask()` (lines 1056-1089), acknowledged with a TODO about duplication.

### Where uiMode Checks Exist Today

| File | What Changes | Behavioral Difference |
|------|-------------|----------------------|
| `tools/actor.ts` (call-actor) | Execution mode, response text, `_meta` | Forced async + widget vs sync + full results |
| `tools/store_collection.ts` (search-actors) | Response format, `_meta`, widget actors | Widget cards vs text cards |
| `tools/fetch-actor-details.ts` | Response content, `_meta`, output schema fetch | Widget response vs full text + output schema |
| `tools/run.ts` (get-actor-run) | Response text, `_meta` | Abbreviated + widget vs full JSON dump |
| `utils/tools-loader.ts` | Tool selection, description mutation, deep clone | Adds UI tools, mutates call-actor description |
| `utils/server-instructions.ts` | Server instruction text | Entirely different workflow rules |
| `utils/tools.ts` | `_meta` field stripping | Strips `openai/` prefixed keys in non-openai mode |
| `mcp/server.ts` | Tool listing, widget resolution | Widget resource resolution gated on mode |
| `resources/resource_service.ts` | Resource listing | Widget HTML resources only in openai mode |

### Existing Separate-Tool Pattern (Partial)

Two tools already have separate UI variants:
- `search-actors-internal` (`openaiOnly: true`) — lightweight search for LLM token savings
- `fetch-actor-details-internal` (`openaiOnly: true`) — lightweight details without widget rendering

But `call-actor`, `search-actors`, `fetch-actor-details`, and `get-actor-run` use inline `if/else` branching instead.

---

## Target Architecture

### Core Idea: Three Layers

```
┌─────────────────────────────────────────────────┐
│  Layer 3: Mode-Specific Tool Definitions        │
│  (description, outputSchema, _meta, response    │
│   formatting, execution semantics)              │
│                                                 │
│  default/call-actor.ts   openai/call-actor.ts   │
│  default/search-actors   openai/search-actors   │
│  default/get-actor-run   openai/get-actor-run   │
│  default/actor-executor  openai/actor-executor   │
├─────────────────────────────────────────────────┤
│  Layer 2: Mode Registry + Loader                │
│  (selects correct tool set at startup,          │
│   no runtime branching, no deep cloning)        │
├─────────────────────────────────────────────────┤
│  Layer 1: Shared Core Logic                     │
│  (actor resolution, API calls, input            │
│   validation, dataset fetching, schema gen)     │
│                                                 │
│  core/actor-execution.ts                        │
│  core/actor-search.ts                           │
│  core/actor-details.ts                          │
└─────────────────────────────────────────────────┘
```

### The Actor Executor Pattern

The Actor Executor solves the critical gap where direct actor tools (`type: 'actor'`) are UI-mode-unaware. It also eliminates the duplicated dispatch logic between the main handler and the task handler.

**Current flow** (server.ts, for `type: 'actor'`):
```typescript
// SAME behavior regardless of uiMode — always sync, no widget
const callResult = await callActorGetDataset({ ... });
const { content, structuredContent } = buildActorResponseContent(actorName, callResult);
return { content, structuredContent };
```

**Target flow** (server.ts, for `type: 'actor'`):
```typescript
// Mode-aware execution via ActorExecutor
const executor = this.actorExecutor; // Set at construction based on uiMode
return executor.executeActorTool({
    actorName: tool.actorFullName,
    input: actorArgs,
    apifyClient,
    callOptions: { memory: tool.memoryMbytes },
    progressTracker,
    abortSignal: extra.signal,
    mcpSessionId,
});
```

**ActorExecutor interface**:
```typescript
type ActorExecutor = {
    /** Execute a direct actor tool (type: 'actor') */
    executeActorTool(params: ActorExecutionParams): Promise<ToolResponse>;
};
```

| Mode | Executor | Behavior |
|------|----------|----------|
| **default** | `DefaultActorExecutor` | Sync: `callActorGetDataset()` → `buildActorResponseContent()` (same as today) |
| **openai** | `OpenAIActorExecutor` | Async: `actorClient.start()` → return runId + widget `_meta` + abbreviated text |

The same executor is used by both the main handler and the task handler, eliminating the dispatch duplication.

**`actor-mcp` tools are explicitly out of scope**: They are passthrough proxies to external MCP servers. Their response format is controlled by the remote server, not by us. No executor wrapping.

### Tool Definition Immutability

**Problem**: Skyfire mode mutates tool schemas at runtime (adds `skyfire-pay-id` property, appends description text). This has caused production bugs where shared tool objects were corrupted across modes/sessions.

**Solution**: All tool definitions are `Object.freeze()`-d after construction. Skyfire augmentation produces **new frozen objects** at server init time rather than mutating existing ones.

```typescript
// At server initialization (upsertTools or equivalent)
function buildToolForRegistration(tool: ToolEntry, skyfireMode: boolean): ToolEntry {
    if (!skyfireMode || !shouldModifyForSkyfire(tool)) {
        return Object.freeze(tool);
    }
    // Create new object with Skyfire fields baked in
    return Object.freeze({
        ...tool,
        description: `${tool.description}\n\n${SKYFIRE_TOOL_INSTRUCTIONS}`,
        inputSchema: addSkyfirePayIdProperty(tool.inputSchema),
    });
}
```

### Directory Structure

```
src/tools/
├── core/                                  # Layer 1: Shared business logic
│   ├── actor-execution.ts                 # callActorGetDataset(), startActorAsync(), resolveActor()
│   ├── actor-search.ts                    # searchApifyStore(), formatActorCard()
│   ├── actor-details.ts                   # fetchActorDetails(), processActorDetailsForResponse()
│   └── actor-response.ts                  # buildActorResponseContent() (moved from utils/)
│
├── default/                               # Layer 3: Normal mode tool definitions
│   ├── call-actor.ts                      # Sync execution, full results, text response
│   ├── search-actors.ts                   # Text-based actor cards, no widget
│   ├── fetch-actor-details.ts             # Full details + output schema fetch
│   ├── get-actor-run.ts                   # Full JSON run dump
│   └── actor-executor.ts                  # DefaultActorExecutor: sync + plain response
│
├── openai/                                # Layer 3: OpenAI UI mode tool definitions
│   ├── call-actor.ts                      # Forced async, widget metadata, abbreviated text
│   ├── search-actors.ts                   # Widget actors, interactive card format
│   ├── fetch-actor-details.ts             # Simplified structured content + widget config
│   ├── get-actor-run.ts                   # Abbreviated text + widget metadata
│   ├── search-actors-internal.ts          # Moved from tools/ (already exists)
│   ├── fetch-actor-details-internal.ts    # Moved from tools/ (already exists)
│   └── actor-executor.ts                  # OpenAIActorExecutor: async + widget response
│
├── common/                                # Tools identical across all modes
│   ├── get-actor-output.ts
│   ├── dataset.ts
│   ├── dataset_collection.ts
│   ├── key_value_store.ts
│   ├── key_value_store_collection.ts
│   ├── run_collection.ts
│   ├── run.ts                             # abort-actor-run, get-actor-log (mode-independent)
│   ├── search-apify-docs.ts
│   ├── fetch-apify-docs.ts
│   ├── get-html-skeleton.ts
│   └── helpers.ts                         # add-actor tool (unchanged, stays here)
│
├── categories.ts                          # Mode-aware category registry
└── index.ts                               # Re-exports
```

### Mode-Aware Category Registry

**Important**: No new category names. The existing `ToolCategory` type and external `tools` input parameter remain unchanged. Internally, the registry resolves mode-correct tool implementations behind the same category names.

```typescript
// categories.ts

import { defaultSearchActors, defaultFetchActorDetails, defaultCallActor } from './default/index.js';
import { defaultGetActorRun } from './default/get-actor-run.js';
import { openaiSearchActors, openaiFetchActorDetails, openaiCallActor } from './openai/index.js';
import { openaiGetActorRun } from './openai/get-actor-run.js';
import { searchActorsInternal, fetchActorDetailsInternal } from './openai/index.js';
// ... common tool imports ...

/** Build the tool categories for a given mode. Same category names, different implementations. */
function buildCategories(uiMode?: UiMode) {
    const isOpenai = uiMode === 'openai';
    return {
        actors: isOpenai
            ? [openaiSearchActors, openaiFetchActorDetails, openaiCallActor]
            : [defaultSearchActors, defaultFetchActorDetails, defaultCallActor],
        runs: [
            isOpenai ? openaiGetActorRun : defaultGetActorRun,
            getUserRunsList,
            getActorRunLog,
            abortActorRun,
        ],
        // openai-only tools injected alongside actors when in openai mode
        ...(isOpenai && {
            ui: [searchActorsInternal, fetchActorDetailsInternal],
        }),
        docs: [searchApifyDocsTool, fetchApifyDocsTool],
        storage: [getDataset, getDatasetItems, getDatasetSchema, getActorOutput, ...],
        experimental: [addTool],
        dev: [getHtmlSkeleton],
    };
}
```

### Simplified Tools-Loader

```typescript
// tools-loader.ts (simplified — no deep cloning, no description mutation, no openai filtering)

export async function loadToolsFromInput(input: Input, apifyClient: ApifyClient, uiMode?: UiMode): Promise<ToolEntry[]> {
    // 1. Build mode-resolved categories (already has correct tools for this mode)
    const categories = buildCategories(uiMode);

    // 2. Select tools based on input.tools selectors (same logic as today)
    const result = resolveSelectorsToTools(input, categories);

    // 3. In openai mode, add UI-specific tools
    if (uiMode === 'openai' && categories.ui) {
        result.push(...categories.ui);
    }

    // 4. Load actor tools (if any)
    if (actorNamesToLoad.length > 0) {
        result.push(...await getActorsAsTools(actorNamesToLoad, apifyClient));
    }

    // 5. Auto-inject companion tools (get-actor-run, get-actor-output)
    injectCompanionTools(result, categories);

    // 6. Deduplicate (no deep-clone, no filtering, no description mutation)
    return deduplicateByName(result);
}
```

**What the loader no longer does**:
- Deep-clone tools via JSON.parse/stringify and reattach functions
- Mutate `call-actor` description based on mode
- Filter out `openaiOnly` tools (they're only in the openai category build)

**What the loader still does** (unchanged):
- Selector resolution (`input.tools` → category names / tool names / actor names)
- Actor tool loading
- Companion tool auto-injection
- Deduplication

### Server Changes

```typescript
// server.ts constructor
class ActorsMcpServer {
    private actorExecutor: ActorExecutor;

    constructor(options: ActorsMcpServerOptions) {
        // Select executor based on mode (once, at construction time)
        this.actorExecutor = options.uiMode === 'openai'
            ? new OpenAIActorExecutor()
            : new DefaultActorExecutor();

        // Server instructions also selected once
        this.serverInstructions = getServerInstructions(options.uiMode);
    }
}

// In setupToolHandlers() — actor dispatch becomes one line:
if (tool.type === 'actor') {
    return this.actorExecutor.executeActorTool({ ... });
}

// In executeToolAndUpdateTask() — same one line, eliminating duplication:
if (tool.type === 'actor') {
    return this.actorExecutor.executeActorTool({ ... });
}

// actor-mcp dispatch UNCHANGED — passthrough only:
if (tool.type === 'actor-mcp') {
    // ... existing connectMCPClient() logic, no mode awareness ...
}
```

### Server Instructions

```
src/utils/
├── server-instructions/
│   ├── common.ts          # Shared instruction text
│   ├── default.ts         # Normal mode instructions
│   └── openai.ts          # UI mode instructions (widget workflow rules)
```

```typescript
// server-instructions/index.ts
export function getServerInstructions(uiMode?: UiMode): string {
    const common = getCommonInstructions();
    const modeSpecific = uiMode === 'openai' ? getOpenAIInstructions() : getDefaultInstructions();
    return `${common}\n\n${modeSpecific}`;
}
```

---

## Tool Name Strategy

**Decision**: Same external tool names across modes. One mode is active per server instance.

| Tool | Name in default mode | Name in openai mode | Notes |
|------|---------------------|---------------------|-------|
| call-actor | `call-actor` | `call-actor` | Different implementation, same name |
| search-actors | `search-actors` | `search-actors` | Different response format |
| fetch-actor-details | `fetch-actor-details` | `fetch-actor-details` | Different content |
| get-actor-run | `get-actor-run` | `get-actor-run` | Different response format |
| search-actors-internal | N/A | `search-actors-internal` | openai-only |
| fetch-actor-details-internal | N/A | `fetch-actor-details-internal` | openai-only |

**Why same names**: Clients calling `call-actor` keep working. Mode is a server-level config, not a per-tool concept. No discovery ambiguity.

**Category names are unchanged**: `actors`, `runs`, `docs`, `storage`, `experimental`, `dev`. The `tools` input parameter accepts the same values as today.

---

## What Changes for Direct Actor Tools

This is the critical gap the Actor Executor pattern fixes.

| Aspect | Today (broken) | After refactor |
|--------|---------------|----------------|
| Execution mode | Always sync | Mode-aware (sync default, async openai) |
| Response format | Always plain text | Mode-aware (plain text vs widget) |
| Widget metadata | Never attached | Attached in openai mode |
| Dispatch location | Hardcoded in server.ts (2 places) | Single `actorExecutor.executeActorTool()` |
| Consistency with call-actor | Inconsistent in UI mode | Same behavior regardless of dispatch path |

---

## Migration Plan & PR Strategy

### PR Chain Structure

Each phase becomes a PR. PRs are chained: each targets the previous feature branch, not `main`. This allows incremental review while keeping `main` stable until the full feature is ready.

```
main
 └── feat/tool-mode-separation-plan          ← PR #1: plan document (this file)
      └── feat/tool-mode-core-extraction     ← PR #2: Phase 1 (shared core logic)
           └── feat/tool-mode-executor       ← PR #3a: Phase 2 (Actor Executor pattern)
                └── feat/tool-mode-tool-split ← PR #3b: Phase 3a (Split mode-divergent tools)
                     └── feat/tool-mode-tool-move ← PR #3c: Phase 3b (Move internal/common tools + freeze)
                          └── feat/tool-mode-registry  ← PR #4: Phase 4 (registry + loader cleanup)
                               └── feat/tool-mode-tests ← PR #5: Phase 5 (contract tests)
```

**Merge order**: PR #1 → PR #2 → PR #3a → PR #3b → PR #3c → PR #4 → PR #5, each into its parent. Final merge of the base branch into `main`.

**Review strategy**: Each PR is independently reviewable. Reviewer can check that tests pass at each level. The plan PR (#1) provides context for all subsequent PRs.

---

### PR #1: Plan Document

**Branch**: `feat/tool-mode-separation-plan` (from `main`)

**Contents**: This plan document (`res/tool-mode-separation-plan.md`) + index update.

**Review focus**: Architecture approval before any code changes.

---

### PR #2: Phase 1 — Extract Shared Core Logic (1-2 days)

**Branch**: `feat/tool-mode-core-extraction` (from `feat/tool-mode-separation-plan`)

**Goal**: Move business logic out of tool handlers into mode-agnostic core modules. Pure refactor, no behavioral changes.

**Changes**:

1. Create `src/tools/core/actor-execution.ts`:
   - Move `callActorGetDataset()` from `src/tools/actor.ts`
   - Move `startActorAsync()` logic (currently inline in call-actor's async branch)
   - Move actor resolution (`getActorsAsTools` lookup, MCP URL check)

2. Create `src/tools/core/actor-search.ts`:
   - Move `searchApifyStoreActors()` call logic
   - Move `formatActorToActorCard()`, `formatActorToStructuredCard()`, `formatActorForWidget()`

3. Create `src/tools/core/actor-details.ts`:
   - Move `fetchActorDetails()` call logic
   - Move `processActorDetailsForResponse()`, `buildActorDetailsTextResponse()`

4. Move `src/utils/actor-response.ts` → `src/tools/core/actor-response.ts`

5. Update all imports in existing tool files to point at new core modules

**Verification**: `npm run type-check && npm run lint && npm run test:unit` — all pass. No behavioral changes.

**Review focus**: Are the extraction boundaries clean? Does the core layer have zero presentation/mode concerns?

---

### PR #3a: Phase 2 — Actor Executor Pattern (1-2 days)

**Branch**: `feat/tool-mode-executor` (from `feat/tool-mode-core-extraction`)

**Goal**: Implement the Actor Executor pattern. Fixes the gap where direct actor tools are mode-unaware.

**Changes**:

1. Define `ActorExecutor` type in `src/types.ts`:
   ```typescript
   type ActorExecutor = {
       executeActorTool(params: ActorExecutionParams): Promise<ToolResponse>;
   };
   ```

2. Implement `DefaultActorExecutor` in `src/tools/default/actor-executor.ts`:
   - Uses `callActorGetDataset()` (sync)
   - Uses `buildActorResponseContent()` (plain text)

3. Implement `OpenAIActorExecutor` in `src/tools/openai/actor-executor.ts`:
   - Uses `actorClient.start()` (async)
   - Returns widget metadata + abbreviated text

4. Add `actorExecutor` field to `ActorsMcpServer`, set in constructor based on `uiMode`

5. Replace both dispatch paths in `server.ts`:
   - `setupToolHandlers()` → `this.actorExecutor.executeActorTool()`
   - `executeToolAndUpdateTask()` → `this.actorExecutor.executeActorTool()`

**Verification**: `npm run type-check && npm run lint && npm run test:unit` — all pass.

**Review focus**: Does the executor interface cover all dispatch needs? Are the executors correctly wired in server.ts?

---

### PR #3b: Phase 3a — Split Mode-Divergent Tools (1-2 days)

**Branch**: `feat/tool-mode-tool-split` (from `feat/tool-mode-executor`)

**Goal**: Split the 4 mode-divergent tools into separate definitions in `default/` and `openai/` directories.

**Changes**:

1. Split `call-actor`:
   - `src/tools/default/call-actor.ts` — sync execution, references `search-actors`/`fetch-actor-details`
   - `src/tools/openai/call-actor.ts` — forced async, widget `_meta`, references `*-internal` tools
   - Each has its own description (no runtime mutation needed)

2. Split `get-actor-run`:
   - `src/tools/default/get-actor-run.ts` — full JSON dump
   - `src/tools/openai/get-actor-run.ts` — abbreviated text + widget `_meta`

3. Split `search-actors`:
   - `src/tools/default/search-actors.ts` — text actor cards
   - `src/tools/openai/search-actors.ts` — widget actors + `_meta` + interactive card text

4. Split `fetch-actor-details`:
   - `src/tools/default/fetch-actor-details.ts` — full text + output schema fetch
   - `src/tools/openai/fetch-actor-details.ts` — simplified structured content + widget `_meta`

**Verification**: `npm run type-check && npm run lint && npm run test:unit` — all pass.

**Review focus**: Are the tool splits clean? Do they match the intended behavior for each mode?

---

### PR #3c: Phase 3b — Move & Freeze Tool Definitions (1 day)

**Branch**: `feat/tool-mode-tool-move` (from `feat/tool-mode-tool-split`)

**Goal**: Move existing internal tools to `openai/`, move common tools to `common/`, and ensure immutability.

**Changes**:

1. Move `search-actors-internal.ts` and `fetch-actor-details-internal.ts` under `openai/`

2. Move mode-independent tools into `common/`:
   - `get-actor-output.ts`
   - `dataset.ts`, `dataset_collection.ts`
   - `key_value_store.ts`, `key_value_store_collection.ts`
   - `run.ts`, `run_collection.ts`
   - `search-apify-docs.ts`, `fetch-apify-docs.ts`
   - `get-html-skeleton.ts`
   - `helpers.ts`

3. `Object.freeze` all tool definitions after construction

**Verification**: `npm run type-check && npm run lint && npm run test:unit` — all pass.

**Review focus**: Is `Object.freeze` applied everywhere? Are common tools properly relocated?

---

### PR #4: Phase 4 — Mode-Aware Category Registry + Loader Cleanup (1 day)

**Branch**: `feat/tool-mode-registry` (from `feat/tool-mode-tool-move`)

**Goal**: Replace the tools-loader's deep-clone hack and conditional logic with clean category selection. Apply Skyfire augmentation at build time.

**Changes**:

1. Implement `buildCategories(uiMode)` in `categories.ts`:
   - Same category names (`actors`, `runs`, `docs`, etc.)
   - Mode-resolved tool implementations behind each name
   - `ui` category only present in openai mode

2. Simplify `loadToolsFromInput()`:
   - Remove JSON.parse/stringify deep-clone hack (lines 188-224)
   - Remove `openaiOnly` filtering logic
   - Remove `getCallActorDescription(uiMode)` description mutation
   - Remove conditional UI tool injection (replaced by `buildCategories`)

3. Move Skyfire augmentation to server init time:
   - `buildToolForRegistration(tool, skyfireMode)` produces new frozen objects
   - No runtime mutation of tool schemas
   - Applied in `upsertTools()` or equivalent

4. Split server instructions:
   - `src/utils/server-instructions/common.ts`
   - `src/utils/server-instructions/default.ts`
   - `src/utils/server-instructions/openai.ts`

5. Remove `openaiOnly` field from `ToolBase` type (no longer needed)

6. **Retain** `getToolPublicFieldOnly` openai `_meta` stripping as defense-in-depth

**Verification**: `npm run type-check && npm run lint && npm run test:unit` — all pass. Loader significantly simpler.

**Review focus**: Is the deep-clone hack fully removed? Does Skyfire augmentation produce immutable objects? Are category names unchanged?

---

### PR #5: Phase 5 — Contract Tests + Cross-Repo Coordination (1 day)

**Branch**: `feat/tool-mode-tests` (from `feat/tool-mode-registry`)

**Goal**: Add mode-parameterized contract tests and verify cross-repo compatibility.

**Changes**:

1. Add mode-parameterized contract tests:
   - Tool list shape per mode (same names, correct count)
   - Output schema per tool per mode
   - `_meta` presence in openai mode, absence in default mode
   - Same actor tool, both modes, identical input → assert sync dataset vs async runId
   - Skyfire × mode matrix (4 combinations: skyfire on/off × default/openai)
   - Task flow in openai mode: verify "task completed" when actor started

2. Use `pkg.pr.new` to publish preview package (add `beta` label to PR)

3. In `apify-mcp-server-internal`:
   ```bash
   npm i https://pkg.pr.new/apify/apify-mcp-server/@apify/actors-mcp-server@<PR_NUMBER>
   npm run type-check && npm run lint
   ```

4. Manual testing with MCP clients in both modes

**Verification**: All contract tests pass. Cross-repo type-check passes.

**Review focus**: Do contract tests cover the critical behavioral differences? Does the preview package work in the internal repo?

---

## Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Breaking `apify-mcp-server-internal` | High | Use `pkg.pr.new` preview packages. Add contract tests for tool list + schemas. |
| Public API break (`tools` input parameter) | High | Category names and tool names unchanged. `'actors'` resolves to mode-correct tools. |
| Skyfire schema mutation corrupting shared objects | High | `Object.freeze` all tool definitions. Skyfire augmentation at build time produces new objects. |
| Circular dependencies during extraction | Medium | Enforce direction: `core` → `utils/types`; mode tools → `core`; never reverse. |
| Shared logic drift between mode variants | Medium | Core layer owns all business logic. Mode tools only format responses. |
| `_meta` leakage across modes | Low | Retain `getToolPublicFieldOnly` openai meta stripping as defense-in-depth. |
| Testing surface expansion | Low | Parameterized test suite runs same assertions per mode. |

---

## Success Criteria

- [ ] All existing unit and integration tests pass
- [ ] Direct actor tools are mode-aware (async + widget in openai, sync in default)
- [ ] No `if (uiMode === 'openai')` in tool handlers (moved to tool selection)
- [ ] Deep-clone hack in tools-loader eliminated
- [ ] Actor dispatch duplication in server.ts eliminated
- [ ] All tool definitions are `Object.freeze()`-d (Skyfire safety)
- [ ] `openaiOnly` field removed from `ToolBase` type
- [ ] `actor-mcp` proxy tools unchanged (passthrough only)
- [ ] `add-actor` tool unchanged (stays in `common/`)
- [ ] Tool names and category names unchanged (external API identical)
- [ ] `getToolPublicFieldOnly` `_meta` filter retained
- [ ] `apify-mcp-server-internal` works without breaking changes
- [ ] Adding a hypothetical `'anthropic'` mode requires only new files in `src/tools/anthropic/`

---

## Files to Create

| File | Purpose | PR |
|------|---------|-----|
| `src/tools/core/actor-execution.ts` | Shared actor execution logic | #2 |
| `src/tools/core/actor-search.ts` | Shared store search logic | #2 |
| `src/tools/core/actor-details.ts` | Shared actor details logic | #2 |
| `src/tools/core/actor-response.ts` | Shared response builder (moved from utils/) | #2 |
| `src/tools/default/call-actor.ts` | Normal mode call-actor | #3b |
| `src/tools/default/search-actors.ts` | Normal mode search-actors | #3b |
| `src/tools/default/fetch-actor-details.ts` | Normal mode fetch-actor-details | #3b |
| `src/tools/default/get-actor-run.ts` | Normal mode get-actor-run | #3b |
| `src/tools/default/actor-executor.ts` | DefaultActorExecutor | #3a |
| `src/tools/openai/call-actor.ts` | OpenAI mode call-actor | #3b |
| `src/tools/openai/search-actors.ts` | OpenAI mode search-actors | #3b |
| `src/tools/openai/fetch-actor-details.ts` | OpenAI mode fetch-actor-details | #3b |
| `src/tools/openai/get-actor-run.ts` | OpenAI mode get-actor-run | #3b |
| `src/tools/openai/actor-executor.ts` | OpenAIActorExecutor | #3a |
| `src/utils/server-instructions/common.ts` | Shared server instructions | #4 |
| `src/utils/server-instructions/default.ts` | Normal mode instructions | #4 |
| `src/utils/server-instructions/openai.ts` | OpenAI mode instructions | #4 |

## Files to Modify

| File | Changes | PR |
|------|---------|-----|
| `src/tools/actor.ts` | Extract core logic to `core/` modules | #2 |
| `src/tools/store_collection.ts` | Extract core logic to `core/` modules | #2 |
| `src/tools/fetch-actor-details.ts` | Extract core logic to `core/` modules | #2 |
| `src/tools/run.ts` | Extract core logic to `core/` modules | #2 |
| `src/mcp/server.ts` | Add `actorExecutor` field; replace 2 actor dispatch blocks | #3a |
| `src/types.ts` | Add `ActorExecutor` type; remove `openaiOnly` from `ToolBase` | #3a, #4 |
| `src/tools/categories.ts` | Mode-aware `buildCategories(uiMode)` | #4 |
| `src/utils/tools-loader.ts` | Remove deep-clone hack, openaiOnly filter, description mutation | #4 |

## Files to Move

| From | To | PR |
|------|-----|-----|
| `src/tools/search-actors-internal.ts` | `src/tools/openai/search-actors-internal.ts` | #3c |
| `src/tools/fetch-actor-details-internal.ts` | `src/tools/openai/fetch-actor-details-internal.ts` | #3c |
| `src/utils/actor-response.ts` | `src/tools/core/actor-response.ts` | #2 |
| `src/utils/server-instructions.ts` | `src/utils/server-instructions/` (split into 3 files) | #4 |

## Files Unchanged (Explicit)

| File | Reason |
|------|--------|
| `src/tools/helpers.ts` (`add-actor`) | Not mode-aware; potential future deprecation |
| `src/mcp/proxy.ts` (`actor-mcp`) | Passthrough only; no mode awareness needed |
| `src/utils/tools.ts` (`getToolPublicFieldOnly`) | `_meta` stripping retained as defense-in-depth |
