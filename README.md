<p align="center">
    <a href="https://mcp.apify.com">
        <img alt="Apify MCP server" src="docs/apify-mcp-server-header.png" width="100%">
    </a>
</p>
<p align="center">
    <a href="https://mcp.apify.com"><img src="https://img.shields.io/badge/Any_MCP_client-Get_config-F86606?style=for-the-badge&logo=modelcontextprotocol&logoColor=white" alt="Get the config for any MCP client" height="32"></a>
</p>
<p align="center">
    <a href="https://www.npmjs.com/package/@apify/actors-mcp-server"><img src="https://img.shields.io/npm/v/@apify/actors-mcp-server.svg" alt="npm version"></a>
    <a href="https://www.npmjs.com/package/@apify/actors-mcp-server"><img src="https://img.shields.io/npm/dm/@apify/actors-mcp-server.svg" alt="npm downloads"></a>
    <a href="https://github.com/apify/apify-mcp-server/actions/workflows/on_master.yaml"><img src="https://github.com/apify/apify-mcp-server/actions/workflows/on_master.yaml/badge.svg?branch=master" alt="CI status"></a>
    <a href="./LICENSE.md"><img src="https://img.shields.io/github/license/apify/apify-mcp-server" alt="MIT license"></a>
    <a href="https://github.com/apify/apify-mcp-server/stargazers"><img src="https://img.shields.io/github/stars/apify/apify-mcp-server?style=social" alt="GitHub stars"></a>
    <a href="https://discord.apify.com"><img src="https://img.shields.io/badge/Discord-Join_the_community-5865F2?logo=discord&logoColor=white" alt="Apify Discord"></a>
</p>

# Apify MCP server

Connect your AI agent to the largest marketplace of web automation tools.

**The official Apify Model Context Protocol (MCP) server gives AI agents web scraping, data extraction, and browser automation through thousands of ready-made Actors from [Apify Store](https://apify.com/store), at [`https://mcp.apify.com`](https://mcp.apify.com).**

Apify is the marketplace of ready-to-run tools for AI agents. One connection to the Apify MCP server gives your agent thousands of tools to choose from, for jobs like web fetch, SERP monitoring, lead generation and enrichment, and pulling data from e-commerce sites and social media. The server loads only what each task needs.

An agent connected to the server can search Apify Store for the right Actor, read its input schema and pricing, run it, and read the structured results. It can also search the Apify documentation. The hosted server uses Streamable HTTP with OAuth, so most clients connect with the URL alone. You can also run it locally over stdio with the [`@apify/actors-mcp-server`](https://www.npmjs.com/package/@apify/actors-mcp-server) npm package.

<img alt="Diagram: AI agents such as Claude, ChatGPT, Cursor, Grok Bot, Hermes Agent, and OpenCode connect to the Apify MCP server, which searches Apify Store, runs Actors like Web Search, Web Fetch, and Google Maps Scraper, and returns structured results" src="docs/apify-mcp-server-diagram.png">

<!-- TODO: add the new setup video here once it is published. The old 2025 Claude tutorial (BKu8H91uCTg) was removed as outdated. -->

## Contents

- [Quickstart](#-quickstart)
- [Set up your client](#-set-up-your-client)
- [Hosted or local server](#hosted-or-local-server)
- [How an agent uses Apify Actors](#how-an-agent-uses-apify-actors)
- [Available tools](#-available-tools)
- [Choose which tools load](#choose-which-tools-load)
- [Example prompts](#-example-prompts)
- [Pricing and limits](#-pricing-and-limits)
- [Agentic payments (experimental)](#agentic-payments-experimental)
- [Other Apify tools for agents](#other-apify-tools-for-agents)
- [Telemetry](#telemetry)
- [Troubleshooting and limitations](#-troubleshooting-and-limitations)
- [FAQ](#-faq)
- [Development](#-development)
- [Contributing](#contributing)

## 🚀 Quickstart

1. Open the [MCP configurator](https://mcp.apify.com), pick your client, and choose the tools you want.
2. Copy the generated configuration, deeplink, or command into your client.
3. Sign in to Apify in the browser window that opens. If you don't have an account, you can create a free one there.

The hosted endpoint is `https://mcp.apify.com`. If your client can't use OAuth, send your [Apify API token](https://docs.apify.com/integrations/api#api-token) in an `Authorization: Bearer <APIFY_TOKEN>` header instead. Treat the token like a password: keep it out of shared config files and repositories.

> **Migrating from SSE?** The legacy `https://mcp.apify.com/sse` endpoint has been removed. Drop the `/sse` suffix from your configuration and connect to `https://mcp.apify.com` over Streamable HTTP.

Using a coding agent such as Claude Code, Codex, Cursor, or GitHub Copilot? An [official Apify plugin](https://docs.apify.com/agents/plugins) installs this MCP server together with [Agent Skills](https://docs.apify.com/agents/skills) in one step.

## 🤖 Set up your client

The [configurator](https://mcp.apify.com) generates the exact setup for each supported client, including Claude, Claude Code, Claude Desktop, ChatGPT, Codex, Cursor, VS Code, GitHub Copilot CLI, OpenCode, Kiro, and more. Configuration formats differ between clients, so start there when in doubt. The snippets below cover the most common cases.

![The MCP configurator at mcp.apify.com, listing supported MCP clients](docs/mcp-configurator.png)

<details>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add apify "https://mcp.apify.com" -t http
```

Claude Code opens the Apify sign-in page the first time it uses the server. To install the [Apify plugin](https://docs.apify.com/agents/plugins) with Agent Skills instead, run `/plugin marketplace add apify/apify-claude-code-plugin`, then `/plugin install apify@apify` and `/reload-plugins`.

</details>

<details>
<summary><b>Cursor</b></summary>

Use the one-click install link from the [configurator](https://mcp.apify.com), or let the [Apify CLI](https://docs.apify.com/cli) write the configuration for you:

```bash
apify mcp install cursor
```

The same command works for `claude-code`, `vscode`, `codex`, `kiro`, and `antigravity`.

</details>

<details>
<summary><b>VS Code and GitHub Copilot</b></summary>

Use the one-click install link from the [configurator](https://mcp.apify.com), run `apify mcp install vscode`, or add `https://mcp.apify.com` as an HTTP server in your MCP configuration:

```json
{
  "servers": {
    "apify": {
      "type": "http",
      "url": "https://mcp.apify.com"
    }
  }
}
```

</details>

<details>
<summary><b>Claude.ai, Claude Desktop, and ChatGPT</b></summary>

**Claude.ai and Claude Desktop:** open **Settings** > **Connectors**, select **Add custom connector**, name it `Apify`, and enter `https://mcp.apify.com` as the remote MCP server URL. The same connector works in both apps. See the [Claude guide](https://docs.apify.com/integrations/claude-desktop).

**ChatGPT:** turn on Developer mode, then go to **Settings** > **Apps & Connectors** > **Create** and enter `https://mcp.apify.com` as the MCP server URL with OAuth authentication. You don't need a client ID or secret. See the [ChatGPT guide](https://docs.apify.com/integrations/chatgpt).

</details>

<details>
<summary><b>Any other MCP client (JSON config)</b></summary>

Most clients that support remote servers and OAuth accept a configuration like this:

```json
{
  "mcpServers": {
    "apify": {
      "url": "https://mcp.apify.com"
    }
  }
}
```

</details>

<details>
<summary><b>Local stdio (npx)</b></summary>

Requires Node.js 22 or later.

```json
{
  "mcpServers": {
    "actors-mcp-server": {
      "command": "npx",
      "args": ["-y", "@apify/actors-mcp-server"],
      "env": {
        "APIFY_TOKEN": "YOUR_APIFY_TOKEN"
      }
    }
  }
}
```

If you've run `apify login`, the server can also read the token saved by the Apify CLI. Run `npx @apify/actors-mcp-server --help` for all options.

</details>

The server is also listed in the [Docker MCP catalog](https://hub.docker.com/mcp/server/apify-mcp-server/overview), and each [release](https://github.com/apify/apify-mcp-server/releases/latest) ships an MCP bundle file ([`apify-mcp-server.mcpb`](https://github.com/apify/apify-mcp-server/releases/latest/download/apify-mcp-server.mcpb)) for one-click installation in clients that support it.

## Hosted or local server

The hosted server is the recommended option. Use the local server when your client only supports stdio or you need to run everything on your own machine.

| | Hosted (`https://mcp.apify.com`) | Local (`npx @apify/actors-mcp-server`) |
| :--- | :--- | :--- |
| Transport | Streamable HTTP | stdio |
| Authentication | OAuth or Bearer token | `APIFY_TOKEN` environment variable or Apify CLI login |
| Output schemas inferred for Actor results | Yes | No |
| Tool selection | `tools` URL parameter | `--tools` flag or `TOOLS` environment variable |
| Updates | Always the latest server | The npm version you install |

## How an agent uses Apify Actors

[Actors](https://docs.apify.com/actors) are serverless programs on the Apify platform. Each one does a specific job, like scraping Google Maps, crawling a website for RAG, or collecting social media posts. The MCP server turns Actors into tools an agent can find and call without you configuring each one in advance.

A typical task follows four steps:

1. `search-actors` finds candidate Actors in Apify Store for the task.
2. `fetch-actor-details` returns the Actor's input schema, README, pricing, and output schema.
3. `call-actor` starts the run and waits up to 45 seconds for it to finish. It returns the **run status and storage IDs**. The scraped items stay in the run's dataset.
4. `get-dataset-items` reads the results from the run's dataset, with `limit` and `offset` for pagination.

The server adds `get-dataset-items`, `get-key-value-store-record`, `get-actor-run`, and `abort-actor-run` automatically whenever `call-actor` or an Actor tool is loaded, so the default setup can always read results. Long runs keep going after `call-actor` returns; the agent checks on them with `get-actor-run`.

You can also expose a specific Actor as its own tool, for example `apify/web-search` or `apify/instagram-scraper`. The server builds the tool's parameters from the Actor's input schema, so the agent knows exactly what to pass.

**Actors that run their own MCP server.** Some Actors are MCP servers themselves. `call-actor` reaches their tools with the `actorName:toolName` format. When such an Actor is loaded as a tool source, its tools are exposed under names in the form `username--actor-name--tool-name`.

**Official server and community Actors.** This repository is the official MCP server, maintained by the Apify team. Apify Store also lists MCP-related Actors published by independent creators. Those are separate products with their own READMEs and pricing.

## 🧰 Available tools

By default, the server loads the `actors` and `docs` categories, a small set of web Actor tools including [Web Fetch](https://apify.com/apify/web-fetch), and `report-problem`. Everything else is opt-in by category or by tool name. [Web Search](https://apify.com/apify/web-search) pairs with Web Fetch: with both loaded, the agent searches the web and then fetches the pages it picks. The [tool reference](https://docs.apify.com/mcp#available-tools) lists the current default Actors.

| Category | Tools | Loaded by default |
| :--- | :--- | :---: |
| `actors` | `search-actors`, `fetch-actor-details`, `call-actor` | ✅ |
| `docs` | `search-apify-docs`, `fetch-apify-docs` | ✅ |
| Actor tools | [Web Search](https://apify.com/apify/web-search), [Web Fetch](https://apify.com/apify/web-fetch), or any other Actor you add | ✅ (default web Actors) |
| `runs` | `get-actor-run`, `get-actor-run-list`, `get-actor-run-log`, `abort-actor-run` | Partly, auto-added |
| `storage` | `get-dataset-items`, `get-dataset`, `get-dataset-list`, `get-dataset-schema`, `get-key-value-store`, `get-key-value-store-keys`, `get-key-value-store-list`, `get-key-value-store-record` | Partly, auto-added |
| `tasks` | Create, read, update, publish, and unpublish saved Actor tasks | |
| `schedules` | Create, read, update, and delete schedules | |
| `builds` | `build-actor`, `get-actor-build`, `get-actor-build-list`, `get-actor-build-log` | |
| `versions` | Read and write Actor source files, and create Actors and versions from files | |
| `api` | `apify-api-search`, `apify-api-details`, `apify-api-read`, `apify-api-write` | |
| `dev` | `report-problem` | ✅ (see note) |
| By name only | `get-actor-list`, `delete-actor` | |

Notes:

- `report-problem` is served by default only when telemetry is on, and it's withheld from Claude clients unless you select it explicitly with `tools=report-problem` or `tools=dev`.
- The `tasks` category manages saved [Actor tasks](https://docs.apify.com/actors/running/tasks) (reusable Actor configurations). It is unrelated to the MCP Tasks protocol.
- Every tool carries MCP annotations: a `title`, `readOnlyHint` for tools that only read data, and `openWorldHint` for tools that reach outside the Apify platform. Actor tools are marked read-only only for Apify-maintained Actors with limited permissions and no inputs that can write data or run code.
- The server advertises the `prompts` capability but registers no prompts. It supports `resources/read` for any Apify API GET URL (`https://api.apify.com/v2/...`), with response bodies inlined up to 256 KB, and lists the common URL shapes in `resources/templates/list`.
- In clients that support MCP Apps, tools such as `search-actors` can return interactive widgets. The server turns widgets on when the client supports them; set `ui=false` (hosted) or `--ui false` (local) to turn widgets off, or `ui=true` to force them on.

The [tool reference](https://docs.apify.com/mcp#available-tools) has full descriptions of each tool.

## Choose which tools load

The `tools` parameter takes categories, tool names, and Actor names, separated by commas. When you set it, only what you list is loaded and the defaults are dropped. The easiest way to build a selection is the [configurator](https://mcp.apify.com).

Hosted server:

```text
https://mcp.apify.com?tools=actors,docs,apify/web-search,apify/web-fetch
```

Local server:

```bash
npx @apify/actors-mcp-server --tools actors,docs,apify/web-search,apify/web-fetch
```

To give an agent exactly one Actor and nothing else, list only that Actor:

```text
https://mcp.apify.com?tools=apify/instagram-scraper
```

> **Pin your tools in production.** The default tool set can change between versions. Set `tools` explicitly if you need a stable interface.

<details>
<summary><b>Backward compatibility with older configurations</b></summary>

- The `actors` URL parameter and `--actors` flag still work. They're merged into `tools`, so `?actors=apify/web-fetch` equals `?tools=apify/web-fetch`.
- `enableAddingActors`, `enable-adding-actors`, and `enableActorAutoLoading` were removed and are ignored. Dynamic Actor calls come from `call-actor`, which the default `actors` category includes.
- The selectors `add-actor`, `experimental`, and `preview` are retired and load nothing. Use `call-actor` or the `actors` category.
- `get-actor-log` was renamed to `get-actor-run-log`, and the `source` category to `versions`. The old names load nothing.

</details>

## 💬 Example prompts

**Search the web.**

> Find the latest news about autonomous AI agents and summarize the key developments.

The agent uses Web Search to find recent pages and Web Fetch to read them as Markdown, then summarizes what it found.

**Find and run an Actor.**

> Find an Actor that scrapes Google Maps. Show me its required input and pricing, then get the top 10 restaurants in Prague with their contact details.

The agent searches Apify Store, reads the Actor's details, confirms the input, runs it with `call-actor`, and reads the results with `get-dataset-items`.

**Page through results.**

> Show me the next 10 results from that run.

The agent calls `get-dataset-items` again with the same dataset ID and a higher `offset`.

## 💰 Pricing and limits

- Connecting to the MCP server is free. Actor runs bill to your Apify account according to each Actor's pricing, which `fetch-actor-details` shows before a run. The [Apify free plan](https://apify.com/pricing) includes $5 of monthly platform usage.
- To cap what a single run can cost, the agent can pass limits such as `maxItems`, `timeout`, `memory`, and `maxTotalChargeUsd` in the `callOptions` of `call-actor`.
- The hosted server accepts up to 30 requests per second per account.
- For security, the server excludes [full-permission Actors](https://docs.apify.com/actors/running/permissions#full-permission-actors) from search and execution, because running one is a decision you should approve yourself. Rental Actors are also excluded from search.
- Some tools work without an Apify account: `search-actors`, `fetch-actor-details`, `search-apify-docs`, `fetch-apify-docs`, `apify-api-search`, and `apify-api-details`. Select only those, for example `https://mcp.apify.com?tools=search-actors`, and the hosted server accepts the connection without a token.

## Agentic payments (experimental)

Autonomous agents can pay for Actor runs without signing up for an Apify account. This feature is experimental, and its terms can change. The [agentic payments documentation](https://docs.apify.com/agents/payments) is the source of truth for supported methods, minimums, and expiry.

- **AGI (recommended).** [agi.apify.com](https://agi.apify.com) sells a prepaid, spend-capped Apify API token for an x402 or MPP payment. The agent then uses it as a normal Bearer token against `mcp.apify.com` and works with any Actor. Protocol details are in [agi.apify.com/AGENTS.md](https://agi.apify.com/AGENTS.md).
- **Direct x402.** Add `payment=x402` to the server URL and pay per request with USDC on [Base](https://base.org) from an x402-capable client such as [`mcpc`](https://github.com/apify/mcpc). This works only with Pay Per Event Actors.
- **Skyfire.** Add `payment=skyfire` to the server URL and pass a [Skyfire](https://www.skyfire.xyz/) PAY token with each call. This works only with Pay Per Event Actors. See the [Skyfire integration guide](https://docs.apify.com/integrations/skyfire).

Payment-only sessions can't read Apify API resources, because those reads require an Apify token.

## Other Apify tools for agents

| Resource | Use it for |
| :--- | :--- |
| [MCP configurator](https://mcp.apify.com) | Client setup and tool selection |
| [MCP documentation](https://docs.apify.com/mcp) | Authentication, tool reference, and advanced configuration |
| [Apify for AI agents](https://docs.apify.com/agents) | Choosing between MCP, plugins, Agent Skills, the CLI, and machine-readable docs |
| [Official plugins](https://docs.apify.com/agents/plugins) | One-step install of the MCP server and Agent Skills for your coding agent |
| [Agent Skills](https://docs.apify.com/agents/skills) | Guided multi-step workflows, installed with `npx skills add apify/agent-skills` |
| [Apify CLI](https://docs.apify.com/cli) | Running and building Actors from a terminal, and `apify mcp install` |
| [Agentic payments](https://docs.apify.com/agents/payments) | Paying for runs without an account (experimental) |

## Telemetry

The server collects telemetry about tool calls to help the Apify team understand usage and improve the service. Telemetry is on by default. With telemetry on, Apify Store searches send the MCP session ID as `_traceId`, and tool-call events carry it as `trace_id`. The local stdio server also reports errors to [Sentry](https://sentry.io).

Turning telemetry off disables all of this, including Sentry:

```text
# Hosted server
https://mcp.apify.com?telemetry-enabled=false
```

```bash
# Local server: CLI flag (takes precedence) or environment variable
npx @apify/actors-mcp-server --telemetry-enabled=false
TELEMETRY_ENABLED=false npx @apify/actors-mcp-server
```

## 🐛 Troubleshooting and limitations

- **The local server won't start.** Check your Node.js version: the package requires Node.js 22 or later.
- **The client can't connect to `/sse`.** That endpoint was removed. Use `https://mcp.apify.com`.
- **Authentication fails.** Reconnect so the client repeats the OAuth flow, or switch to a Bearer token. For the local server, check that `APIFY_TOKEN` is set in the client's server configuration, not only in your shell.
- **Tools are missing.** If you set `tools`, only what you listed is loaded. Remove the parameter to get the defaults back.
- **Client features vary.** Any MCP client can connect, but support for dynamic tool lists, OAuth, and MCP Apps differs between clients.
- **Invalid Actor input.** When `call-actor` fails because of invalid input, the error includes the Actor's input schema so the agent can correct the input and retry.

The server adapts Actor input schemas so that more clients and models can use them:

- Descriptions longer than 500 characters are cut at the last complete sentence and marked `[Description truncated]`.
- Enums are kept in full up to 2,000 combined characters. Larger enums are replaced by a short note with example values.
- Required fields get a `REQUIRED` prefix in their descriptions for frameworks that ignore the JSON Schema `required` list.
- Nested properties are built for special inputs such as proxy configuration and request lists.
- Missing array item types are inferred from the item type, the prefill, the default value, or the editor type, in that order.
- Enum values and examples are copied into descriptions so clients with partial JSON Schema support still see them.

For more help, see the [MCP documentation](https://docs.apify.com/mcp) or [open an issue](https://github.com/apify/apify-mcp-server/issues).

## ❓ FAQ

**What is the Apify MCP server?**
It's the official [Model Context Protocol](https://modelcontextprotocol.io) server for Apify. It lets AI agents search Apify Store, run Actors for web scraping, data extraction, and browser automation, and read the structured results.

**When is it a good MCP server for web scraping?**
When an agent needs data from many different sites. A typical case is Google Maps one day, Instagram or an online store the next. The agent picks a ready-made Actor for each site from Apify Store instead of you writing and maintaining a scraper. Actors run on the Apify platform, which handles scaling, proxies, and storage of the results.

**Can ChatGPT or Claude scrape websites with it?**
Yes. Connect ChatGPT, Claude.ai, Claude Desktop, or Claude Code to `https://mcp.apify.com`, then ask in plain language. The model searches for a suitable Actor, runs it, and reads the results.

**Is it free?**
Connecting is free, and some discovery tools work without an account. Actor runs bill to your Apify account at each Actor's price, and the free plan includes $5 of monthly platform usage.

**Which clients does it work with?**
Any MCP client that supports Streamable HTTP or stdio. The [configurator](https://mcp.apify.com) has tailored setup for Claude, Claude Code, ChatGPT, Codex, Cursor, VS Code, GitHub Copilot, OpenCode, Kiro, and more.

**Do I need an API token?**
Not with the hosted server, because OAuth signs you in through the browser. The local server needs `APIFY_TOKEN` or an Apify CLI login.

**Does `call-actor` return the scraped data?**
No. It returns the run status and storage IDs. The agent reads the items with `get-dataset-items`, which the server loads automatically.

**Can I limit what the agent can do or spend?**
Yes. Select tools with the `tools` parameter, expose a single Actor, and pass `maxTotalChargeUsd` or `maxItems` in `call-actor` options.

## 🔧 Development

This repository contains the open-source server package published to npm as [`@apify/actors-mcp-server`](https://www.npmjs.com/package/@apify/actors-mcp-server). The hosted service at mcp.apify.com runs on this core logic from a separate private repository.

You need Node.js 22 or later and pnpm.

```bash
pnpm install
pnpm run build
pnpm run dev              # Streamable HTTP server with hot reload on http://localhost:3001
pnpm run inspector:stdio  # MCP Inspector against the stdio server
```

The development HTTP server doesn't read `APIFY_TOKEN` from the environment. Pass your token in an `Authorization: Bearer` header or a `?token=` query parameter, for example from the [MCP Inspector](https://github.com/modelcontextprotocol/inspector).

To publish a canary build of a pull request to [pkg.pr.new](https://pkg.pr.new/), add the `beta` label to it.

[DEVELOPMENT.md](./DEVELOPMENT.md) covers the project structure, tool loading phases, the Node.js version policy, and testing.

## Contributing

Bug reports, feature requests, and documentation fixes are welcome. A precise issue with a reproduction helps the Apify team more than a pull request.

- **Report a bug:** [open an issue](https://github.com/apify/apify-mcp-server/issues) with steps to reproduce it.
- **Propose a feature:** [open an issue](https://github.com/apify/apify-mcp-server/issues) describing the problem and who runs into it.
- **Code:** work only on an issue a maintainer has invited you to pick up. Unsolicited pull requests are closed.
- **Documentation:** send typos, broken links, and wrong commands straight to a pull request.

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before you start, including the rules for [AI-assisted contributions](./CONTRIBUTING.md#ai-assisted-contributions).

## Privacy and license

Requests and Actor inputs go to the Apify API to run the Actors you call. Apify doesn't share them with third parties beyond what running those Actors requires. See [Apify legal documents](https://docs.apify.com/legal) for details on data collection and retention.

The project is licensed under the [MIT license](./LICENSE.md).

## Learn more

- [Model Context Protocol](https://modelcontextprotocol.io)
- [MCP for beginners](https://blog.apify.com/mcp-for-beginners/)
- [How to use MCP with Apify Actors](https://blog.apify.com/how-to-use-mcp/)
- [What are AI agents?](https://blog.apify.com/what-are-ai-agents/)
- [How to build and monetize an AI agent on Apify](https://blog.apify.com/how-to-build-an-ai-agent/)
- [Webinar: Building and monetizing MCP servers on Apify](https://www.youtube.com/watch?v=w3AH3jIrXXo)
