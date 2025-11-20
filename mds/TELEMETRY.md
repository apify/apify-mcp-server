# Telemetry Implementation Plan

## Overview

This document outlines the implementation plan for analytics tracking in the Apify MCP Server using Segment. The goal is to track all tool calls to understand user behavior, tool usage patterns, and MCP client preferences.

**Note:** This document is intended for consumers of `ActorsMcpServer` in other repositories. It describes the telemetry API and how to configure it.

## Quick Reference

### ActorsMcpServerOptions

```typescript
interface ActorsMcpServerOptions {
  telemetryEnabled?: boolean;  // Default: true (enabled)
  telemetryEnv?: 'dev' | 'prod';  // Default: 'prod'
  transportType?: 'stdio' | 'http' | 'sse';
}
```

### Default Behavior
- **Telemetry**: Enabled by default (`telemetryEnabled: true`)
- **Environment**: Production by default (`telemetryEnv: 'prod'`)

### Configuration Precedence

Telemetry configuration can be set via multiple methods with the following precedence (highest to lowest):

1. **CLI arguments** (for stdio) or **URL query parameters** (for remote server)
2. **Environment variables** (`TELEMETRY_ENABLED`, `TELEMETRY_ENV`)
3. **Defaults** (`telemetryEnabled: true`, `telemetryEnv: 'prod'`)

#### Environment Variables

- `TELEMETRY_ENABLED`: Set to `true`, `1`, `false`, or `0` to enable/disable telemetry
- `TELEMETRY_ENV`: Set to `prod` or `dev` to specify the telemetry environment (only used when telemetry is enabled)

### Usage Examples

```typescript
// Enable telemetry with production environment (default)
const server = new ActorsMcpServer({
  telemetryEnabled: true,  // or omit (defaults to true)
  telemetryEnv: 'prod',    // or omit (defaults to 'prod')
  transportType: 'stdio',
});

// Enable telemetry with development environment (for debugging)
const server = new ActorsMcpServer({
  telemetryEnabled: true,
  telemetryEnv: 'dev',
  transportType: 'http',
});

// Disable telemetry
const server = new ActorsMcpServer({
  telemetryEnabled: false,
  transportType: 'sse',
});
```

## Data to Be Collected

### Required Fields per Tool Call

```json
{
  "userId": "APIFY_USER_ID",
  "event": "MCP Tool Call",
  "properties": {
    "app": "mcp_server",
    "mcp_client": "Claude Desktop",
    "transport_type": "stdio|http|sse",
    "server_version": "VERSION",
    "tool_name": "apify/instagram-scraper",
    "reason": "REASON_FOR_TOOL_CALL"
  },
  "timestamp": "ISO 8601 TIMESTAMP"
}
```

### Data Description

- **userId**: Apify user ID from authenticated token
  - Extracted from Apify API `/v2/users/me` endpoint using the token from `APIFY_TOKEN` env var or `~/.apify/auth.json`
  - Cached in memory using SHA-256 hashed token as key (prevents storing raw tokens)
  - Falls back to empty string if token is unavailable or API call fails
  - Used to identify frequent Apify MCP server users and their use cases
  - In Segment: Falls back to 'anonymous' if userId is empty string

- **event**: "MCP Tool Call" - Event name for all tool calls

- **MCP Client Name**: Which MCP client is being used (Claude Desktop, Cline, etc.)
  - Extracted from `initializeRequestData.params.clientInfo.name`
  - Falls back to 'unknown' if client name is unavailable
  - Helps understand client distribution and preferences
  - Informs which MCP spec features are most important
  - Reference: https://modelcontextprotocol.io/clients

- **Transport Type**: How server is accessed
  - `stdio`: Local/direct stdio connection (from `src/stdio.ts` entry point)
  - `http`: Remote HTTP streamable connection (from `src/actor/server.ts` with Streamable HTTP transport)
  - `sse`: Remote Server-Sent Events (SSE) connection (from `src/actor/server.ts` with SSE transport)
  - Passed via `ActorsMcpServerOptions.transportType`
  - Differentiates between local and remote MCP server instances and transport types

- **Server Version**: Apify MCP server version
  - Dynamically read from package.json via `getPackageVersion()` function in `src/const.ts`
  - Currently: '0.5.1' (from package.json)
  - Automatically stays in sync with package.json version
  - Safe fallback: '0.5.1' if package.json cannot be read

- **Tool Name**: Name of the tool being called
  - Critical for tool usage analytics
  - Examples: `search-actors`, `apify/instagram-scraper`, `call-actor`
  - For actor tools: uses full actor name (e.g., 'apify/instagram-scraper')
  - For internal tools: uses tool name

- **Reason**: Why the tool was called (LLM-provided reasoning)
  - ✅ **IMPLEMENTED**: Added as optional `reason` field to all tool input schemas when telemetry is enabled
  - Extracted from tool call arguments: `(args as Record<string, unknown>).reason?.toString() || ''`
  - When telemetry is disabled (`telemetryEnabled: false`): reason field is NOT added to schemas (saves schema overhead for tests)
  - When telemetry is enabled (`telemetryEnabled: true`): reason field is dynamically added to ALL tool schemas
  - Field description: "A brief explanation of why this tool is being called and what it will help you accomplish"
  - Allows LLMs to explain their tool selection and usage context
  - Originally proposed by @Jiří Spilka, similar to mcpcat.io implementation at MCP dev summit London

- **Timestamp**: When tool call occurred
  - Handled automatically by Segment SDK

## Analytics Use Cases

### 1. Tool Usage Distribution
- Which tools are used most frequently?
- Which tools are rarely/never used?
- Create tool usage distribution charts
- Better than Prometheus counters (more reliable per Reddit discussions)

### 2. Time-Series Tracking
- Tool call frequency over time
- Total tool calls per day/week/month
- Identify trends and peak usage periods

### 3. MCP Client Distribution
- Which MCP clients are most popular?
- Which features of MCP spec are most relied upon?
- Identify implementation priorities based on client needs

### 4. User Segmentation
- Identify frequent MCP server users
- Track use cases per user/organization
- Understand different user archetypes

### 5. Tool Call Reasoning
- Understand why specific tools are called
- Group tool calls by context (e.g., "researching Instagram profile", "monitoring for new posts")
- Create dashboards showing tool calls with reasoning/context
- Group by MCP session ID for full interaction flows

## Implementation Architecture

### Tool Call Flow

```
Tool Call Request
    ↓
[CallToolRequestSchema Handler in src/mcp/server.ts]
    ↓
Tool Validation
    ↓
[TELEMETRY] Extract userId from token
    ↓
[TELEMETRY] Log debug info
    ↓
Tool Execution
    ↓
Return Response
```

### Telemetry Module Structure

**File**: `src/telemetry.ts`

- **Singleton Pattern**: Map-based singleton clients per environment
  - Ensures only one Segment Analytics client per environment (`dev` or `prod`)
  - Safe for multiple `ActorsMcpServer` instances to share the same client
  - Lazy initialization on first `trackToolCall()` call

- **Functions**:
  - `getOrInitAnalyticsClient(env: 'dev' | 'prod'): Analytics`
    - Gets or initializes the client for the specified environment
    - Returns singleton instance
    - Never called directly from server code

  - `trackToolCall(userId: string, env: 'dev' | 'prod', properties: Record<string, string>): void`
    - Sends tool call event to Segment
    - Lazily initializes client if needed
    - Converts empty userId to 'anonymous' to comply with Segment API

### User Cache Module

**File**: `src/utils/user-cache.ts`

- **Caching Strategy**: In-memory cache with SHA-256 token hashing
  - Caches the full User object returned by Apify API
  - Uses token hash as cache key (not the raw token)
  - Prevents repeated API calls for the same token
  - Thread-safe Map-based storage

- **Functions**:
  - `getUserIdFromToken(token: string, apifyClient: ApifyClient): Promise<User | null>`
    - Fetches user info from `/v2/users/me` endpoint
    - Returns cached User object if available
    - Returns null if user not found or API call fails
    - Hashes token before using as cache key
    - Full User object is cached (contains id, username, email, etc.)

- **Type Definition**:
  - `CachedUserInfo` is a type alias for the User object returned by ApifyClient
  - Inferred from `Awaited<ReturnType<ReturnType<ApifyClient['user']>['get']>>`
  - Provides type safety while staying DRY (no duplicate interface)

### Server Integration

**File**: `src/mcp/server.ts`

#### ActorsMcpServerOptions Interface

When creating an `ActorsMcpServer` instance, use the following options:

```typescript
interface ActorsMcpServerOptions {
  telemetryEnabled?: boolean;  // Default: true
  telemetryEnv?: 'dev' | 'prod';  // Default: 'prod'
  transportType?: 'stdio' | 'http' | 'sse';
  // ... other options
}
```

**Usage Examples:**

```typescript
// Enable telemetry with production environment (default)
const server = new ActorsMcpServer({
  telemetryEnabled: true,  // or omit (defaults to true)
  telemetryEnv: 'prod',    // or omit (defaults to 'prod')
  transportType: 'stdio',
});

// Enable telemetry with development environment (for debugging)
const server = new ActorsMcpServer({
  telemetryEnabled: true,
  telemetryEnv: 'dev',
  transportType: 'http',
});

// Disable telemetry
const server = new ActorsMcpServer({
  telemetryEnabled: false,
  transportType: 'sse',
});
```

- **ActorsMcpServerOptions Interface Details**:
  - Added `telemetryEnabled?: boolean` option
    - `true` (default): Telemetry enabled
    - `false`: Telemetry disabled
    - If not explicitly set, reads from `TELEMETRY_ENABLED` env variable
    - Defaults to `true` when not set
  - Added `telemetryEnv?: 'dev' | 'prod'` option
    - `'prod'` (default): Use production Segment write key
    - `'dev'`: Use development Segment write key
    - Only used when `telemetryEnabled` is `true`
    - If not explicitly set, reads from `TELEMETRY_ENV` env variable
    - Defaults to `'prod'` when not set
  - Added `transportType?: 'stdio' | 'http' | 'sse'` option
    - `'stdio'`: Direct/local stdio connection
    - `'http'`: Remote HTTP streamable connection
    - `'sse'`: Remote Server-Sent Events (SSE) connection
    - Specifies how the server is being accessed
    - Passed to telemetry for transport type tracking
  - Added `initializeRequestData?: InitializeRequest` option (from MCP SDK)
    - Contains client info like `clientInfo.name`, capabilities, etc.
    - Injected via message interception or HTTP request body

- **Constructor** (lines 100-120):
  - If `telemetryEnabled` is not explicitly set, reads from `TELEMETRY_ENABLED` env variable
  - Parses env var value: `'true'` or `'1'` = true, `'false'` or `'0'` = false
  - If env var not set, defaults to `telemetryEnabled = true`
  - If `telemetryEnv` is not explicitly set, reads from `TELEMETRY_ENV` env variable
  - Validates env var value via `getTelemetryEnv()` (must be 'dev' or 'prod')
  - If env var not set or invalid, defaults to `telemetryEnv = 'prod'`
  - If `telemetryEnabled` is explicitly `true`, ensures `telemetryEnv` is set (defaults to 'prod')
  - Supports environment-based telemetry control for hosted deployments

- **Tool Call Handler** (lines 568-600, `CallToolRequestSchema`):
  - After tool validation and before execution
  - Extracts userId from token using `getUserIdFromToken()`
  - Logs debug information about the operation:
    - userId and whether user was found
    - Token availability status
  - Builds telemetry properties object with:
    - `app`: 'mcp_server' (identifies this server)
    - `mcp_client`: Client name from `initializeRequestData.params.clientInfo.name` or 'unknown'
    - `transport_type`: 'stdio', 'http', 'sse', or empty string
    - `server_version`: From `getPackageVersion()` (package.json version)
    - `tool_name`: Actor full name or internal tool name
    - `reason`: Extracted from tool arguments if provided, otherwise empty string
  - Logs full telemetry payload before sending (debug level)
  - Calls `trackToolCall()` with userId, telemetry environment, and properties

**File**: `src/utils/version.ts`

- **`getPackageVersion()` Function**:
  - Dynamically reads version from package.json at runtime
  - Used in telemetry to report current server version
  - Safely falls back to null if file cannot be read
  - Works in development and production environments (package.json included in npm files)

**File**: `src/utils/user-cache.ts`

- **`getUserIdFromToken(token: string, apifyClient: ApifyClient)` Function**:
  - Fetches user info from `/v2/users/me` Apify API endpoint
  - Caches full User object using token hash (SHA-256) as key
  - Returns cached User object if available (prevents repeated API calls)
  - Returns null if user not found or API call fails (safe fallback)
  - Token is hashed before caching to avoid storing raw tokens in memory

**File**: `src/stdio.ts`

- **Token Resolution** (lines 128-139):
  - First tries to read token from `APIFY_TOKEN` environment variable
  - Falls back to reading from `~/.apify/auth.json` if env var not set
  - Uses helper function `getTokenFromAuthFile()` to read auth file
  - JSON file is parsed and token is extracted from `token` key
  - Silently fails on file not found or parse errors (no error thrown)

- **Server Initialization** (lines 156-161):
  - Passes `transportType: 'stdio'` when creating ActorsMcpServer
  - Passes telemetry options from CLI flags (via yargs):
    - `--telemetry-enabled` (boolean, default: true) - documented for end users
    - `--telemetry-env` ('prod'|'dev', default: 'prod') - hidden flag for debugging only
  - CLI flags take precedence over environment variables (via yargs `.env()`)
  - Environment variables `TELEMETRY_ENABLED` and `TELEMETRY_ENV` are supported as fallback
  - Converts CLI flags to `telemetryEnabled` (boolean) and `telemetryEnv` ('dev'|'prod')

- **Message Interception** (lines 162-176):
  - Creates proxy for `transport.onmessage` to intercept MCP messages
  - Captures initialize message (first message with `method: 'initialize'`)
  - Extracts client information from initialize request data
  - Updates mcpServer.options.initializeRequestData with captured data
  - Comment explains this is a "hacky way to inject client information"
  - Falls back to 'unknown' if client name not found in initialize data

**File**: `src/telemetry.ts`

- **`parseBooleanFromString(value: string | undefined | null)` Function**:
  - Parses boolean values from environment variable strings
  - Accepts `'true'`, `'1'` as `true`
  - Accepts `'false'`, `'0'` as `false`
  - Returns `undefined` for unrecognized values
  - Used to parse `TELEMETRY_ENABLED` environment variable

- **`getTelemetryEnv(env?: string | null)` Function**:
  - Validates and normalizes telemetry environment value
  - Accepts `'dev'` or `'prod'`
  - Returns default (`'prod'`) for invalid or missing values
  - Used to parse `TELEMETRY_ENV` environment variable

- **`getOrInitAnalyticsClient(env: 'dev' | 'prod')` Function**:
  - Singleton pattern ensures only one Segment Analytics client per environment
  - Uses Map to store clients: `{ dev: Analytics, prod: Analytics }`
  - Lazy initialization on first call

- **`trackToolCall()` Function**:
  - Takes userId (from user cache or empty string)
  - Takes telemetry environment ('dev' or 'prod')
  - Takes properties object with telemetry data
  - Converts empty userId to 'anonymous' for Segment API compliance
  - Sends event to Segment with event name: "MCP Tool Call"

**File**: `package.json`

- **Files Array**:
  - Added `package.json` to `files` array
  - Ensures package.json is included in npm publish
  - Makes `getPackageVersion()` work in production environments

### Remote Server Integration (apify-mcp-server-internal)

The telemetry infrastructure is integrated into the remote server that hosts the MCP service at mcp.apify.com.

**File**: `src/server/shared.ts`

- **`injectRequestToolCallBodyParams()` Function**:
  - Injects `apifyToken`, `userRentedActorIds`, and `mcpSessionId` into tool call request params
  - Extracts session ID from two sources:
    - `mcp-session-id` header (for Streamable HTTP transport)
    - URL query parameters via `getURLSessionID()` (for legacy SSE transport)
  - Enables telemetry to track tool calls across different transport types
  - Provides fallback mechanism for session ID extraction

**File**: `src/server/streamable.ts`

- **Streamable HTTP Transport Handler**:
  - Modern HTTP streaming transport for persistent sessions
  - Session resumability support via `mcp-session-id` header

- **`handleNewSession()` Handler**:
  - Extracts `?telemetry-enabled` and `?telemetry-env` query parameters from request URL
  - URL parameters take precedence over environment variables
  - Falls back to `TELEMETRY_ENABLED` and `TELEMETRY_ENV` env vars if URL params not provided
  - Converts parameters to options:
    - `telemetryEnabled`: URL param > env var > default (true)
    - `telemetryEnv`: URL param > env var > default ('prod')
  - Passes to ActorsMcpServer constructor:
    - `transportType: 'http'` - identifies remote HTTP streamable connection
    - `telemetryEnabled` and `telemetryEnv` - per-session telemetry control
    - `initializeRequestData: req.body` - client info from HTTP request

- **`handleSessionRestore()` Handler**:
  - Restores session from Redis state for resumable connections
  - Same telemetry and transportType handling as handleNewSession()
  - Allows clients to resume sessions with telemetry disabled

**File**: `src/server/legacy-sse.ts`

- **Legacy SSE Transport Handler**:
  - Server-Sent Events transport (deprecated but still supported for backward compatibility)
  - Provides session resumability for older clients

- **`initMCPSession()` Handler** (lines 153-210):
  - Extracts `?telemetry-enabled` and `?telemetry-env` query parameters from response URL
  - URL parameters take precedence over environment variables
  - Falls back to `TELEMETRY_ENABLED` and `TELEMETRY_ENV` env vars if URL params not provided
  - Converts parameters to options:
    - `telemetryEnabled`: URL param > env var > default (true)
    - `telemetryEnv`: URL param > env var > default ('prod')
  - Creates ActorsMcpServer with:
    - `transportType: 'sse'` - identifies remote SSE connection
    - `telemetryEnabled` and `telemetryEnv` - per-session telemetry control
  - Message interception proxy (lines 203-210):
    - Proxies `transport.onmessage` to capture MCP initialize message
    - Extracts client information from initialize request data
    - Updates mcpServer.options.initializeRequestData with captured data
    - Calls original onmessage handler to continue processing

- **Per-Session Control**:
  - Both transports support `?telemetry-enabled=false` query parameter to disable telemetry
  - Optional `?telemetry-env=dev` parameter to use development workspace (for debugging only)
  - URL parameters take precedence over `TELEMETRY_ENABLED` and `TELEMETRY_ENV` environment variables
  - Environment variables can be used as fallback when URL parameters are not provided
  - Prevents test data from polluting production telemetry
  - Example: `https://mcp.apify.com/?telemetry-enabled=false` for streamable
  - Example: `https://mcp.apify.com/sse?telemetry-enabled=false` for SSE
  - Example: `https://mcp.apify.com/?telemetry-env=dev` for debugging (uses dev workspace)

**Test Configuration**:

- **`test/integration/tests/server-streamable.test.ts`**:
  - mcpUrl configured with `/?telemetry-enabled=false` query parameter
  - Prevents integration tests from sending telemetry events

- **`test/integration/tests/server-sse.test.ts`**:
  - mcpUrl configured with `/sse?telemetry-enabled=false` query parameter
  - Prevents integration tests from sending telemetry events

## Data Flow

### Available Information at Tool Call Time

From `CallToolRequestSchema` handler in `src/mcp/server.ts` (line 568+):
- `name`: Tool name (may have 'local__' prefix that is stripped)
- `args`: Validated input arguments (includes `reason` field when implemented)
- `apifyToken`: Apify API token (may be null in Skyfire mode)
- `userRentedActorIds`: List of rented actor IDs
- `progressToken`: Optional progress tracking token
- `meta`: Metadata including progressToken

From `ActorsMcpServer` instance:
- `this.options.telemetryEnabled`: Boolean indicating if telemetry is enabled (default: true)
- `this.options.telemetryEnv`: Telemetry environment ('dev' or 'prod', default: 'prod')
- `this.options.transportType`: Transport type ('stdio', 'http', or 'sse')
- `this.options.initializeRequestData`: MCP client info and capabilities
  - `params.clientInfo.name`: MCP client name (e.g., 'Claude Desktop', 'Cline')
  - `params.capabilities`: Client capabilities
  - `params.protocolVersion`: MCP protocol version

From `tool` entry:
- `tool.type`: Tool type ('internal', 'actor', 'actor-mcp')
- `tool.tool.name`: Tool name (internal)
- For actor tools: `actorFullName` (e.g., 'apify/instagram-scraper')

From `src/utils/version.ts`:
- `getPackageVersion()`: Current server version from package.json

### Token Resolution Flow

```
Tool Call Request
    ↓
APIFY_TOKEN env var available?
    ├─ YES → Use env var
    └─ NO → Check ~/.apify/auth.json
              ├─ YES → Read and parse JSON
              │         Extract 'token' field
              │         Use that token
              └─ NO → No token (null)
    ↓
Token available?
    ├─ YES → Create ApifyClient with token
    │        Call getUserIdFromToken()
    │        Return cached or fetched User object
    └─ NO → userId stays empty string
    ↓
Track telemetry with userId
```

### Transport Type Detection

Transport type is now passed via `ActorsMcpServerOptions`:
- **Stdio** (Local): When using `src/stdio.ts` entry point
  - Passes `transportType: 'stdio'` when creating ActorsMcpServer
  - Passes `telemetryEnabled` and `telemetryEnv` from CLI flags
  - Message interception proxy captures initialize request data from MCP protocol
  - Example: `npx @apify/actors-mcp-server --telemetry-enabled=false`
  - Example: `npx @apify/actors-mcp-server --telemetry-env=dev` (for debugging)

- **Streamable HTTP** (Remote): When using `src/actor/server.ts` with Streamable HTTP transport
  - Passes `transportType: 'http'` when creating ActorsMcpServer
  - Extracts `?telemetry-enabled` and `?telemetry-env` query parameters from URL
  - Client info available via `req.body` (InitializeRequest passed as initializeRequestData)
  - Connection: `https://mcp.apify.com/?telemetry-enabled=false`
  - Connection: `https://mcp.apify.com/?telemetry-env=dev` (for debugging)

- **Legacy SSE** (Remote): When using `src/actor/server.ts` with SSE transport
  - Passes `transportType: 'sse'` when creating ActorsMcpServer
  - Extracts `?telemetry-enabled` and `?telemetry-env` query parameters from URL
  - Message interception proxy captures initialize request data from MCP JSON-RPC messages
  - Connection: `https://mcp.apify.com/sse?telemetry-enabled=false`
  - Connection: `https://mcp.apify.com/sse?telemetry-env=dev` (for debugging)

## Implementation Notes

### Current Implementation Status

#### ✅ Completed
- Telemetry module with singleton Segment clients per environment
- Tool call tracking in `CallToolRequestSchema` handler at line 568 of `src/mcp/server.ts`
- Dynamic version reading from package.json via `getPackageVersion()` function in `src/utils/version.ts`
- Transport type option in ActorsMcpServerOptions interface
- Stdio transport passing `transportType: 'stdio'` and telemetry CLI flags in `src/stdio.ts`
- package.json included in npm build files
- User cache module with token hashing and in-memory caching in `src/utils/user-cache.ts`
- Token resolution from env var and ~/.apify/auth.json file in `src/stdio.ts`
- Debug logging for telemetry operations in tool call handler
- Full User object caching (not custom wrapper interface)
- Message interception proxy to capture initialize request data in stdio (`src/stdio.ts`)
- Streamable HTTP transport with telemetry query parameter support (`src/actor/server.ts`)
  - Extracts `?telemetry-enabled` and `?telemetry-env` query params
  - Falls back to `TELEMETRY_ENABLED` and `TELEMETRY_ENV` env vars when URL params not provided
  - Passes `transportType: 'http'` and telemetry options to ActorsMcpServer
- Legacy SSE transport with telemetry query parameter support (`src/actor/server.ts`)
  - Extracts `?telemetry-enabled` and `?telemetry-env` query params
  - Falls back to `TELEMETRY_ENABLED` and `TELEMETRY_ENV` env vars when URL params not provided
  - Message interception proxy to capture initialize request data from MCP protocol
  - Passes `transportType: 'sse'` and telemetry options
- Environment variable support for telemetry configuration
  - `TELEMETRY_ENABLED`: Set to `'true'`, `'1'`, `'false'`, or `'0'` to enable/disable telemetry
  - `TELEMETRY_ENV`: Set to `'prod'` or `'dev'` to specify telemetry environment
  - Used as fallback when CLI/URL parameters are not provided
  - Precedence: CLI/URL params > env vars > defaults
- Test configuration to prevent telemetry pollution
  - `test/integration/tests/server-streamable.test.ts`: Uses `/?telemetry-enabled=false`
  - `test/integration/tests/server-sse.test.ts`: Uses `/sse?telemetry-enabled=false`
- MCP session ID tracking and injection
  - **Stdio transport** (`src/stdio.ts`): Manually generates UUID4 session ID using `randomUUID()` from `node:crypto` module
    - Generated at startup (line 160 in stdio.ts)
    - Represents a single session interaction since stdio doesn't have built-in session IDs
    - Injected into all tool call messages via message interception proxy (lines 162-176 in stdio.ts)
  - **Streamable HTTP transport**: Extracts `mcp-session-id` header from request
  - **Legacy SSE transport**: Extracts session ID from URL query parameters via `getURLSessionID()`
  - Session ID injected into tool call request params for telemetry tracking
  - Supports cross-instance session correlation in distributed deployments
- **Reason field implementation** ✅
  - Dynamically added to all tool input schemas when telemetry is enabled (`telemetryEnabled: true`)
  - Optional string field with title "Reason" and guidance description
  - Extracted from tool arguments during tool call: `(args as Record<string, unknown>).reason?.toString() || ''`
  - Not added when telemetry is disabled (`telemetryEnabled: false`) (reduces schema overhead for tests)
  - All AJV validators updated with `additionalProperties: true` to accept the field
  - New tests verify: reason field presence/absence based on telemetry setting
  - Works with `upsertTools()` conditional modification logic alongside Skyfire mode

#### 🔲 Not Yet Implemented (TODOs)
- Implement anonymousId tracking for device/session identification

### Multi-Server Environment
- Multiple `ActorsMcpServer` instances may run simultaneously
  - For Stdio (local): Each connection gets its own server instance
  - For Streamable HTTP (remote): Sessions stored in memory and Redis
  - For Legacy SSE (remote): Sessions stored in memory and Redis
- Telemetry clients are shared via singleton Map pattern per environment
- User cache is global (shared across all server instances)
- Session data is stored in Redis for cross-instance resumability
- Per-session telemetry control via `?telemetry-enabled=false` query parameter prevents test pollution

### User Authentication
- Apify token extracted from `APIFY_TOKEN` env var first
- Falls back to `~/.apify/auth.json` if env var not set
- Token is hashed before caching (SHA-256)
- User ID cached using token hash as key
- May be empty in:
  - Skyfire payment mode (uses `skyfire-pay-id` instead)
  - Unauthenticated scenarios (future MCP documentation tools feature)
  - If token is invalid or user fetch fails

### Tool Input Schema Enhancement
- Currently: reason field is always empty string
- TODO: Add optional `reason` field to all tool input schemas
- LLMs will fill in reasoning for why they called the tool
- Enables dashboard and analytics on tool call context

### Version Management
- Server version is dynamically read from package.json at runtime
- Function: `getPackageVersion()` in `src/utils/version.ts`
- Automatically stays in sync with package.json version
- Works in development, production, and packaged environments
- Fallback: null if package.json cannot be read (logged as 'unknown' in telemetry)

### Debug Logging

All telemetry operations emit debug logs including:
- User info fetching: `userId`, `userFound` flag, token availability status
- Full telemetry payload before sending:
  - app ('mcp_server')
  - mcp_client (client name from initialize data or 'unknown')
  - transport_type ('stdio', 'http', 'sse', or empty string)
  - server_version (from package.json or 'unknown')
  - tool_name (actor full name or internal tool name)
  - reason (empty string)

Enable with `DEBUG=*` or `LOG_LEVEL=debug` to see telemetry details.

Example debug output:
```
Telemetry: fetched user info { userId: 'user-123', userFound: true }
Telemetry: tracking tool call { app: 'mcp_server', mcp_client: 'Claude Desktop', transport_type: 'stdio', server_version: '0.5.3', tool_name: 'apify/instagram-scraper', reason: '' }
```

### Future Enhancements

1. **Device ID / Anonymous ID**
   - Implement device ID tracking for session correlation
   - Track unauthenticated users via anonymousId
   - Link userId and anonymousId when user authenticates

2. **Session Tracking** ✅ Implemented
   - **Stdio** (`src/stdio.ts`): Manually generates UUID4 session ID using `randomUUID()` from `node:crypto`
     - Generated at startup (line 160 in stdio.ts) to represent a single session interaction
     - Since stdio doesn't have built-in session IDs, UUID4 is created for each stdio connection
     - Injected into all tool call messages via message interception proxy (lines 162-176)
     - Allows correlating multiple tool calls within the same session
   - **Streamable HTTP**: Extracts `mcp-session-id` header from request
     - Session ID extracted from request header and injected into tool call params
   - **Legacy SSE**: Extracts session ID from URL query parameters
     - Falls back to URL extraction when header not available
     - Enables session tracking across distributed server instances
   - Allows correlating multiple tool calls to a single user session
   - Supports session-level analytics and debugging

3. **Performance Metrics**
   - Track tool call duration
   - Monitor error rates by tool
   - Identify slow tools

4. **Custom Dashboards**
   - Tool call distribution over time
   - MCP client adoption trends
   - Tool reasoning/context browser
   - User journey analysis

## Segment Configuration

### Write Keys
- **Development**: `9rPHlMtxX8FJhilGEwkfUoZ0uzWxnzcT`
- **Production**: `cOkp5EIJaN69gYaN8bcp7KtaD0fGABwJ`

### Event Names
- `MCP Tool Call`: Fired every time a tool is called

### Integration
- Segment SDK: `@segment/analytics-node` v2.3.0
- Node.js requirement: 18+
- Batching: Default 20 messages per batch (SDK configuration)

## Testing & Validation

1. **Dev Environment**
  - Initialize server with `telemetryEnabled: true, telemetryEnv: 'dev'`
  - Or use CLI: `--telemetry-env=dev` (hidden flag for debugging)
  - Or use URL: `?telemetry-env=dev`
  - Verify events appear in Segment dev workspace

2. **Production**
  - Initialize server with `telemetryEnabled: true, telemetryEnv: 'prod'` (default)
  - Or use CLI: `--telemetry-enabled` (default: true)
  - Monitor Segment prod workspace for events

3. **No Telemetry**
  - Initialize server with `telemetryEnabled: false`
  - Or use CLI: `--telemetry-enabled=false`
  - Or use URL: `?telemetry-enabled=false`
  - Verify no tracking occurs
  - Verify no errors from missing telemetry

4. **Token Resolution**
  - Test with `APIFY_TOKEN` env var set
  - Test with only `~/.apify/auth.json` file
  - Test with both set (env var should take precedence)
  - Test with neither (should still work but no userId)

5. **User Cache**
  - Same token should return cached result (no API call)
  - Different token should trigger new API call
  - Invalid token should return null safely
  - Debug logs should show cache hits/misses

## References

- MCP Clients: https://modelcontextprotocol.io/clients
- mcpcat.io: Similar implementation with tool call reasoning
- Prometheus Discussion: https://www.reddit.com/r/PrometheusMonitoring/comments/1jyxnzv/prometheus_counters_very_unreliable_for_many/
- Apify API: `/v2/users/me` endpoint for user info
