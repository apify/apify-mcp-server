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

The MCP server uses UI widgets from the `src/web/` directory.

See the [OpenAI Apps SDK documentation](https://developers.openai.com/apps-sdk) for background on MCP Apps and widgets.

### Production build

If you need the compiled assets copied into the top-level `dist/web` for packaging or integration tests, build everything:

```bash
npm run build
```

This command builds the core project and the `src/web/` widgets, then copies the widgets into the `dist/` directory.

All widget code lives in the self-contained `src/web/` React project. The widgets (MCP Apps) are rendered based on the structured output returned by MCP tools. If you need to add specific data to a widget, modify the corresponding MCP tool's output, since widgets can only render data returned by the MCP tool call result.

> **Important (UI mode):** Widget rendering is enabled only when the server runs in UI mode. Use the `ui=openai` query parameter (e.g., `/mcp?ui=openai`) or set `UI_MODE=openai`. Currently, `openai` is the only supported `ui` value.

### Hot-reload development

Run the orchestrator, which starts the web widgets builder in watch mode and the MCP server in standby mode:

```bash
APIFY_TOKEN='your-apify-token' npm run dev
```

What happens:
- The `src/web` project runs `npm run dev` and continuously writes compiled files to `src/web/dist`.
- The MCP server reads widget assets directly from `src/web/dist` (compiled JS/HTML only; no TypeScript or JSX at runtime).
- Editing files under `src/web/src/widgets/*.tsx` triggers a rebuild; the next widget render will use the updated code without restarting the server.

Notes:
- You can get your `APIFY_TOKEN` from https://console.apify.com/settings/integrations
- Widget discovery happens when the server connects. Changing widget code is hot-reloaded; adding brand-new widget filenames typically requires reconnecting the MCP client (or restarting the server) to expose the new resource.
- You can preview widgets quickly via the local esbuild dev server at `http://localhost:3000/index.html`.

The MCP server listens on port `3001`. The HTTP server implementation used here is the standby Actor server in `src/actor/server.ts` (used by `src/main.ts` in STANDBY mode). The hosted production server behind [mcp.apify.com](https://mcp.apify.com) is located in the internal Apify repository.

### Using MCP servers with Claude Code

This repository includes a `.mcp.json` configuration file that allows you to use external MCP servers (like the Storybook MCP server) directly within Claude Code for enhanced development workflows.

To use the Storybook MCP server (or any other MCP server that requires authentication), you need to configure your Apify API token in Claude Code's settings:

1. Get your Apify API token from https://console.apify.com/settings/integrations
2. Create or edit `.claude/settings.local.json` file
3. Add the following environment variable configuration:

```json
{
  "env": {
    "APIFY_TOKEN": "<YOUR_APIFY_API_TOKEN>"
  }
}
```

4. Restart Claude Code for the changes to take effect

The `.mcp.json` file uses environment variable expansion (`${APIFY_TOKEN}`) to securely reference your token without hardcoding it in the configuration file. This allows you to share the configuration with your team while keeping credentials private.

### Testing with MCPJam (optional)

You can use [MCPJam](https://www.mcpjam.com/) to connect to and test the MCP server - run it using `npx @mcpjam/inspector@latest`.

#### Setting up the connection

1. Click **"Add new server"**
2. Fill in a name for the server
3. Enter the URL: `http://localhost:3001/mcp?ui=openai` (Note: the `ui=openai` query parameter is required for widget rendering)
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
2. Add your `OPENAI_API_KEY` (or Anthropic API key, or OpenRouter API key)
3. Chat with the MCP server directly, widgets will be rendered inline
