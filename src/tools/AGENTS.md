<!-- agents-scope: src/tools -->
# src/tools — MCP tool implementations

↑ [src/](../AGENTS.md) · sideways: [`../mcp/AGENTS.md`](../mcp/AGENTS.md)

The cross-file invariant: a tool is defined here as a Zod-validated entry, and the
**same implementation serves both server modes** — only `*-widget` tools differ
between default and apps mode. Every non-widget tool (`call-actor`, `get-actor-run`,
direct actor tools, `search-actors`, `fetch-actor-details`) is mode-agnostic.

## Files

- `registry.ts` — tool categories and the tools in each (`index.ts` re-exports them), plus tools in no
  category (`ALL_WIDGET_TOOLS`, `UNCATEGORIZED_TOOLS`; `send-server-actor-request` is there until it is enabled by
  default).
- `structured_output_schemas.ts` — shared JSON-schema definitions for structured
  output across tools.
- `utils.ts` — shared tool helpers (schema property shaping, AJV compile).
- `actor_tool_naming.ts` — Actor tool names and `resolveActorInterfaces`, the one rule for which interfaces an
  Actor has: `input` (a run tool through its input schema), `mcp` (its MCP server) and `server` (its HTTP API,
  `hasWebServerSchema`). `resolveActorToolMode` derives the tool slot from the set — MCP tools if `mcp`, else a
  run tool if `input`, else none (`SERVER_ACTOR_WITHOUT_MCP`) — and tool loading and `call-actor` routing both
  read it. Actors in `INPUT_INTERFACE_ACTORS` (`../const.ts`) read as having no MCP interface, so they are
  served as run tools although they declare `webServerMcpPath`, unless their input schema is empty, in which
  case they get no tool.
- Tool implementations are grouped by domain, each registered through `registry.ts`:
  - `actors/` — search, details, call, the list of the account's Actors (`get-actor-list`), delete
    (`delete_actor.ts`), the actor-tools factory, the direct actor-tool executor (`actor_executor.ts`),
    `actor_definition.ts` (fetches and prunes an Actor's definition, `getActorDefinition`, and resolves the build
    the server-interface fields — `webServerMcpPath`, `webServerSchema` — are read from when standby is on,
    `resolveServerInterfaceDefinition`, shared with `fetchActorDetails` in `../utils/actor_details.ts`; the input
    schema and README stay on the default build; `hasWebServerSchemaOperations` detects operations the send tool
    can call in the publisher's schema; `webServerOperations` caches each operation with its required inputs, which
    the send tool lists after a 400/404/405/422),
    `server_interface_schema.ts` (the server-interface text of `fetch-actor-details`: by default one summary line,
    served only with `send-server-actor-request`; `output.serverInterface: true` returns every operation in the
    `get-apify-api-details` shape (`buildServerOperationDetails`, through the API tools' `dereference`: local
    references inlined, examples kept, no responses, components or `servers`) while the text fits
    `MAX_INLINE_BYTES`, else one line per operation (`formatOperationLine`), cut with `… and N more`;
    `"METHOD /path"` returns that one operation; reference expansion has a byte budget, as a creator schema can
    expand exponentially),
    `send_server_actor_request.ts` (`send-server-actor-request`: one HTTP request to a Server Actor's API, gated on
    the `server` interface and sent through `sendApifyApiRequest` with raw response
    bytes, no redirects, the `MAX_INLINE_BYTES` cap after decompression and the `EXTERNAL_TOOL_CALL_TIMEOUT_MSEC`
    deadline; the path is resolved against the Actor's `standbyUrl` and must keep its origin; query values are
    validated without coercion; text uses the declared charset, UTF-8 by default, and rejects unsupported
    charsets while keeping the HTTP status; refused bodies retain structured request/status metadata with
    `bodyOmitted` and `reason`, and `bytes` only when the full size is known; session tokens are masked after decoding too),
    `call_actor_mcp_tool.ts` (`call-actor-mcp-tool`: one `tools/call` on an MCP server Actor's server, gated on the
    `mcp` interface, with the remote `CallToolResult` passed through except for internal telemetry;
    `runOnActorMcpServer` resolves the Actor and its MCP URL, connects under the caller's token and turns a failed
    connection, an abort or a remote error into a response),
    `fetch_actor_mcp_tool_list.ts` (`fetch-actor-mcp-tool-list`: an uncached `tools/list` through
    `runOnActorMcpServer` that follows `nextCursor` within one `EXTERNAL_TOOL_CALL_TIMEOUT_MSEC` for all pages,
    fails on a failed page and stops after `MAX_TOOL_LIST_PAGES`;
    `fetch-actor-details` never connects to an MCP server),
    `actor_tool_contract.ts` (Actor-specific presentation policies plus direct-tool input restrictions
    and defaults, shared by schema generation, the call engine's denied-input check and execution;
    generic calls skip direct-only restrictions and defaults), and
    `actor_run_response.ts` —
    the one canonical run shape `call-actor` and `get-actor-run` share across sync, task
    and wait-timeout modes: storage IDs plus a `summary` (past) / `nextStep` (one primary
    action) pair, never inline dataset items or KV bodies — except the reserved `TIP` key,
    inlined as `tip` on terminal RAG Web Browser runs only.
  - `runs/` — get/abort runs, run logs, run list.
  - `storage/` — dataset and key-value-store tools plus `storage_helpers.ts`.
  - `tasks/` — Actor task create/get/update plus publish/unpublish of the task's public
    landing page (`task_helpers.ts` holds the shared task response shape and the publication call).
  - `schedules/` — schedule create/get/update/delete for Actors and tasks; `schedule_helpers.ts`
    converts the flat action shape to the API shape and back, and reuses `getTaskByIdOrName` from
    `tasks/task_helpers.ts`.
  - `builds/` — `get-actor-build` (build status), `get-actor-build-log` (build log tail),
    `get-actor-build-list` (the account's builds, or one Actor's with `actorId`, in every status, newest
    first, pointing at the newest failed one) and `build-actor` (start a build of one version and wait for it); `build_helpers.ts` holds the
    allowlisted build result shape, the build start and wait calls (the wait reports progress), the
    shared `waitSecs` field, the shared build response and the by-status next-step text.
  - `versions/`: `get-actor-version` (an Actor version's build tag, file manifest with hashes, revision,
    and requested content), `create-actor` (a new Actor with one version in a single POST),
    `update-actor-version` (write, edit, and delete operations applied all-or-nothing to a fresh read,
    stored with one version PUT that carries only the source keys), `create-actor-version` (a new
    version in one POST, from files or as a copy of another version's files and non-secret env vars,
    with no default buildTag), and `delete-actor-version` (reads the Actor first, since apify-client
    reports a delete of a missing version as done, and returns the tags still on its builds). `source_files.ts` holds the file shape, the
    manifest builder, the hash and revision rules, and the text-or-base64 detection;
    `source_helpers.ts` holds the Actor and version lookup, the file input shape, and the response
    after a write, which starts the build for autoBuild. get-actor-version, update-actor-version, and a
    copy in create-actor-version refuse a version not stored as files (Git repository, gist, or zip);
    create-actor-version from files and delete-actor-version work whatever the Actor's versions are
    stored as, but delete-actor-version takes expectedRevision only for a version stored as files.
  - `api/` — the generic Apify API tools: search the operations of the published OpenAPI spec, get the
    operations on a path, and send a GET, or a POST, PUT, PATCH, or DELETE, to a path. All four are in the
    `api` category, which is not served by default, so a session gets the write tool only with `tools=api`
    or by naming it. The call tools are proxies to the API, like `apify api` in the Apify CLI.
    They refuse what `API_BLOCK_RULES` in `apify_api_blocklist.ts` lists: the `method` query parameter,
    which the API takes as the HTTP method, and a GET to the synchronous run endpoints of Actors and tasks,
    which starts a paid run (the write tool still sends the POST). So the read tool is annotated read-only.
    `callApi` checks every call (`validateApiBlocklist`), fail-closed, as the API reads the request URL, and
    refuses a path whose dot segments climb out of `/v2/`; the index leaves out each operation a rule matches
    (`isEndpointBlocked`), so search, details, the closest-path hints, and the write tool's method
    choice never offer it.
    `apify_api_spec.ts` builds the operation index from the spec (cached for a day); search and
    details use it, the write tool uses it to choose a method that was not given, and a call uses it
    otherwise only for hints, waiting at most a few seconds, so a failed download does not stop a
    call. `apify_api_request.ts` normalizes the path as the CLI does (`actors`, `v2/actors`, and
    `/v2/actors` are the same), sends it as written with the query added after any query string in
    it, and looks up a legacy `acts` path as `actors`, the prefix the spec lists. It asserts that the
    URL stays on the API origin, sends one request with no retries, masks the session token in the
    response, redacts the `urlSigningSecretKey` and `password` values in a JSON body, keeps a query in
    the path out of the error it throws, and adds the closest spec paths to a `page-not-found` 404 (a
    wrong path), not to a missing record.
    The one capped request (`sendApifyApiRequest`) and the detection of a body over `MAX_INLINE_BYTES`
    (`isMaxContentLengthAbort`) are in `../apify_client.ts`. The origin check (`isApifyApiUri`),
    the binary token mask (`maskSessionToken`), the secret redaction (`redactJsonSecrets`) and
    `REDACTED` are the API resource's own, imported from `../resources/api_resources.ts`
    ([`../resources/AGENTS.md`](../resources/AGENTS.md#api-resources-api_resourcests)).
    A request failure is thrown as `toPlainError` (`../utils/logging.ts`), without the axios config.
    The details and call tools log their arguments through `redactApiCallArgs` (`redactArgs`): an
    allowlist of path, method, query, and body, with the body and the `token`, `signature`, and
    `webhooks` query values redacted, and a query written into the path cut to `?[REDACTED]`.
  - `docs/` — search and fetch Apify docs.
  - `dev/` — the `report-problem` tool for reporting a problem with a tool or Actor.
  - `widgets/` — the `*-widget` tool variants (apps mode only).
  - `searchActorsBaseArgsSchema` has an optional `useCase` (Store search context). `withoutUseCaseField` in `utils/tools_loader.ts` removes it from the served schema; `ActorsMcpServer.composeToolsForClient` applies that for clients `isStoreUseCaseServable` does not allow. The call passes it to `searchAgentSafeActors`, which sanitizes it.
- `../utils/apify_resource_id.ts` holds the helpers that resolve an Actor, task, schedule, or storage given by
  ID or name, where a name alone means one of the caller's own. The task, schedule, and versions tools use them,
  and so do `build-actor` and the `actorId` filter of `get-actor-build-list` and `get-actor-run-list`. The
  dataset and key-value store tools reach them through `fetchStorageByIdOrName` in `storage/storage_helpers.ts`.

## Rules when editing here

- **Validate inputs with Zod**; no ad-hoc shape checks. AJV + Zod already validate
  before a tool runs — don't re-check the same constraint inside the tool body.
- **Reference tool names via the `HELPER_TOOLS` `as const` object**, never hardcoded strings
  (exception: the integration suite, `tests/integration/` and the shared `tests/test_kit/` cases and helpers, which hardcode them so a renamed tool fails).
- Keep a new tool mode-agnostic unless it is genuinely a widget variant.
- Descriptions, result text, annotations and the tool set follow [TOOL_GUIDELINES.md](../../TOOL_GUIDELINES.md); the gating mechanics below implement its "name only what the session has" rule.

**Storage tool description skeleton** (`storage/`, all 8 tools): lead sentence stating what the tool
returns, then a disambiguation line naming the sibling tool(s) it's confused with via
`${HELPER_TOOLS.X}` (never a hardcoded name), proportional caveats, then `USAGE:` (one or more
bullets) and `USAGE EXAMPLES:` (one or more `user_input:` bullets). Match this shape when touching
these files.

Exception: the `AUTO_INJECTED_TOOLS` (`../utils/tools_loader.ts`) — `get-actor-run`,
`get-dataset-items`, `get-key-value-store-record`, `abort-actor-run` — land in sessions that never
loaded their own category, so their disambiguation line must describe what they return instead of
naming a sibling — a name the client never received in `tools/list` invites a call to a tool that
does not exist. Any other cross-tool reference must be gated per session: define a
`buildDescription(ctx)` on the entry (see `ToolDescriptionContext` in `../types.ts`), wrap the
reference in `ctx.hasTool(...)`, and set `description` to the `ALL_TOOLS_PRESENT` render. Rendering
happens once, at the tools/list boundary (`getToolPublicFieldOnly` in `../utils/tools.ts`). Enforced
by `tests/unit/tools.mode_contract.test.ts`, which scans `description` only.

Input-schema field text (`.describe()` on a Zod field) reaches `tools/list` verbatim — nothing
renders it per session — so never name a tool there; put the guidance in `buildDescription` behind
`hasTool`. `actors/actor_tools_factory.ts`'s `waitSecs` is the one exception: an Actor tool always
auto-injects the `get-actor-run` it names.

Result text (`summary` / `nextStep` in `content[1]`) has no `hasTool`, but it does have a per-session
gate: `InternalToolArgs.loadedToolNames`. A `nextStep` that names a sibling tool goes through
`resolveSiblingNextStep` in `storage/storage_helpers.ts`. Name a tool there only through that gate,
or when it is the calling tool itself (the "call it again with the
next offset" pagination hint); otherwise leave the cross-tool guidance to the gated description.
An `AUTO_INJECTED_TOOLS` member is no exception — the injection is conditional on `call-actor`, an
Actor tool, or `get-actor-run` being loaded, so a session that loaded only `abort-actor-run` gets
none of them. The task and schedule tools name no tool, enforced by
`tests/unit/tools.actor_task_crud.test.ts` and `tests/unit/tools.schedule_crud.test.ts`; result text
elsewhere predates the gate, and `suggestTool` is the pattern to fix it with. Grep
`HELPER_TOOLS` outside `buildDescription` for the current set rather than trusting a list here.

**Result text is a second surface, and `hasTool` does not reach it.** A tool name in a response
body (`summary`, `nextStep`, `instructions`, an error's recovery sentence) is built while the tool
runs, not at the tools/list boundary, so nothing gates it for you and `tools.mode_contract.test.ts`
— which renders descriptions only — cannot see it. Gate it on `toolArgs.loadedToolNames`
(`InternalToolArgs` in `../types.ts`), the names the session was actually served: see
`suggestTool` in `storage/storage_helpers.ts` and the recovery hints in `actors/call_actor.ts`,
`actors/fetch_actor_details.ts` and `actors/search_actors.ts`. Two rules when the name drops out:
never leave a dead end — if the sentence *is* the recovery path, replace it rather than omit it
(`storage_helpers.ts` substitutes "Inspect the returned items directly") — and gate in place, so a
session holding every tool gets byte-identical text and gating a hint is never also a rewording
(`call_actor.ts` and `search_actors.ts` were gated that way; the reworded sentence in
`fetch_actor_details.ts` is a deliberate wording change that rode along with its gate, not the
pattern to copy). Each gate needs its own test; there is no sweeping guard for this surface.

## Related, owned elsewhere (don't restate)

- Tool-name cap + hash dedupe, transport: [`../mcp/AGENTS.md`](../mcp/AGENTS.md).
- Two-phase tool loading: [`../../DEVELOPMENT.md`](../../DEVELOPMENT.md).
- Naming / coding standards: [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md).

After any change here run the root [Verification](../../AGENTS.md) steps.
