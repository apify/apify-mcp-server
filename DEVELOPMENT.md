# Development

This document outlines the development setup, project structure, and workflow for contributing to this project.

## Overview

This project contains the public logic of the Apify MCP server, including the core MCP functionality and stdio version packaged as an NPM package. There is also an internal Apify repository that uses this package as the core MCP library and exposes the actual HTTP server logic for [mcp.apify.com](https://mcp.apify.com).

The main codebase resides in the `src/` directory. Additionally, there is a React-based sub-directory `src/web/` that contains the UI widgets used for MCP Apps (ChatGPT Apps). See the [OpenAI Apps SDK documentation](https://developers.openai.com/apps-sdk) for more details.

For general information about the Apify MCP Server, features, tools, and client setup, see the [README.md](./README.md).

## How to Contribute

### Installation

First, install all the dependencies:

```bash
npm install
cd src/web
npm install
```

### Working on the MCP Apps (ChatGPT Apps) UI Widgets

The MCP server uses UI widgets from the `src/web/` directory that need to be built before running the server. To build everything, including the UI widgets, run:

```bash
npm run build-all
```

This command builds the `src/web/` internal project, then runs `npm run build`, and copies the widgets into the `dist/` directory.

### Running the MCP Server Locally

Start the MCP server locally using:

```bash
APIFY_TOKEN='your-apify-token' npm run start:standby
```

This will spawn the MCP server at port `3001`.

### Testing with MCPJam

You can use [MCPJam](https://www.mcpjam.com/) to connect to and test the MCP server.

#### Setting Up the Connection

1. Click **"Add new server"**
2. Fill in a name for the server
3. Enter the URL: `http://localhost:3001/mcp?ui=openai`
4. Select **"No authentication"** as the auth method
5. Click **Add**

#### Testing Tools Manually

To test how widgets are rendered per tool call:

1. Navigate to the **"Tools"** section in the left sidebar
2. Select a tool
3. Fill in the required arguments
4. Execute the tool
5. View the rendered widget (or the raw MCP tool result if the tool doesn't return a widget)

> **Note:** In recent versions, widget rendering in the Tools section can be clunky with limited scrolling. The Chat interface provides a better experience.

#### Testing via Chat

For a better testing experience with widget rendering:

1. Navigate to the **"Chat"** section in the left sidebar
2. Add your ChatGPT API key (or Claude/Anthropic key)
3. Chat with the MCP server directly — widgets will be rendered inline
