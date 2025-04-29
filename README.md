# Apify Model Context Protocol (MCP) Server

[![Actors MCP Server](https://apify.com/actor-badge?actor=apify/actors-mcp-server)](https://apify.com/apify/actors-mcp-server)
[![smithery badge](https://smithery.ai/badge/@apify/actors-mcp-server)](https://smithery.ai/server/@apify/actors-mcp-server)

Implementation of an MCP server for all [Apify Actors](https://apify.com/store) that enables interaction with Apify Actors.

The server can be used in the following ways:
- **🇦 [MCP Server Actor](https://apify.com/apify/actors-mcp-server)** – HTTP server accessible via Server-Sent Events (SSE), see [guide](#-mcp-server-actor)
- **⾕ MCP Server Stdio** – Local server available via standard input/output (stdio), see [guide](#-mcp-server-at-a-local-host)
- **🇦 Apify MCP API (alpha)** – HTTP server accessible via Server-Sent Events (SSE), see [guide](#apify-mcp-api)

You can also interact with the MCP server using a chat-like UI with 💬 [Tester MCP Client](https://apify.com/jiri.spilka/tester-mcp-client)

# 🎯 What does Apify MCP server do?

The MCP Server Actor allows an AI assistant to use any [Apify Actor](https://apify.com/store) as a tool to perform a specific task.
For example, it can:
- Use [Facebook Posts Scraper](https://apify.com/apify/facebook-posts-scraper) to extract data from Facebook posts from multiple pages/profiles
- Use [Google Maps Email Extractor](https://apify.com/lukaskrivka/google-maps-with-contact-details) to extract Google Maps contact details
- Use [Google Search Results Scraper](https://apify.com/apify/google-search-scraper) to scrape Google Search Engine Results Pages (SERPs)
- Use [Instagram Scraper](https://apify.com/apify/instagram-scraper) to scrape Instagram posts, profiles, places, photos, and comments
- Use [RAG Web Browser](https://apify.com/apify/web-scraper) to search the web, scrape the top N URLs, and return their content

# MCP Clients

To interact with the Apify MCP server, you can use MCP clients such as:
- [Claude Desktop](https://claude.ai/download) (only Stdio support)
- [Visual Studio Code](https://code.visualstudio.com/) (Stdio and SSE support)
- [LibreChat](https://www.librechat.ai/) (Stdio and SSE support, yet without Authorization header)
- [Apify Tester MCP Client](https://apify.com/jiri.spilka/tester-mcp-client) (SSE support with Authorization headers)
- Other clients at [https://modelcontextprotocol.io/clients](https://modelcontextprotocol.io/clients)
- More clients at [https://glama.ai/mcp/clients](https://glama.ai/mcp/clients)

When you have Actors integrated with the MCP server, you can ask:
- "Search the web and summarize recent trends about AI Agents"
- "Find the top 10 best Italian restaurants in San Francisco"
- "Find and analyze the Instagram profile of The Rock"
- "Provide a step-by-step guide on using the Model Context Protocol with source URLs"
- "What Apify Actors can I use?"

The following image shows how the Apify MCP server interacts with the Apify platform and AI clients:

![Actors-MCP-server](https://raw.githubusercontent.com/apify/actors-mcp-server/refs/heads/master/docs/actors-mcp-server.png)

With the MCP Tester client you can load Actors dynamically but this is not yet supported by other MCP clients.
We also plan to add more features, see [Roadmap](#-roadmap-march-2025) for more details.

# 🔄 What is the Model Context Protocol?

The Model Context Protocol (MCP) allows AI applications (and AI agents), such as Claude Desktop, to connect to external tools and data sources.
MCP is an open protocol that enables secure, controlled interactions between AI applications, AI Agents, and local or remote resources.

For more information, see the [Model Context Protocol](https://modelcontextprotocol.org/) website or the blog post [What is MCP and why does it matter?](https://blog.apify.com/what-is-model-context-protocol/).

# 🤖 How is MCP Server related to AI Agents?

The Apify MCP Server exposes Apify's Actors through the MCP protocol, allowing AI Agents or frameworks that implement the MCP protocol to access all Apify Actors as tools for data extraction, web searching, and other tasks.

To learn more about AI Agents, explore our blog post: [What are AI Agents?](https://blog.apify.com/what-are-ai-agents/) and browse Apify's curated [AI Agent collection](https://apify.com/store/collections/ai_agents).
Interested in building and monetizing your own AI agent on Apify? Check out our [step-by-step guide](https://blog.apify.com/how-to-build-an-ai-agent/) for creating, publishing, and monetizing AI agents on the Apify platform.

# 🧱 Components

## Tools

### Actors

Any [Apify Actor](https://apify.com/store) can be used as a tool via this MCP server.
By default, the server is pre-configured with the Actors specified below, but this can be overridden by providing Actor input.

```text
'apify/instagram-scraper'
'apify/rag-web-browser'
'lukaskrivka/google-maps-with-contact-details'
```

### Helper tools

The server provides a set of helper tools to discover available Actors and retrieve their details:
- `get-actor-details`: Retrieves documentation, input schema, and details about a specific Actor.
- `search-actors`: Searches for relevant Actors using keywords and returns their details.

There are also tools to manage the available tools list. However, **dynamically adding and removing tools requires the MCP client to have the capability to update the tools list** (handle `ToolListChangedNotificationSchema`), which is typically not supported.

You can try this functionality using the [Apify Tester MCP Client](https://apify.com/jiri.spilka/tester-mcp-client) Actor.
To enable it, set the `enableAddingActors` parameter.

- `add-actor`: Adds an Actor by name to the available tools list without executing it, requiring user consent to run later.
- `remove-actor`: Removes an Actor by name from the available tools list when it's no longer needed.

## Prompt & Resources

The server does not provide any resources and prompts.
We plan to add [Apify's dataset](https://docs.apify.com/platform/storage/dataset) and [key-value store](https://docs.apify.com/platform/storage/key-value-store) as resources in the future.

# ⚙️ Usage

The Apify MCP Server can be used in the following ways: **as an Apify Actor** running on the Apify platform, as a **local server** running on your machine and experimentally as an **Apify MCP API** at [mcp.apify.com](https://mcp.apify.com).

## 🇦 MCP Server Actor

### Standby web server over SSE

The Actor runs in [**Standby mode**](https://docs.apify.com/platform/actors/running/standby) with an HTTP web server that receives and processes requests.

To use the server, connect your MCP client to the following URL with the `Authorization` header set to your [Apify API token](https://console.apify.com/settings/integrations):
```text
https://actors-mcp-server.apify.actor/sse

Authorization: Bearer <APIFY_TOKEN>
```

In case your client does not support setting the `Authorization` header, you can use the `token` query parameter instead:
```text
https://actors-mcp-server.apify.actor/sse?token=<APIFY_TOKEN>
```

It is also possible to start the MCP server with a different set of Actors.
To do this, you can either specify Actors in the `actors` query parameter (comma-separated) or create a [task](https://docs.apify.com/platform/actors/running/tasks) and specify the list of Actors you want to use.

To specify the Actors in the `actors` query parameter, use the following URL:
```text
https://actors-mcp-server.apify.actor/sse?actors=apify/instagram-scraper,apify/rag-web-browser

Authorization: Bearer <APIFY_TOKEN>
```

Or with the `token` query parameter:
```text
https://actors-mcp-server.apify.actor/sse?token=<APIFY_TOKEN>&actors=apify/instagram-scraper,apify/rag-web-browser
```

If you created a task instead, then use the task Actor URL with either the `Authorization` header or the `token` query parameter (the URL can be found in the task Standby tab in the Apify Console):
```text
https://USERNAME--actors-mcp-server-task.apify.actor/sse
```

## ⾕ MCP Server at a local host

You can run the Apify MCP Server on your local machine by configuring it with Claude Desktop or any other [MCP client](https://modelcontextprotocol.io/clients).
You can also use [Smithery](https://smithery.ai/server/@apify/actors-mcp-server) to install the server automatically.
Note: The free version of Claude Desktop may experience intermittent connection issues with the server.

### Prerequisites

- MacOS or Windows
- The latest version of Claude Desktop must be installed (or another MCP client)
- [Node.js](https://nodejs.org/en) (v18 or higher)
- [Apify API Token](https://docs.apify.com/platform/integrations/api#api-token) (`APIFY_TOKEN`)

Make sure you have the `node` and `npx` installed properly:
```bash
node -v
npx -v
```
If not, follow this guide to install Node.js: [Downloading and installing Node.js and npm](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm).

#### Claude Desktop

To configure Claude Desktop to work with the MCP server, follow these steps. For a detailed guide, refer to the [Claude Desktop Users Guide](https://modelcontextprotocol.io/quickstart/user).

1. Download Claude for desktop
   - Available for Windows and macOS.
   - For Linux users, you can build a Debian package using this [unofficial build script](https://github.com/aaddrick/claude-desktop-debian).
2. Open the Claude Desktop app and enable **Developer Mode** from the top-left menu bar.
3. Once enabled, open **Settings** (also from the top-left menu bar) and navigate to the **Developer Option**, where you'll find the **Edit Config** button.
4. Open the configuration file and edit the following file:

    - On macOS: `~/Library/Application\ Support/Claude/claude_desktop_config.json`
    - On Windows: `%APPDATA%/Claude/claude_desktop_config.json`
    - On Linux: `~/.config/Claude/claude_desktop_config.json`

    ```json
    {
     "mcpServers": {
       "actors-mcp-server": {
         "command": "npx",
         "args": ["-y", "@apify/actors-mcp-server"],
         "env": {
            "APIFY_TOKEN": "your-apify-token"
         }
       }
     }
    }
    ```
    Alternatively, you can use the `actors` argument to select one or more Apify Actors:
    ```json
   {
    "mcpServers": {
      "actors-mcp-server": {
        "command": "npx",
        "args": [
          "-y", "@apify/actors-mcp-server",
          "--actors", "lukaskrivka/google-maps-with-contact-details,apify/instagram-scraper"
        ],
        "env": {
           "APIFY_TOKEN": "your-apify-token"
        }
      }
    }
   }
    ```
5. Restart Claude Desktop

    - Fully quit Claude Desktop (ensure it's not just minimized or closed).
    - Restart Claude Desktop.
    - Look for the 🔌 icon to confirm that the Actors MCP server is connected.

6. Open the Claude Desktop chat and ask "What Apify Actors can I use?"

   ![Claude-desktop-with-Actors-MCP-server](https://raw.githubusercontent.com/apify/actors-mcp-server/refs/heads/master/docs/claude-desktop.png)

7. Examples

   You can ask Claude to perform tasks, such as:
    ```text
    Find and analyze recent research papers about LLMs.
    Find the top 10 best Italian restaurants in San Francisco.
    Find and analyze the Instagram profile of The Rock.
    ```

#### VS Code

For one-click installation, click one of the install buttons below:

[![Install with NPX in VS Code](https://img.shields.io/badge/VS_Code-NPM-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=actors-mcp-server&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40apify%2Factors-mcp-server%22%5D%2C%22env%22%3A%7B%22APIFY_TOKEN%22%3A%22%24%7Binput%3Aapify_token%7D%22%7D%7D&inputs=%5B%7B%22type%22%3A%22promptString%22%2C%22id%22%3A%22apify_token%22%2C%22description%22%3A%22Apify+API+Token%22%2C%22password%22%3Atrue%7D%5D) [![Install with NPX in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-NPM-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=actors-mcp-server&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40apify%2Factors-mcp-server%22%5D%2C%22env%22%3A%7B%22APIFY_TOKEN%22%3A%22%24%7Binput%3Aapify_token%7D%22%7D%7D&inputs=%5B%7B%22type%22%3A%22promptString%22%2C%22id%22%3A%22apify_token%22%2C%22description%22%3A%22Apify+API+Token%22%2C%22password%22%3Atrue%7D%5D&quality=insiders)

##### Manual installation

You can manually install the Apify MCP Server in VS Code. First, click one of the install buttons at the top of this section for a one-click installation.

Alternatively, add the following JSON block to your User Settings (JSON) file in VS Code. You can do this by pressing `Ctrl + Shift + P` and typing `Preferences: Open User Settings (JSON)`.

```json
{
  "mcp": {
    "inputs": [
      {
        "type": "promptString",
        "id": "apify_token",
        "description": "Apify API Token",
        "password": true
      }
    ],
    "servers": {
      "actors-mcp-server": {
        "command": "npx",
        "args": ["-y", "@apify/actors-mcp-server"],
        "env": {
          "APIFY_TOKEN": "${input:apify_token}"
        }
      }
    }
  }
}
```

Optionally, you can add it to a file called `.vscode/mcp.json` in your workspace - just omit the top-level `mcp {}` key. This will allow you to share the configuration with others.

If you want to specify which Actors to load, you can add the `--actors` argument:

```json
{
  "servers": {
    "actors-mcp-server": {
      "command": "npx",
      "args": [
        "-y", "@apify/actors-mcp-server",
        "--actors", "lukaskrivka/google-maps-with-contact-details,apify/instagram-scraper"
      ],
      "env": {
        "APIFY_TOKEN": "${input:apify_token}"
      }
    }
  }
}
```

#### VS Code

For one-click installation, click one of the install buttons below:

[![Install with NPX in VS Code](https://img.shields.io/badge/VS_Code-NPM-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=actors-mcp-server&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40apify%2Factors-mcp-server%22%5D%2C%22env%22%3A%7B%22APIFY_TOKEN%22%3A%22%24%7Binput%3Aapify_token%7D%22%7D%7D&inputs=%5B%7B%22type%22%3A%22promptString%22%2C%22id%22%3A%22apify_token%22%2C%22description%22%3A%22Apify+API+Token%22%2C%22password%22%3Atrue%7D%5D) [![Install with NPX in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-NPM-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=actors-mcp-server&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40apify%2Factors-mcp-server%22%5D%2C%22env%22%3A%7B%22APIFY_TOKEN%22%3A%22%24%7Binput%3Aapify_token%7D%22%7D%7D&inputs=%5B%7B%22type%22%3A%22promptString%22%2C%22id%22%3A%22apify_token%22%2C%22description%22%3A%22Apify+API+Token%22%2C%22password%22%3Atrue%7D%5D&quality=insiders)

##### Manual installation

You can manually install the Apify MCP Server in VS Code. First, click one of the install buttons at the top of this section for a one-click installation.

Alternatively, add the following JSON block to your User Settings (JSON) file in VS Code. You can do this by pressing `Ctrl + Shift + P` and typing `Preferences: Open User Settings (JSON)`.

```json
{
  "mcp": {
    "inputs": [
      {
        "type": "promptString",
        "id": "apify_token",
        "description": "Apify API Token",
        "password": true
      }
    ],
    "servers": {
      "actors-mcp-server": {
        "command": "npx",
        "args": ["-y", "@apify/actors-mcp-server"],
        "env": {
          "APIFY_TOKEN": "${input:apify_token}"
        }
      }
    }
  }
}
```

Optionally, you can add it to a file called `.vscode/mcp.json` in your workspace - just omit the top-level `mcp {}` key. This will allow you to share the configuration with others.

If you want to specify which Actors to load, you can add the `--actors` argument:

```json
{
  "servers": {
    "actors-mcp-server": {
      "command": "npx",
      "args": [
        "-y", "@apify/actors-mcp-server",
        "--actors", "lukaskrivka/google-maps-with-contact-details,apify/instagram-scraper"
      ],
      "env": {
        "APIFY_TOKEN": "${input:apify_token}"
      }
    }
  }
}
```

#### Debugging NPM package @apify/actors-mcp-server with @modelcontextprotocol/inspector

To debug the server, use the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) tool:

```shell
export APIFY_TOKEN=your-apify-token
npx @modelcontextprotocol/inspector npx -y @apify/actors-mcp-server
```

### Installing via Smithery

To install Apify Actors MCP Server for Claude Desktop automatically via [Smithery](https://smithery.ai/server/@apify/actors-mcp-server):

```bash
npx -y @smithery/cli install @apify/actors-mcp-server --client claude
```

#### Stdio clients

Create an environment file `.env` with the following content:
```text
APIFY_TOKEN=your-apify-token
```
In the `examples` directory, you can find an example client to interact with the server via
standard input/output (stdio):

- [`clientStdio.ts`](https://github.com/apify/actor-mcp-server/tree/main/src/examples/clientStdio.ts)
    This client script starts the MCP server with two specified Actors.
    It then calls the `apify/rag-web-browser` tool with a query and prints the result.
    It demonstrates how to connect to the MCP server, list available tools, and call a specific tool using stdio transport.
    ```bash
    node dist/examples/clientStdio.js
    ```

# 👷🏼 Development

## Prerequisites

- [Node.js](https://nodejs.org/en) (v18 or higher)
- Python 3.9 or higher

Create an environment file `.env` with the following content:
```text
APIFY_TOKEN=your-apify-token
```

Build the actor-mcp-server package:

```bash
npm run build
```

## Local client (SSE)

To test the server with the SSE transport, you can use the script `examples/clientSse.ts`:
Currently, the Node.js client does not support establishing a connection to a remote server with custom headers.
You need to change the URL to your local server URL in the script.

```bash
node dist/examples/clientSse.js
```

## Debugging

Since MCP servers operate over standard input/output (stdio), debugging can be challenging.
For the best debugging experience, use the [MCP Inspector](https://github.com/modelcontextprotocol/inspector).

You can launch the MCP Inspector via [`npm`](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm) with this command:

```bash
export APIFY_TOKEN=your-apify-token
npx @modelcontextprotocol/inspector node ./dist/stdio.js
```

Upon launching, the Inspector will display a URL that you can access in your browser to begin debugging.

## ⓘ Limitations and feedback

The Actor input schema is processed to be compatible with most MCP clients while adhering to [JSON Schema](https://json-schema.org/) standards. The processing includes:
- **Descriptions** are truncated to 500 characters (as defined in `MAX_DESCRIPTION_LENGTH`).
- **Enum fields** are truncated to a maximum combined length of 200 characters for all elements (as defined in `ACTOR_ENUM_MAX_LENGTH`).
- **Required fields** are explicitly marked with a "REQUIRED" prefix in their descriptions for compatibility with frameworks that may not handle JSON schema properly.
- **Nested properties** are built for special cases like proxy configuration and request list sources to ensure correct input structure.
- **Array item types** are inferred when not explicitly defined in the schema, using a priority order: explicit type in items > prefill type > default value type > editor type.
- **Enum values and examples** are added to property descriptions to ensure visibility even if the client doesn't fully support JSON schema.

Memory for each Actor is limited to 4GB.
Free users have an 8GB limit, 128MB needs to be allocated for running `Actors-MCP-Server`.

If you need other features or have any feedback, [submit an issue](https://console.apify.com/actors/1lSvMAaRcadrM1Vgv/issues) in Apify Console to let us know.

# 🚀 Roadmap (March 2025)

- Add Apify's dataset and key-value store as resources.
- Add tools such as Actor logs and Actor runs for debugging.

# 🐛 Troubleshooting

- Make sure you have the `node` installed by running `node -v`
- Make sure you have the `APIFY_TOKEN` environment variable set
- Always use the latest version of the MCP server by setting `@apify/actors-mcp-server@latest`

# 📚 Learn more

- [Model Context Protocol](https://modelcontextprotocol.org/)
- [What are AI Agents?](https://blog.apify.com/what-are-ai-agents/)
- [What is MCP and why does it matter?](https://blog.apify.com/what-is-model-context-protocol/)
- [Tester MCP Client](https://apify.com/jiri.spilka/tester-mcp-client)
- [AI agent workflow: building an agent to query Apify datasets](https://blog.apify.com/ai-agent-workflow/)
- [MCP Client development guide](https://github.com/cyanheads/model-context-protocol-resources/blob/main/guides/mcp-client-development-guide.md)
- [How to build and monetize an AI agent on Apify](https://blog.apify.com/how-to-build-an-ai-agent/)
