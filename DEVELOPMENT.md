# Development

## Overview

This repository (**public**) provides:
- The core MCP server implementation (published as an NPM package)
- The stdio entry point (CLI)
- The Apify Actor standby HTTP server used for local development/testing

The hosted server (**[mcp.apify.com](https://mcp.apify.com)**) is implemented in an internal Apify repository that depends on this package.

For general information about the Apify MCP Server, features, tools, and client setup, see the [README.md](./README.md).

## Project structure (high-level)

```text
src/
  actor/        Standby Actor HTTP server (used by src/main.ts in STANDBY mode)
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
- `src/index-internals.ts` - Internal exports for testing / advanced usage
- `src/stdio.ts` - Standard input/output (CLI) entry point
- `src/main.ts` - Actor entry point (standby server / debugging)
- `src/input.ts` - Input processing and validation

## How to contribute

Refer to the [CONTRIBUTING.md](./CONTRIBUTING.md) file.

### Installation

First, install all the dependencies:

```bash
npm install
cd src/web
npm install
```

### Working on the MCP Apps (ChatGPT Apps) UI widgets

The MCP server uses UI widgets from the `src/web/` directory that need to be built before running the server. To build everything, including the UI widgets, run:
See the [OpenAI Apps SDK documentation](https://developers.openai.com/apps-sdk) for background on MCP Apps and widgets.

```bash
npm run build-all
```

This command builds the `src/web/` internal project, then runs `npm run build`, and copies the widgets into the `dist/` directory.

If you only want to work on the React UI widgets, all widget code lives in the self-contained `src/web/` React project. The widgets (MCP Apps) are rendered based on the structured output returned by MCP tools. If you need to add specific data to a widget, you will need to modify the corresponding MCP tool's output since widgets can only render data returned by the MCP tool call result.

> **Important (UI mode):** Widget rendering is enabled only when the server runs in UI mode. Use the `ui=openai` query parameter (e.g., `/mcp?ui=openai`) or set `UI_MODE=openai`. Currently, `openai` is the only supported `ui` value.

> **Important:** After changing widgets, you must rebuild the project with `npm run build-all` to refresh the React widgets in the `dist/` directory.

### Running the MCP server locally

Start the MCP server locally using:

```bash
APIFY_TOKEN='your-apify-token' npm run start:standby
```

This will spawn the MCP server at port `3001`.
The HTTP server implementation used here is the standby Actor server in `src/actor/server.ts` (used by `src/main.ts` in STANDBY mode).
The hosted production server behind [mcp.apify.com](https://mcp.apify.com) is located in the internal Apify repository.

### Testing with MCPJam (optional)

You can use [MCPJam](https://www.mcpjam.com/) to connect to and test the MCP server - run it using `npx @mcpjam/inspector@latest`.

#### Setting up the connection

1. Click **"Add new server"**
2. Fill in a name for the server
3. Enter the URL: `http://localhost:3001/mcp?ui=openai`
4. Select **"No authentication"** as the auth method
5. Click **Add**

#### Testing tools manually

To test how widgets are rendered per tool call:

1. Navigate to the **"App Builder"** section in the left sidebar
2. Select a tool
3. Fill in the required arguments
4. Execute the tool
5. View the rendered widget (or the raw MCP tool result if the tool doesn't return a widget)

#### Testing via chat

For a better testing experience with widget rendering:

1. Navigate to the **"Chat"** section in the left sidebar
2. Add your `OPENAI_API_KEY` (or Anthropic API key)
3. Chat with the MCP server directly, widgets will be rendered inline
