# ChatGPT MCP Apps Submission

Status: **In Progress**
Last updated: 2026-03-12

## Prerequisites

- [ ] Organization verification (individual or business) on [OpenAI Platform Dashboard](https://platform.openai.com/settings/organization/general)
- [ ] Owner role confirmed for submitting org member
- [x] MCP server publicly accessible at `https://mcp.apify.com/`
- [x] Not using local/testing endpoint
- [x] Content Security Policy (CSP) defined (`src/resources/widgets.ts:15-26`)
- [x] Authentication configured — Bearer token + OAuth2 (`src/server_card.ts:30-33`)

## Submission Form Fields

| Field | Status | Value |
|---|---|---|
| App name | Done | `Apify MCP server` |
| Logo | Done | `docs/apify-logo.png` |
| Short description | Done | "Extract data from any website with thousands of scrapers, crawlers, and automations on Apify Store" |
| Long description | Done | "Extract data from any website using thousands of tools from the Apify Store. Apify is the world's largest marketplace of tools for web scraping, data extraction, and web automation." |
| Privacy policy URL | Done | https://docs.apify.com/legal/privacy-policy |
| Company URL | Done | https://apify.com |
| MCP URL | Done | https://mcp.apify.com/ |
| Screenshots | TODO | Need ChatGPT-specific screenshots showing widgets in action |
| Test prompts & responses | TODO | Need 3-5 test cases (see below) |
| Localization / countries | TODO | Define target countries |

## Code Changes Needed

- [ ] Add explicit `destructiveHint: false` to ~19 read-only tools that currently omit it (should be explicit per OpenAI guidelines). Affected tools: all `get_*`, `search_*`, `fetch_*` in `src/tools/common/` and `src/tools/core/`.

## Tool Hint Annotations Audit

Per [OpenAI guidelines](https://developers.openai.com/apps-sdk/deploy/submission), tool annotations must match actual behavior.

### Correctly annotated (no changes needed)

| Tool | readOnlyHint | destructiveHint | openWorldHint | Rationale |
|---|---|---|---|---|
| `call-actor` (both modes) | false | true | true | Runs Actors that can modify external state |
| Dynamic Actor tools | false | true | true | Same as call-actor |
| `abort-actor-run` | false | true | false | Irreversible abort within Apify platform |
| `add-actor` | false | false | true | Reads from public Apify Store, modifies local tool list |
| `get-html-skeleton` | true | — | true | Reads from arbitrary external URLs via Actor |
| `search-actors` | true | — | false | Searches Apify Store (read-only) |
| `fetch-actor-details` | true | — | false | Reads Actor metadata |
| `get-actor-run` | true | — | false | Reads run status |
| `get-actor-output` | true | — | false | Reads dataset items |
| `get-dataset-items` | true | — | false | Reads dataset items |
| `get-dataset` | true | — | false | Reads dataset metadata |
| `get-dataset-schema` | true | — | false | Reads items for schema |
| `get-actor-run-log` | true | — | false | Reads run logs |
| `get-key-value-store-record` | true | — | false | Reads stored records |
| `get-key-value-store` | true | — | false | Reads store metadata |
| `get-key-value-store-keys` | true | — | false | Lists keys |
| `get-user-runs-list` | true | — | false | Lists runs |
| `get-user-datasets-list` | true | — | false | Lists datasets |
| `get-user-key-value-stores-list` | true | — | false | Lists stores |
| `search-apify-docs` | true | — | false | Searches documentation |
| `fetch-apify-docs` | true | — | false | Fetches documentation |

> **Note:** "—" in destructiveHint means the field is currently omitted and needs to be explicitly set to `false`.

## Privacy / PII Audit

- [x] No unnecessary PII in tool responses — tools return public resource IDs (runId, datasetId), not internal/private data
- [x] No session/trace/request IDs leaked — `mcpSessionId` is logging-only, never in tool responses
- [x] API tokens never exposed in responses — used internally only
- [x] Skyfire tokens redacted in logs (`src/utils/logging.ts:56-80`)
- [ ] Verify privacy policy explicitly covers all data categories returned by tools (run metadata, dataset items, Actor details)

## Widgets

| Widget | URI | ChatGPT Status | Mobile Status |
|---|---|---|---|
| Search Actors | `ui://widget/search-actors.html` | Confirmed working | TODO |
| Actor Run | `ui://widget/actor-run.html` | TODO | TODO |

- [x] CSP configured for all widgets (`api.apify.com`, `mcp.apify.com`, image CDNs, Google Fonts)
- [x] Pure MCP Apps SDK — no legacy `window.openai` fallbacks
- [x] `openai/toolInvocation/*` UX hints configured (invoking/invoked messages)
- [x] `openai/outputTemplate` intentionally NOT included (breaks MCP Apps renderer detection in MCP Jam)

## Test Cases (TODO)

Need to prepare test prompts with expected responses. Suggested cases:

### Test 1: Search for Actors
- **Prompt:** "Find web scraping tools on Apify"
- **Expected:** Search widget renders with list of relevant Actors (web scraping category)
- **Tools invoked:** `search-actors`

### Test 2: Get Actor details
- **Prompt:** "Tell me about the apify/web-scraper Actor"
- **Expected:** Actor name, description, pricing, input schema summary
- **Tools invoked:** `fetch-actor-details`

### Test 3: Run an Actor
- **Prompt:** "Scrape the homepage of https://example.com using apify/web-scraper"
- **Expected:** Actor Run widget shows run progress, completes with results
- **Tools invoked:** `call-actor` (or dynamic Actor tool)

### Test 4: Get run results
- **Prompt:** "Show me the results from my last run"
- **Expected:** Dataset items displayed
- **Tools invoked:** `get-user-runs-list`, `get-actor-output`

### Test 5: Abort a run
- **Prompt:** "Stop the currently running Actor"
- **Expected:** Run aborted, confirmation message
- **Tools invoked:** `abort-actor-run`

## Common Rejection Reasons (from OpenAI docs)

Watch out for these during testing:

1. **MCP server unreachable** — Ensure `https://mcp.apify.com/` is stable and reachable
2. **Test credentials don't work** — If OAuth is used, provide demo account without MFA
3. **Test cases produce wrong results** — Verify all test cases pass on both web AND mobile
4. **Undisclosed data types in privacy policy** — Audit all tool responses for user-related fields
5. **Tool annotations don't match behavior** — Already audited above, need to add missing `destructiveHint: false`

## Architecture Notes

- Server runs as Apify Actor with Streamable HTTP transport
- Public URL: `https://mcp.apify.com/`
- Package: `@apify/actors-mcp-server` (v0.9.8)
- Server card: SEP-1649 compliant
- Widget metadata: MCP Apps standard (SEP-1865)
- ChatGPT connects with `ui=openai` server mode
- `stripWidgetMeta()` removes `openai/*` and `ui` keys in non-OpenAI mode
