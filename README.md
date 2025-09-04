<h1 align="center">
    <a href="https://mcp.apify.com">
        <picture>
            <source media="(prefers-color-scheme: dark)" srcset="docs/apify_mcp_server_dark_background.png">
            <img alt="Apify MCP Server" src="docs/apify_mcp_server_white_background.png" width="500">
        </picture>
    </a>
    <br>
    <small><a href="https://mcp.apify.com">mcp.apify.com</a></small>
</h1>

<p align=center>
    <a href="https://www.npmjs.com/package/@apify/actors-mcp-server" rel="nofollow"><img src="https://img.shields.io/npm/v/@apify/actors-mcp-server.svg" alt="NPM latest version" data-canonical-src="https://img.shields.io/npm/v/@apify/actors-mcp-server.svg" style="max-width: 100%;"></a>
    <a href="https://www.npmjs.com/package/@apify/actors-mcp-server" rel="nofollow"><img src="https://img.shields.io/npm/dm/@apify/actors-mcp-server.svg" alt="Downloads" data-canonical-src="https://img.shields.io/npm/dm/@apify/actors-mcp-server.svg" style="max-width: 100%;"></a>
    <a href="https://github.com/apify/actors-mcp-server/actions/workflows/check.yaml"><img src="https://github.com/apify/actors-mcp-server/actions/workflows/check.yaml/badge.svg?branch=master" alt="Build Status" style="max-width: 100%;"></a>
    <a href="https://apify.com/apify/actors-mcp-server"><img src="https://apify.com/actor-badge?actor=apify/actors-mcp-server" alt="Actor runs" style="max-width: 100%;"></a>
</p>

The Apify Model Context Protocol (MCP) Server at **mcp.apify.com** instantly connects AI applications and agents to thousands of ready‑built tools. It allows your AI assistant to use any [Apify Actor](https://apify.com/store) for web scraping, data extraction, and automation tasks in real time.

> **🚀 Try the hosted Apify MCP Server!**
>
> For the easiest setup and most powerful features, including the ability to find and use any Actor from Apify Store, connect your AI assistant to our hosted server:
>
> **[`https://mcp.apify.com`](https://mcp.apify.com)**
>
> It supports OAuth, so you can connect from clients like Claude.ai or Visual Studio Code with just the URL.

![Apify-MCP-server](docs/actors-mcp-server.png)

## Table of Contents
- [🌐 Introducing the Apify MCP server](#-introducing-the-apify-mcp-server)
- [🚀 Quickstart](#-quickstart)
- [🤖 MCP clients and examples](#-mcp-clients-and-examples)
- [🪄 Try Apify MCP instantly](#-try-apify-mcp-instantly)
- [🛠️ Tools, resources, and prompts](#-tools-resources-and-prompts)
- [🐛 Troubleshooting (local MCP server)](#-troubleshooting-local-mcp-server)
- [⚙️ Development](#-development)
- [🤝 Contributing](#-contributing)
- [📚 Learn more](#-learn-more)

# 🌐 Introducing the Apify MCP server

The Apify MCP Server allows an AI assistant to use any [Apify Actor](https://apify.com/store) as a tool to perform a specific task.
For example, it can:
- Use [Facebook Posts Scraper](https://apify.com/apify/facebook-posts-scraper) to extract data from Facebook posts from multiple pages/profiles.
- Use [Google Maps Email Extractor](https://apify.com/lukaskrivka/google-maps-with-contact-details) to extract contact details from Google Maps.
- Use [Google Search Results Scraper](https://apify.com/apify/google-search-scraper) to scrape Google Search Engine Results Pages (SERPs).
- Use [Instagram Scraper](https://apify.com/apify/instagram-scraper) to scrape Instagram posts, profiles, places, photos, and comments.
- Use [RAG Web Browser](https://apify.com/apify/web-scraper) to search the web, scrape the top N URLs, and return their content.

**Video tutorial: Integrate 5,000+ Apify Actors and Agents with Claude**

[![Apify MCP Server Tutorial: Integrate 5,000+ Apify Actors and Agents with Claude](https://img.youtube.com/vi/BKu8H91uCTg/hqdefault.jpg)](https://www.youtube.com/watch?v=BKu8H91uCTg)

# 🚀 Quickstart

You can use the Apify MCP Server in two ways:

**HTTPS Endpoint (mcp.apify.com)**: Connect from your MCP client via OAuth or by including the `Authorization: Bearer <APIFY_TOKEN>` header in your requests. This is the recommended method for most use cases. Because it supports OAuth, you can connect from clients like [Claude.ai](https://claude.ai) or [Visual Studio Code](https://code.visualstudio.com/) using just the URL: `https://mcp.apify.com`.
- `https://mcp.apify.com` (recommended) for streamable transport
- `https://mcp.apify.com/sse` for legacy SSE transport

**Standard Input/Output (stdio)**: Ideal for local integrations and command-line tools like the Claude for Desktop client.
- Set the MCP client server command to `npx @apify/actors-mcp-server` and the `APIFY_TOKEN` environment variable to your Apify API token.
- See `npx @apify/actors-mcp-server --help` for more options.

You can find detailed instructions for setting up the MCP server in the [Apify documentation](https://docs.apify.com/platform/integrations/mcp).

# 🤖 MCP clients and examples

To interact with the Apify MCP server, you can use various MCP clients, such as:
- [Claude Desktop](https://claude.ai/download)
- [Visual Studio Code](https://code.visualstudio.com/)
- [LibreChat](https://www.librechat.ai/)
- [Apify Tester MCP Client](https://apify.com/jiri.spilka/tester-mcp-client)
- Other clients at [https://modelcontextprotocol.io/clients](https://modelcontextprotocol.io/clients)
- More clients at [https://glama.ai/mcp/clients](https://glama.ai/mcp/clients)

With MCP server integrated, you can ask your AI assistant things like:
- "Search the web and summarize recent trends in AI Agents."
- "Find the top 10 Italian restaurants in San Francisco."
- "Find and analyze the Instagram profile of The Rock."
- "Provide a step-by-step guide on using the Model Context Protocol, including source URLs."
- "What Apify Actors can I use?"

### Supported Clients Matrix

The following table outlines the tested MCP clients and their level of support for key features.

| Client | Dynamic Tool Discovery | Notes |
| --- | --- | --- |
| **Claude.ai (web)** | ✅ Full | |
| **Claude Desktop** | 🟡 Partial | Tools may need to be reloaded manually in the client. |
| **VS Code (Genie)** | ✅ Full | |
| **LibreChat** | ❓ Untested | |
| **Apify Tester MCP Client** | ✅ Full | Designed for testing Apify MCP servers. |

*This matrix is a work in progress. If you have tested other clients, please consider contributing to this documentation.*

# 🪄 Try Apify MCP Instantly

Want to try Apify MCP without any setup?

Check out [Apify Tester MCP Client](https://apify.com/jiri.spilka/tester-mcp-client)

This interactive, chat-like interface provides an easy way to explore the capabilities of Apify MCP without any local setup.
Just sign in with your Apify account and start experimenting with web scraping, data extraction, and automation tools!

Or use the Anthropic Desktop extension file (dxt) for one-click installation: [Apify MCP server dxt file](https://github.com/apify/apify-mcp-server/releases/latest/download/apify-mcp-server.dxt)

# 🛠️ Tools, resources, and prompts

The MCP server provides a set of tools for interacting with Apify Actors.
Since the Apify Store is large and growing rapidly, the MCP server provides a way to dynamically discover and use new Actors.

### Actors

Any [Apify Actor](https://apify.com/store) can be used as a tool.
By default, the server is pre-configured with one Actor, `apify/rag-web-browser`, and several helper tools.
The MCP server loads an Actor's input schema and creates a corresponding MCP tool.
This allows the AI agent to know exactly what arguments to pass to the Actor and what to expect in return.


For example, for the `apify/rag-web-browser` Actor, the input parameters are:

```json
{
  "query": "restaurants in San Francisco",
  "maxResults": 3
}
```
You don't need to manually specify which Actor to call or its input parameters; the LLM handles this automatically.
When a tool is called, the arguments are automatically passed to the Actor by the LLM.
You can refer to the specific Actor's documentation for a list of available arguments.

### Helper tools

One of the most powerful features of using MCP with Apify is dynamic tool discovery.
It gives an AI agent the ability to find new tools (Actors) as needed and incorporate them.
Here are some special MCP operations and how the Apify MCP Server supports them:

- **Apify Actors**: Search for Actors, view their details, and use them as tools for the AI.
- **Apify documentation**: Search the Apify documentation and fetch specific documents to provide context to the AI.
- **Actor runs**: Get lists of your Actor runs, inspect their details, and retrieve logs.
- **Apify storage**: Access data from your datasets and key-value stores.

### Overview of available tools

Here is an overview list of all the tools provided by the Apify MCP Server.

| Tool name | Category | Description | Enabled by default |
| :--- | :--- | :--- | :---: |
| `search-actors` | actors | Search for Actors in the Apify Store. | ✅ |
| `fetch-actor-details` | actors | Retrieve detailed information about a specific Actor. | ✅ |
| `call-actor` | actors | Call an Actor and get its run results. | ✅ |
| [`apify-slash-rag-web-browser`](https://apify.com/apify/rag-web-browser) | Actor (see [tool configuration](#tools-configuration)) | An Actor tool to browse the web. | ✅ |
| `search-apify-docs` | docs | Search the Apify documentation for relevant pages. | ✅ |
| `fetch-apify-docs` | docs | Fetch the full content of an Apify documentation page by its URL. | ✅ |
| `get-actor-run` | runs | Get detailed information about a specific Actor run. |  |
| `get-actor-run-list` | runs | Get a list of an Actor's runs, filterable by status. |  |
| `get-actor-log` | runs | Retrieve the logs for a specific Actor run. |  |
| `get-dataset` | storage | Get metadata about a specific dataset. |  |
| `get-dataset-items` | storage | Retrieve items from a dataset with support for filtering and pagination. |  |
| `get-dataset-schema` | storage | Generate a JSON schema from dataset items. |  |
| `get-key-value-store` | storage | Get metadata about a specific key-value store. |  |
| `get-key-value-store-keys`| storage | List the keys within a specific key-value store. |  |
| `get-key-value-store-record`| storage | Get the value associated with a specific key in a key-value store. |  |
| `get-dataset-list` | storage | List all available datasets for the user. |  |
| `get-key-value-store-list`| storage | List all available key-value stores for the user. |  |
| `add-actor` | experimental | Add an Actor as a new tool for the user to call. |  |
| `get-actor-output`* | - | Retrieve the output from an Actor call which is not included in the output preview of the Actor tool. | ✅ |

> **Note:**
>
> The `get-actor-output` tool is automatically included with any Actor-related tool, such as `call-actor`, `add-actor`, or any specific Actor tool like `apify-slash-rag-web-browser`. When you call an Actor - either through the `call-actor` tool or directly via an Actor tool (e.g., `apify-slash-rag-web-browser`) - you receive a preview of the output. The preview depends on the Actor's output format and length; for some Actors and runs, it may include the entire output, while for others, only a limited version is returned to avoid overwhelming the LLM. To retrieve the full output of an Actor run, use the `get-actor-output` tool (supports limit, offset, and field filtering) with the `datasetId` provided by the Actor call.

### Tools configuration

The `tools` configuration parameter is used to specify loaded tools - either categories or specific tools directly, and Apify Actors. For example, `tools=storage,runs` loads two categories; `tools=add-actor` loads just one tool.

When no query parameters are provided, the MCP server loads the following `tools` by default:

- `actors`
- `docs`
- `apify/rag-web-browser`

If the tools parameter is specified, only the listed tools or categories will be enabled - no default tools will be included.

> **Easy configuration:**
>
> Use the [UI configurator](https://mcp.apify.com/) to configure your server, then copy the configuration to your client.

**Configuring the hosted server:**

The hosted server can be configured using query parameters in the URL. For example, to load the default tools, use:

```
https://mcp.apify.com?tools=actors,docs,apify/rag-web-browser
```

For minimal configuration, if you want to use only a single Actor tool - without any discovery or generic calling tools, the server can be configured as follows:

```
https://mcp.apify.com?tools=apify/my-actor
```

This setup exposes only the specified Actor (`apify/my-actor`) as a tool. No other tools will be available.

**Configuring the CLI:**

The CLI can be configured using command-line flags. For example, to load the same tools as in the hosted server configuration, use:

```bash
npx @apify/actors-mcp-server --tools actors,docs,apify/rag-web-browser
```

The minimal configuration is similar to the hosted server configuration:

```bash
npx @apify/actors-mcp-server --tools apify/my-actor
```

As above, this exposes only the specified Actor (`apify/my-actor`) as a tool. No other tools will be available.

> **⚠️ Important recommendation**
>
> **The default tools configuration may change in future versions.** When no `tools` parameter is specified, the server currently loads default tools, but this behavior is subject to change.
>
> **For production use and stable interfaces, always explicitly specify the `tools` parameter** to ensure your configuration remains consistent across updates.

### Backward compatibility

The v2 configuration preserves backward compatibility with v1 usage. Notes:

- `actors` param (URL) and `--actors` flag (CLI) are still supported.
  - Internally they are merged into `tools` selectors.
  - Examples: `?actors=apify/rag-web-browser` ≡ `?tools=apify/rag-web-browser`; `--actors apify/rag-web-browser` ≡ `--tools apify/rag-web-browser`.
- `enable-adding-actors` (CLI) and `enableAddingActors` (URL) are supported but deprecated.
  - Prefer `tools=experimental` or including the specific tool `tools=add-actor`.
  - Behavior remains: when enabled with no `tools` specified, the server exposes only `add-actor`; when categories/tools are selected, `add-actor` is also included.
- `enableActorAutoLoading` remains as a legacy alias for `enableAddingActors` and is mapped automatically.
- Defaults remain compatible: when no `tools` are specified, the server loads `actors`, `docs`, and `apify/rag-web-browser`.
  - If any `tools` are specified, the defaults are not added (same as v1 intent for explicit selection).
- `call-actor` is now included by default via the `actors` category (additive change). To exclude it, specify an explicit `tools` list without `actors`.
- `preview` category is deprecated and removed. Use specific tool names instead.

Existing URLs and commands using `?actors=...` or `--actors` continue to work unchanged.

### Prompts

The server provides a set of predefined example prompts to help you get started interacting with Apify through MCP. For example, there is a `GetLatestNewsOnTopic` prompt that allows you to easily retrieve the latest news on a specific topic using the [RAG Web Browser](https://apify.com/apify/rag-web-browser) Actor.

### Resources

The server does not yet provide any resources.

### Debugging the NPM package

To debug the server, use the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) tool:

```shell
export APIFY_TOKEN="your-apify-token"
npx @modelcontextprotocol/inspector npx -y @apify/actors-mcp-server
```

# ⚙️ Development

## Prerequisites

- [Node.js](https://nodejs.org/en) (v18 or higher)

Create an environment file, `.env`, with the following content:
```text
APIFY_TOKEN="your-apify-token"
```

Build the `actor-mcp-server` package:

```bash
npm run build
```

## Start HTTP streamable MCP server

Run using Apify CLI:

```bash
export APIFY_TOKEN="your-apify-token"
export APIFY_META_ORIGIN=STANDBY
apify run -p
```

Once the server is running, you can use the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) to debug the server exposed at `http://localhost:3001`.

## Start standard input/output (stdio) MCP server

You can launch the MCP Inspector with this command:

```bash
export APIFY_TOKEN="your-apify-token"
npx @modelcontextprotocol/inspector node ./dist/stdio.js
```

Upon launching, the Inspector will display a URL that you can open in your browser to begin debugging.

## 🐦 Canary PR releases

Apify MCP is split across two repositories: this one for core MCP logic and the private `apify-mcp-server-internal` for the hosted server.
Changes must be synchronized between both.

To create a canary release, add the `beta` tag to your PR branch.
This publishes the package to [pkg.pr.new](https://pkg.pr.new/) for staging and testing before merging.
See [the workflow file](.github/workflows/pre_release.yaml) for details.

# 🐛 Troubleshooting (local MCP server)

- Make sure you have `node` installed by running `node -v`.
- Make sure the `APIFY_TOKEN` environment variable is set.
- Always use the latest version of the MCP server by using `@apify/actors-mcp-server@latest`.

## 💡 Limitations

The Actor input schema is processed to be compatible with most MCP clients while adhering to [JSON Schema](https://json-schema.org/) standards. The processing includes:
- **Descriptions** are truncated to 500 characters (as defined in `MAX_DESCRIPTION_LENGTH`).
- **Enum fields** are truncated to a maximum combined length of 200 characters for all elements (as defined in `ACTOR_ENUM_MAX_LENGTH`).
- **Required fields** are explicitly marked with a `REQUIRED` prefix in their descriptions for compatibility with frameworks that may not handle the JSON schema properly.
- **Nested properties** are built for special cases like proxy configuration and request list sources to ensure the correct input structure.
- **Array item types** are inferred when not explicitly defined in the schema, using a priority order: explicit type in items > prefill type > default value type > editor type.
- **Enum values and examples** are added to property descriptions to ensure visibility, even if the client doesn't fully support the JSON schema.
- **Rental Actors** are only available for use with the hosted MCP server at https://mcp.apify.com. When running the server locally via stdio, you can only access Actors that are already added to your local toolset. To dynamically search for and use any Actor from the Apify Store—including rental Actors—connect to the hosted endpoint.

# 🤝 Contributing

We welcome contributions to improve the Apify MCP Server! Here's how you can help:

- **🐛 Report issues**: Find a bug or have a feature request? [Open an issue](https://github.com/apify/apify-mcp-server/issues).
- **🔧 Submit pull requests**: Fork the repo and submit pull requests with enhancements or fixes.
- **📚 Documentation**: Improvements to docs and examples are always welcome.
- **💡 Share use cases**: Contribute examples to help other users.

For major changes, please open an issue first to discuss your proposal and ensure it aligns with the project's goals.

# 📚 Learn more

- [Model Context Protocol](https://modelcontextprotocol.org/)
- [What are AI Agents?](https://blog.apify.com/what-are-ai-agents/)
- [What is MCP and why does it matter?](https://blog.apify.com/what-is-model-context-protocol/)
- [How to use MCP with Apify Actors](https://blog.apify.com/how-to-use-mcp/)
- [Tester MCP Client](https://apify.com/jiri.spilka/tester-mcp-client)
- [Webinar: Building and Monetizing MCP Servers on Apify](https://www.youtube.com/watch?v=w3AH3jIrXXo)
- [MCP Client development guide](https://github.com/cyanheads/model-context-protocol-resources/blob/main/guides/mcp-client-development-guide.md)
- [How to build and monetize an AI agent on Apify](https://blog.apify.com/how-to-build-an-ai-agent/)
