# Development

## Overview

This repository (**public**) provides:
- The core MCP server implementation (published as an NPM package)
- The stdio entry point (CLI)
- An Express HTTP server for local development and testing

The hosted server (**[mcp.apify.com](https://mcp.apify.com)**) is implemented in an internal Apify repository that depends on this package.

For general information about the Apify MCP Server, features, tools, and client setup, see the [README.md](./README.md).

## Project structure (high-level)

```text
src/
  mcp/          MCP protocol implementation
  tools/        MCP tool implementations
  resources/    Resources and widgets metadata
  utils/        Shared utilities
  web/          React UI widgets (built into dist/web)
tests/
  unit/         Unit tests
  integration/  Integration tests
```

Key entry points:

- `src/index.ts` - Main library export (`ActorsMcpServer` class)
- `src/index_internals.ts` - Internal exports for testing / advanced usage
- `src/stdio.ts` - Standard input/output (CLI) entry point
- `src/dev_server.ts` - Express HTTP server for local development (`npm start`)
- `src/input.ts` - Input processing and validation

## Tool loading phases

Tool loading is intentionally split into two phases in [`src/utils/tools_loader.ts`](./src/utils/tools_loader.ts):

- `getActors()` — async, mode-agnostic. Fetches Actor metadata and preserves the caller's requested tool/actor selection without choosing any mode-dependent tool variants.
- `getToolsForServerMode()` — sync, mode-dependent. Takes the pre-fetched sources plus a resolved `ServerMode` and produces the concrete tool entries to expose to the client.
- `loadToolsFromInput()` in `tools_loader.ts` — convenience wrapper running both phases back-to-back with an explicit `ServerMode`. **Not to be confused with** `ActorsMcpServer.loadToolsFromInput()` (the public method), which queues sources when mode is still `'auto'` and registers them onto the server — call the server method from transport entry points, the plain function only when you already have a resolved mode.

This split matters for `serverMode: 'auto'`.

- Before `initialize`, the server does not yet know whether the client supports MCP Apps.
- Public preload helpers such as `ActorsMcpServer.loadToolsByName()` and `loadToolsFromUrl()` therefore queue mode-agnostic sources first.
- Actor tools may still be loaded immediately because they are mode-agnostic.
- During `initialize`, once client capabilities are known, the server resolves the queued sources into the final mode-dependent tool set.

Rule of thumb:

- If code may run before `initialize` in `auto` mode, it must stay in the mode-agnostic phase.
- Only code running after mode resolution should call `getToolsForServerMode()` or otherwise choose concrete mode-dependent tool variants.

## Node.js version policy

The minimum supported Node.js version is **20** (`engines.node >= 20` in `package.json`).

**Why Node.js 20:**

`@segment/analytics-node` (used for telemetry) declares `engines: { node: ">=20" }`, which makes Node.js 20 the hard floor for this package.

- The `.nvmrc` file pins the latest Node.js version for development tooling (lint, type-check, build) — this is intentionally higher than the minimum supported version.

## How to contribute

Refer to the [CONTRIBUTING.md](./CONTRIBUTING.md) file.

### Installation

```bash
npm install
cd src/web && npm install
```

### Working on the MCP Apps (ChatGPT Apps) UI widgets

Widget code lives in `src/web/` (a self-contained React project). Widgets are rendered based on tool output — to add data to a widget, modify the corresponding tool's return value.

> **UI mode:** Widget rendering requires the server to run in UI mode. Use `?ui=true` (e.g., `/mcp?ui=true`) or set `UI_MODE=true`.

See the [OpenAI Apps SDK documentation](https://developers.openai.com/apps-sdk) for background on MCP Apps and widgets.

### Production build

```bash
npm run build
```

Builds the core TypeScript project and `src/web/` widgets, then copies widgets into `dist/web/`. Required before running integration tests or the compiled server.

### Hot-reload development

```bash
APIFY_TOKEN='your-apify-token' npm run dev
```

Starts the web widgets builder in watch mode and the MCP server in standby mode on port `3001`. Editing `src/web/src/widgets/*.tsx` triggers a hot-reload — the next widget render uses updated code without restarting the server. Adding new widget filenames requires reconnecting the MCP client to pick them up.

- Get your `APIFY_TOKEN` from [Apify Console](https://console.apify.com/settings/integrations)
- Preview widgets via the local esbuild dev server at `http://localhost:3226/index.html`

The MCP server listens on port `3001`. The HTTP server implementation is in `src/dev_server.ts`. The hosted production server behind [mcp.apify.com](https://mcp.apify.com) is located in the internal Apify repository.

### Configuring APIFY_TOKEN for Claude Code

Create or edit `.claude/settings.local.json`:

```json
{
  "env": {
    "APIFY_TOKEN": "<YOUR_APIFY_API_TOKEN>"
  }
}
```

Restart Claude Code for the change to take effect. This token is picked up by both Claude Code MCP servers (defined in `.mcp.json`) and mcpc.

## Testing

| Layer | Command | What it covers |
|---|---|---|
| **Unit tests** | `npm run test:unit` | Individual modules in isolation — no credentials needed |
| **Integration tests** | `npm run test:integration` | Full server over all transports against real Apify API (requires `APIFY_TOKEN` + `npm run build`) |
| **mcpc probing** | `mcpc @stdio tools-call ...` | Interactive end-to-end verification during development |
| **LLM evals** | CI only — apply `validated` label | Runs `evals/run_evaluation.ts` against multiple models via OpenRouter; requires `PHOENIX_*` and `OPENROUTER_*` secrets |

To trigger the eval workflow on a PR, apply the **`validated`** label.
The workflow then runs automatically and posts results to Phoenix.
It also runs automatically on every merge to the `master` branch.

### Test structure

- `tests/unit/` — unit tests for individual modules
- `tests/integration/` — integration tests for MCP server functionality
  - `tests/integration/suite.ts` — **main integration test suite** where all test cases should be added
  - Other files in this directory set up different transport modes (stdio, SSE, streamable-http) that all use `suite.ts`
- `tests/helpers.ts` — shared test utilities
- `tests/const.ts` — test constants

### Live probing with mcpc

`mcpc` (`@apify/mcpc`) provides a CLI feedback loop against the local server.

#### Setup

```bash
npm install -g @apify/mcpc
npm run build
mcpc --config .mcp.json stdio connect @stdio
mcpc @stdio tools-list   # verify
```

#### Usage

Arguments use `key:=value` syntax (auto-parses as JSON):

```bash
mcpc @stdio tools-list
mcpc @stdio tools-call search-actors keywords:="web scraper" limit:=5
mcpc --json @stdio tools-call search-actors keywords:="scraper" | jq ‘.content[0].text’
```

**Key behaviors to verify:**
- `search-actors` — test valid keywords, empty keywords
- `fetch-actor-details` — test valid Actor, non-existent Actor
- `call-actor` — test with valid input; check async mode
- `get-actor-output` — test field filtering with dot notation, non-existent dataset
- `search-apify-docs` / `fetch-apify-docs` — test relevant and non-existent queries


### Testing with MCPJam (optional)

Run [MCPJam](https://www.mcpjam.com/) with `npx @mcpjam/inspector@latest`.

1. Click **"Add new server"**, enter URL `http://localhost:3001/mcp?ui=true`, select **"No authentication"**
2. **App Builder** — select a tool, fill arguments, execute, view rendered widget
3. **Chat** — add an OpenAI/Anthropic/OpenRouter API key to chat with widget rendering inline

### Testing with ChatGPT (optional)

Test widget rendering on [chatgpt.com](https://chatgpt.com) by exposing the local server via ngrok. See the [Apify ChatGPT integration docs](https://docs.apify.com/platform/integrations/chatgpt) for background.

The ngrok credentials are in **1Password**. The static domain `mcp-apify.ngrok.dev` is already set up — add to `~/.config/ngrok/ngrok.yml`:

```yaml
tunnels:
  app:
    addr: 3001
    proto: http
    domain: mcp-apify.ngrok.dev
```

Then start the tunnel:

```bash
ngrok start app
```

The MCP server API will be reachable at `https://mcp-apify.ngrok.dev/?ui=true`.

#### Adding the server in ChatGPT

1. Go to [chatgpt.com](https://chatgpt.com) and open **Settings → Connectors**
2. Click **"Add a custom connector"**
3. Enter the URL: `https://mcp-apify.ngrok.dev/?ui=true`
4. Save and start a new chat

> **Important:** After restarting ngrok, use the **Refresh** button in the connector settings to reconnect — ChatGPT does not detect the tunnel restart automatically.
