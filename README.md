# Apify Model Context Protocol (MCP) Server

Implementation of an MCP server for all [Apify Actors](https://apify.com/store).
This server enables interaction with one or more Apify Actors that can be defined in the MCP server configuration.

The server can be used in two ways:
- **Apify MCP Server Actor**: runs an HTTP server supporting the MCP protocol via Server-Sent Events (SSE).
- **Apify MCP Server Stdio**: provides support for the MCP protocol via standard input/output stdio.

# 🎯 What does Apify MCP server do?

The MCP Server Actor allows an AI assistant to use any [Apify Actor](https://apify.com/store) as a tool to perform a specific task.
For example it can:
    - [Facebook Posts Scraper](https://apify.com/apify/facebook-posts-scraper) extract data from Facebook posts from multiple pages/profiles
    - [Google Maps Email Extractor](https://apify.com/lukaskrivka/google-maps-with-contact-details) extract Google Maps contact details
    - [Google Search Results Scraper](https://apify.com/apify/google-search-scraper) scrape Google Search Engine Results Pages (SERPs)
    - [Instagram Scraper](https://apify.com/apify/instagram-scraper) scrape Instagram posts, profiles, places, hashtags, photos, and comments
    - [RAG Web Browser](https://apify.com/apify/web-scraper) perform web search, scrape the top N URLs from the results, and return content

To interact with the Apify MCP server, you can use MCP clients such as [Claude Desktop](https://claude.ai/download), [Superinference.ai](https://superinterface.ai/), or [LibreChat](https://www.librechat.ai/).
Additionally, you can use simple example clients found in the [examples](https://github.com/apify/actor-mcp-server/tree/main/src/examples) directory.

When you have Actors integrated with the MCP server, you can ask:
- Search web and summarize recent trends about AI Agents
- Find top 10 best Italian restaurants in San Francisco
- Find and analyze Instagram profile of The Rock
- Provide a step-by-step guide on using the Model Context Protocol with source URLs.
- What Apify Actors I can use?

# 🔄 What is model context protocol?

The Model Context Protocol (MCP) allows AI applications (and AI agents), such as Claude Desktop, to connect to external tools and data sources.
MCP is an open protocol that enables secure, controlled interactions between AI applications, AI Agents, and local or remote resources.

# 🧱 Components

## Tools

Any [Apify Actor](https://apify.com/store) can be used as a tool.
By default, the server is pre-configured with the Actors specified below, but it can be overridden by providing a list of Actor names in the `actors` query parameter.

```text
   'apidojo/tweet-scraper',
   'apify/facebook-posts-scraper',
   'apify/google-search-scraper',
   'apify/instagram-scraper',
   'apify/rag-web-browser',
   'clockworks/free-tiktok-scraper',
   'compass/crawler-google-places',
   'lukaskrivka/google-maps-with-contact-details',
   'voyager/booking-scraper'
```
The MCP server loads the Actor input schema and creates MCP tools corresponding to the Actors.
See this example of input schema for the [RAG Web Browser](https://apify.com/apify/rag-web-browser/input-schema).

The tool name must always be the full Actor name, such as `apify/rag-web-browser`.
The arguments for an MCP tool represent the input parameters of the Actor.
For example, for the `apify/rag-web-browser` Actor, the arguments are:

```json
{
  "query": "restaurants in San Francisco",
  "maxResults": 3
}
```
You don't need to specify the input parameters or which Actor to call, everything is managed by an LLM.
When a tool is called, the arguments are automatically passed to the Actor by the LLM.
You can refer to the specific Actor's documentation for a list of available arguments.

## Prompt & Resources

The server does not provide any resources and prompts.
We plan to add Apify's dataset and key-value store as resources in the future.

# ⚙️ Usage

The Apify MCP Server can be used in two ways: **as an Apify Actor** running at Apify platform
or as a **local server** running on your machine.

## 🇦 MCP Server Actor

### Standby web server

The Actor runs in [**Standby mode**](https://docs.apify.com/platform/actors/running/standby) with an HTTP web server that receives and processes requests.

Start server with default Actors. To use the Apify MCP Server with set of default Actors,
send an HTTP GET request with your [Apify API token](https://console.apify.com/settings/integrations) to the following URL.
```
https://mcp-server.apify.actor?token=<APIFY_API_TOKEN>
```
It is also possible to start MCP server with a different set of tools by providing a list of Actor names in the `actors` query parameter.
Provide a comma-separated list of Actors in the `actors` query parameter:
```
https://mcp-server.apify.actor?token=<APIFY_API_TOKEN>&actors=junglee/free-amazon-product-scraper,lukaskrivka/google-maps-with-contact-details
```
Find list of all available Actors in the [Apify Store](https://apify.com/store).

#### 💬 Interact with the MCP Server

Once the server is running, you can interact with Server-Sent Events (SSE) to send messages to the server and receive responses.
You can use MCP clients such as [Superinference.ai](https://superinterface.ai/) or [LibreChat](https://www.librechat.ai/).
([Claude Desktop](https://claude.ai/download) does not support SSE transport yet)

In the client settings you need to provide server configuration:
```json
{
    "mcpServers": {
        "apify": {
            "type": "sse",
            "url": "https://mcp-server.apify.actor/sse",
            "env": {
                "APIFY-API-TOKEN": "your-apify-api-token"
            }
        }
    }
}
```
Alternatively, you can use simple python [client_see.py](https://github.com/apify/actor-mcp-server/tree/main/src/examples/client_sse.py) or test the server using `curl` </> commands.

1. Initiate Server-Sent-Events (SSE) by sending a GET request to the following URL:
    ```
    curl https://mcp-server.apify.actor/sse?token=<APIFY_API_TOKEN>
    ```
    The server will respond with a `sessionId`, which you can use to send messages to the server:
    ```shell
    event: endpoint
    data: /message?sessionId=a1b
    ```

2. Send a message to the server by making a POST request with the `sessionId`:
    ```shell
    curl -X POST "https://mcp-server.apify.actor?token=<APIFY_API_TOKEN>&session_id=a1b" -H "Content-Type: application/json" -d '{
      "jsonrpc": "2.0",
      "id": 1,
      "method": "tools/call",
      "params": {
        "arguments": { "searchStringsArray": ["restaurants in San Francisco"], "maxCrawledPlacesPerSearch": 3 },
        "name": "lukaskrivka/google-maps-with-contact-details"
      }
    }'
    ```
    The MCP server will start the Actor `lukaskrivka/google-maps-with-contact-details` with the provided arguments as input parameters.
    For this POST request, the server will respond with:

    ```text
    Accepted
    ```

3. Receive the response. The server will invoke the specified Actor as a tool using the provided query parameters and stream the response back to the client via SSE.
    The response will be returned as JSON text.

    ```text
    event: message
    data: {"result":{"content":[{"type":"text","text":"{\"searchString\":\"restaurants in San Francisco\",\"rank\":1,\"title\":\"Gary Danko\",\"description\":\"Renowned chef Gary Danko's fixed-price menus of American cuisine ... \",\"price\":\"$100+\"...}}]}}
    ```

## ⾕ MCP Server at a local host

### Prerequisites

- MacOS or Windows
- The latest version of Claude Desktop must be installed (or another MCP client)
- [Node.js](https://nodejs.org/en) (v18 or higher)
- [Apify API Token](https://docs.apify.com/platform/integrations/api#api-token) (`APIFY_API_TOKEN`)

### Install

Follow the steps below to set up and run the server on your local machine:
First, clone the repository using the following command:

```bash
git clone git@github.com:apify/actor-mcp-server.git
```
Navigate to the project directory and install the required dependencies:

```bash
cd actor-mcp-server
npm install
```

Before running the server, you need to build the project:

```bash
npm run build
```

#### Claude Desktop

Configure Claude Desktop to recognize the MCP server.

1. Open your Claude Desktop configuration and edit the following file:

    - On macOS: `~/Library/Application\ Support/Claude/claude_desktop_config.json`
    - On Windows: `%APPDATA%/Claude/claude_desktop_config.json`

    ```text
    "mcpServers": {
      "apify": {
        "command": "npx",
        "args": [
          "/path/to/actor-mcp-server/dist/index.js"
        ]
        "env": {
           "APIFY-API-TOKEN": "your-apify-api-token"
        }
      }
    }
    ```
    Alternatively, you can use the following command to select one or more Apify Actors:
    ```text
    "mcpServers": {
      "apify-mcp-server": {
        "command": "npx",
        "args": [
          "/path/to/actor-mcp-server/dist/index.js",
          "--actors",
          "lukaskrivka/google-maps-with-contact-details,apify/instagram-scraper"
        ]
        "env": {
           "APIFY-API-TOKEN": "your-apify-api-token"
        }
      }
    }
    ```

2. Restart Claude Desktop

    - Fully quit Claude Desktop (ensure it’s not just minimized or closed).
    - Restart Claude Desktop.
    - Look for the 🔌 icon to confirm that the Exa server is connected.

3. Examples

   You can ask Claude to perform web searches, such as:
    ```text
    Find and analyze recent research papers about LLMs.
    Find top 10 best Italian restaurants in San Francisco.
    Find and analyze instagram profile of the Rock.
    ```

#### Stdio clients

Create environment file `.env` with the following content:
```text
APIFY_API_TOKEN=your-apify-api-token
# ANTHROPIC_API_KEY is only required when you want to run examples/clientStdioChat.js
ANTHROPIC_API_KEY=your-anthropic-api-token
```
In the `examples` directory, you can find two clients that interact with the server via
standard input/output (stdio):
1. [`clientStdio.ts`](https://github.com/apify/actor-mcp-server/tree/main/src/examples/clientStdio.ts)
    This client script starts the MCP server with two specified Actors.
    It then calls the `apify/rag-web-browser` tool with a query and prints the result.
    It demonstrates how to connect to the MCP server, list available tools, and call a specific tool using stdio transport.
    ```bash
    node dist/examples/clientStdio.js
    ```

2. [`clientStdioChat.ts`](https://github.com/apify/actor-mcp-server/tree/main/src/examples/clientStdioChat.ts)
    This client script also starts the MCP server but provides an interactive command-line chat interface.
    It prompts the user to interact with the server, allowing for dynamic tool calls and responses.
    This example is useful for testing and debugging interactions with the MCP server in conversational manner.

    ```bash
    node dist/examples/clientStdioChat.js
    ```

# 👷🏼 Development

## Prerequisites

- [Node.js](https://nodejs.org/en) (v18 or higher)
- Python 3.6 or higher

Create environment file `.env` with the following content:
```text
APIFY_API_TOKEN=your-apify-api-token
# ANTHROPIC_API_KEY is only required when you want to run examples/clientStdioChat.js
ANTHROPIC_API_KEY=your-anthropic-api-token
```
## Local client (SSE)

To test the server with the SSE transport, you can use python script `examples/client_sse.py`:
Currently, the node.js client does not support to establish a connection to remote server witch custom headers.
You need to change URL to your local server URL in the script.

```bash
python src/examples/client_sse.py
```

## Debugging

Since MCP servers operate over standard input/output (stdio), debugging can be challenging.
For the best debugging experience, use the [MCP Inspector](https://github.com/modelcontextprotocol/inspector).

Build the actor-mcp-server package:

```bash
npm run build
```

You can launch the MCP Inspector via [`npm`](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm) with this command:

```bash
npx @modelcontextprotocol/inspector node /path/to/actor-mcp-server/dist/index.js --env APIFY_API_TOKEN=your-apify-api-token
```

Upon launching, the Inspector will display a URL that you can access in your browser to begin debugging.
