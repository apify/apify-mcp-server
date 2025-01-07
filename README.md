## Apify Model Context Protocol (MCP) Server

Implementation of an MCP server for [Apify Actors](https://apify.com/store).
This server enables interaction with one or more Apify Actors that can be defined in the MCP server configuration.

The server can be used in two ways:
- **MCP Server Actor** - Actor runs an HTTP server that supports the MCP protocol via SSE (Server-Sent Events).
- **MCP Server CLI** - Command-line interface that supports the MCP protocol via stdio.

## 🔄 What is model context protocol?

The Model Context Protocol (MCP) allows AI applications (and AI agents), such as Claude Desktop, to connect to external tools and data sources.
MCP is an open protocol that enables secure, controlled interactions between AI applications, AI Agents, and local or remote resources.

## 🎯 What does this MCP server do?

The MCP Server Actor allows an AI assistant to:
- Use any [Apify Actor](https://apify.com/store) as a tool to perform a specific task.
- For example:
  - [Google Maps Email Extractor](https://apify.com/lukaskrivka/google-maps-with-contact-details) scrape websites of Google Maps places for contact details and get email addresses, website, location, address, zipcode, phone number, social media links.
  - [Facebook Posts Scraper](https://apify.com/apify/facebook-posts-scraper) extract data from hundreds of Facebook posts from one or multiple Facebook pages and profiles
  - [Instagram Scraper](https://apify.com/apify/instagram-scraper) scrape and download Instagram posts, profiles, places, hashtags, photos, and comments
  - [RAG Web Browser](https://apify.com/apify/web-scraper) perform web search, scrape the top N URLs from the results, and return their cleaned content as Markdown

## 🧱 Components

### Tools

Any [Apify Actor](https://apify.com/store) can be used as a tool.
The tool name must always be the full Actor name, such as `lukaskrivka/google-maps-with-contact-details`, and the arguments represent the input parameters for the Actor.
Please see the examples below and refer to the specific Actor's documentation for a list of available arguments.

### Prompt & Resources

The server does not provide any resources and prompts.

## ⚙️ Usage

The Apify MCP Server can be used in two ways: **as an Apify Actor** running at Apify platform
or as a **local server** running on your machine.

### MCP Server Actor

#### Standby web server

The Actor runs in [**Standby mode**](https://docs.apify.com/platform/actors/running/standby) with an HTTP web server that receives and processes requests.

##### 1. Start server with selected Actors

To use the Apify MCP Server with a custom set of Actors (e.g. Google Maps Email Extractor, Facebook Posts Scraper),
send an HTTP GET request with your [Apify API token](https://console.apify.com/settings/integrations) to the following URL.
Provide a comma-separated list of Actors in the `actors` query parameter:
```
https://mcp-server.apify.actor?token=<APIFY_API_TOKEN>&actors=lukaskrivka/google-maps-with-contact-details,apify/facebook-posts-scraper
```
##### 2. Initiate Server-Sent-Events (SSE) connection
Establish an SSE connection by sending a GET request to the following URL:
```
https://mcp-server.apify.actor/sse?token=<APIFY_API_TOKEN>
```
The server will respond with a `sessionId`, which you can use to send messages to the server:
```shell
event: endpoint
data: /message?sessionId=a1b
```

##### 3. Send a message to the server

Send a message by making a POST request with the `sessionId`:
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

##### 4: Receive the response

The server will invoke the specified Actor as a tool using the provided query parameters and stream the response back to the client via SSE.
The response will be returned as JSON text.

```text
event: message
data: {"result":{"content":[{"type":"text","text":"{\"searchString\":\"restaurants in San Francisco\",\"rank\":1,\"title\":\"Gary Danko\",\"description\":\"Renowned chef Gary Danko's fixed-price menus of American cuisine ... \",\"price\":\"$100+\"...}}]}}
```

## 🛠️ Configuration

### Prerequisites

- MacOS or Windows
- The latest version of Claude Desktop must be installed (or another MCP client)
- [Node.js](https://nodejs.org/en) (v18 or higher)
- [Apify API Token](https://docs.apify.com/platform/integrations/api#api-token) (`APIFY_API_TOKEN`)

### Install

Follow the steps below to set up and run the server on your local machine:
First, clone the repository using the following command:

```bash
git clone git@github.com:apify/mcp-server-rag-web-browser.git
```

Navigate to the project directory and install the required dependencies:

```bash
cd mcp-server-rag-web-browser
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
      "mcp-server-rag-web-browser": {
        "command": "npx",
        "args": [
          "/path/to/mcp-server-rag-web-browser/build/index.js"
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
    What is an MCP server and how can it be used?
    What is an LLM, and what are the recent news updates?
    Find and analyze recent research papers about LLMs.
    ```

## 👷🏼 Development

### Simple local client (stdio)

To test the server locally, you can use `example_client_stdio.ts`:

```bash
node build/example_client_stdio.js
```

The script will start the MCP server, fetch available tools, and then call the `search` tool with a query.

### Chat local client (stdio)

To run simple chat client, you can use `example_chat_stdio.ts`:

```bash
node build/example_chat_stdio.js
```
Here you can interact with the server using the chat interface.

### Test Server-Sent Events (SSE) Transport

The SSE transport enables **server-to-client streaming** while using **HTTP POST requests** for client-to-server communication.

#### Step 1: Start the Server

Start the server with the following command:

```bash
node build/sse.js
```

The server will start and listen on `http://localhost:3001`.

#### Step 2: Connect to the SSE Server (Client)

To connect to the SSE server, use the following command (acting as the client):

```bash
curl -X GET http://localhost:3001/sse
```

Upon connection, you will receive a message containing the `sessionId`, for example:

```text
event: endpoint
data: /message?sessionId=7bd075c8-bbd1-4854-884c-e6c837148b7b
```

#### Step 3: Send a Message to the Server

You can send a message to the server by making a POST request with the `sessionId` and your query:

```bash
curl -X POST "http://localhost:3001/message?session_id=181c7a3d-01a9-498e-8e16-5d5878832cd7" -H "Content-Type: application/json" -d '{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "arguments": { "query": "recent news about LLMs" },
    "name": "search"
  }
}'
```

#### Step 4: Receive the Response

For the POST request, the server will respond with:

```text
Accepted
```

The server will then invoke the `search` tool using the provided query and stream the response back to the client via SSE:

```text
event: message
data: {"result":{"content":[{"type":"text","text":"[{\"searchResult\":{\"title\":\"Language models recent news\",\"description\":\"Amazon Launches New Generation of LLM Foundation Model...\"}}
```

### Debugging

Call the RAG Web Browser Actor to test it:

```bash
APIFY_API_TOKEN=your-apify-api-token node build/example_call_web_browser.js
````

Since MCP servers operate over standard input/output (stdio), debugging can be challenging.
For the best debugging experience, use the [MCP Inspector](https://github.com/modelcontextprotocol/inspector).

Build the mcp-server-rag-web-browser package:

```bash
npm run build
```

You can launch the MCP Inspector via [`npm`](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm) with this command:

```bash
npx @modelcontextprotocol/inspector node ~/apify/mcp-server-rag-web-browser/build/index.js APIFY_API_TOKEN=your-apify-api-token
```

Upon launching, the Inspector will display a URL that you can access in your browser to begin debugging.
