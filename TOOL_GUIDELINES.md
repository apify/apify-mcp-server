# Tool guidelines

Rules for everything the model receives from this server: tool descriptions, Zod `.describe()` text,
server instructions, result text, `structuredContent` (`summary`, `nextStep`, `instructions`), error
messages, widget text, resource bodies, tool annotations and the tool set itself. Client directories
review all of it against public policies
([Anthropic policy](https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy),
[Anthropic checklist](https://claude.com/docs/connectors/building/review-criteria),
[OpenAI guidelines](https://developers.openai.com/apps-sdk/app-developer-guidelines)), and one
sentence can block a listing. Every configuration of this server must pass them.

## Describe, don't command

- Never instruct the model to make a tool call the user did not ask for. Not this tool again
  ("always do two searches", "retry with broader keywords"), not another tool ("retry the URL with
  `apify/web-fetch`", "name it via `apify-api-write`"). Say what a parameter does instead:
  "`unnamed=true` includes unnamed storages" is a fact, "call again with `unnamed=true`" is a command.
- Fit guidance is fine: "use `apify/web-fetch` when the user gives a URL", "broad keywords usually
  return more matches". So is a pagination hint on a truncated result (same tool, next offset): it
  completes the request the user made.
- Emphasis and presentation instructions are fine ("IMPORTANT: present URLs exactly as returned")
  as long as they do not trigger a call.
- No marketing claims or comparisons, and nothing asking the model to disregard legality, ethics,
  permissions or robots.txt. Use neutral registry wording.
- Description, parameter text and response text agree with each other and with actual behavior.
  A description never promises something the session cannot do.

## Name only what the session has

- Never name a tool the session was not served. Descriptions gate with `ctx.hasTool`, result text
  with `loadedToolNames`. Conditional prose ("when available") is not a gate. Mechanics:
  [src/tools/AGENTS.md](./src/tools/AGENTS.md).
- Gate in place: a session that holds every tool gets byte-identical text.
- When no general Actor-running tool is loaded, discovery responses say the Actor cannot be run in
  this configuration. The only remedy to offer is "create your own Apify MCP server configuration at
  https://mcp.apify.com and add it to your agent" (`getOwnServerRemedy`). Tool descriptions and
  instructions say "add it to Claude as a custom connector" for `?client=claude`; tool results keep
  the neutral wording. No `?tools=` instructions and no Actor page links in served text.

## Never return a secret

- Strip or redact credentials on every surface: `urlSigningSecretKey`, the proxy password, bearer
  and session tokens, in text, `structuredContent`, `resources/read` and the generic API tools.
  Pre-signed URLs may stay.
- Pick response fields explicitly. Never pass a raw API client object through as `structuredContent`.
- Return only what the request needs and paginate the rest. Errors are specific and actionable,
  never a bare status.

## Tool surface

- The tool set is a pure function of the `tools` / `actors` selection. Client name, `?client=`,
  `clientInfo` or capabilities may only shrink it (the non-widget subset), never add to it.
  A new auto-injected tool changes every pinned URL, so don't add one.
- `tools.listChanged` is neither declared nor emitted.
- Exception: `search-actors` and its widget have an optional `useCase` argument (not a tool) that `withoutUseCaseField` removes from the served schema for clients `isStoreUseCaseServable` does not allow.
- Read and write operations are separate tools; a generic write tool stays out of every selectable
  category. A tool that takes freeform paths or bodies names the target API in its description.
- A minimal valid call must succeed: never require an input that has a default.

## Annotations

- Every tool has `title` and explicit `readOnlyHint`, `destructiveHint` and `openWorldHint`.
  `readOnlyHint: true` only for pure reads. `destructiveHint: true` for delete, overwrite, cancel
  and abort. A tool that is not safe to retry says so (starting a paid run). Names stay ≤ 64 chars.

## Changing tool text

- A change to tool text is a contract change. Say so in the PR, update the unit tests that pin the
  text, and rerun evals when the string was eval-tuned; note the delta.
- The pinned-configuration test (`tests/unit/helpers/claude_connector_tools.ts`) keeps its names
  literal, so any growth of that surface fails a test instead of a review.
