# Patterns for Simplifying the Apify MCP Server Codebase

This document identifies good patterns from the **official TypeScript MCP SDK** and **FastMCP** framework that could help simplify and improve the current apify-mcp-server implementation.

---

## Executive Summary

The current codebase has grown organically and contains several areas where patterns from the SDK or FastMCP could significantly reduce complexity:

| Area | Current LOC | Potential Reduction | Priority |
|------|-------------|--------------------| ---------|
| Central Tool Dispatcher | ~300 lines | ~250 lines | High |
| Tool Type Discrimination | ~100 lines | ~50 lines | Medium |
| Progress Notification Handling | ~100 lines | ~30 lines | Medium |
| Schema Validation (AJV) | ~50 lines | ~20 lines | Low |
| Notification Management | ~30 lines | ~10 lines | Low |

---

## Pattern 1: Callback-Per-Tool Registration

### Current Implementation Problem

The current `setupToolHandlers()` method in `src/mcp/server.ts` uses a **central dispatcher** pattern (~300 lines) that:
1. Receives all tool calls in a single handler
2. Checks `tool.type` discriminator
3. Dispatches to appropriate execution logic

```typescript
// Current pattern (simplified)
this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = this.tools.get(name);
    
    if (tool.type === 'internal') {
        // ~30 lines of internal tool logic
    } else if (tool.type === 'actor-mcp') {
        // ~50 lines of proxy logic
    } else if (tool.type === 'actor') {
        // ~40 lines of Actor call logic
    }
    // + telemetry, validation, error handling...
});
```

### SDK Pattern: `McpServer.registerTool()` with Callbacks

The official SDK's high-level `McpServer` API uses **callback-per-tool** registration:

```typescript
// SDK pattern
server.registerTool('tool-name', {
    description: 'Tool description',
    inputSchema: zodSchema,
}, async (args, extra) => {
    // Self-contained execution logic
    // No type discrimination needed
    return { content: [...] };
});
```

### FastMCP Pattern: `addTool()` with Execute Function

FastMCP provides an even simpler API:

```typescript
// FastMCP pattern
server.addTool({
    name: 'tool-name',
    description: 'Tool description',
    parameters: z.object({ ... }),
    execute: async (args, context) => {
        // Self-contained, context provides everything needed
        return 'result';
    },
});
```

### Recommended Approach

**Create factory functions** that generate callbacks with captured context:

```typescript
// New pattern for apify-mcp-server
function createInternalToolCallback(tool: HelperTool): ToolCallback {
    return async (args, extra) => {
        const context = buildToolContext(extra);
        return await tool.call({ args, ...context });
    };
}

function createActorToolCallback(tool: ActorTool): ToolCallback {
    return async (args, extra) => {
        const progressTracker = createProgressTracker(extra);
        const result = await callActorGetDataset(tool.actorFullName, args, ...);
        return buildActorResponseContent(result);
    };
}

function createActorMcpToolCallback(tool: ActorMcpTool): ToolCallback {
    return async (args, extra) => {
        const client = await connectMCPClient(tool.serverUrl);
        return await client.callTool({ name: tool.originToolName, arguments: args });
    };
}
```

**Benefits:**
- Eliminates ~250 lines of central dispatcher code
- Each tool type is self-contained
- Easier to test individually
- New tool types don't require modifying central handler

---

## Pattern 2: Context Object for Tool Execution

### Current Implementation Problem

The current `InternalToolArgs` type passes many separate parameters:

```typescript
// Current pattern
type InternalToolArgs = {
    args: Record<string, unknown>;
    extra: RequestHandlerExtra;
    apifyMcpServer: ActorsMcpServer;
    mcpServer: Server;
    apifyToken: string;
    userRentedActorIds?: string[];
    progressTracker?: ProgressTracker | null;
};
```

Tools receive everything, even what they don't need, and the caller must assemble this object.

### FastMCP Pattern: Unified Context Object

FastMCP provides a clean `Context<T>` object:

```typescript
// FastMCP pattern
type Context<T> = {
    client: { version: ... };
    log: { debug, error, info, warn };
    reportProgress: (progress: Progress) => Promise<void>;
    session: T | undefined;
    sessionId?: string;
    streamContent: (content: Content) => Promise<void>;
};

// Tool receives only what it needs through context
execute: async (args, context) => {
    context.log.info('Processing...');
    await context.reportProgress({ progress: 50, total: 100 });
    return 'done';
}
```

### Recommended Approach

Create a unified `ToolContext` that encapsulates all execution-time needs:

```typescript
// Proposed pattern
interface ToolContext {
    // Apify-specific
    apifyToken: string;
    apifyClient: ApifyClient;
    
    // MCP protocol
    sendNotification: (notification: Notification) => Promise<void>;
    signal?: AbortSignal;
    
    // Utilities
    log: ContextLogger;
    progress: ProgressReporter | null;
    
    // Server reference (only if truly needed)
    server?: ActorsMcpServer;
}

function buildToolContext(extra: RequestHandlerExtra, options: ServerOptions): ToolContext {
    return {
        apifyToken: options.token || process.env.APIFY_TOKEN,
        apifyClient: new ApifyClient({ token: ... }),
        sendNotification: extra.sendNotification,
        signal: extra.signal,
        log: createContextLogger(extra),
        progress: createProgressReporter(extra),
    };
}
```

**Benefits:**
- Tools declare what they need, receive only that
- Easier to mock in tests
- Cleaner separation of concerns

---

## Pattern 3: Schema Validation with Zod Instead of AJV

### Current Implementation Problem

The codebase uses AJV for runtime validation with compiled validators:

```typescript
// Current pattern
type ToolBase = {
    inputSchema: ToolInputSchema;
    ajvValidate: ValidateFunction;
};

// Must compile schema separately
const ajvValidate = compileSchema(z.toJSONSchema(schema));

// Validation in handler
if (!tool.ajvValidate(args)) {
    throw new McpError(ErrorCode.InvalidParams, ...);
}
```

This requires:
- Maintaining both JSON Schema and validation function
- Manual compilation step
- Custom error message formatting

### FastMCP Pattern: Standard Schema with Direct Validation

FastMCP uses [Standard Schema](https://standardschema.dev/) which allows direct Zod validation:

```typescript
// FastMCP pattern - Zod directly
server.addTool({
    parameters: z.object({
        url: z.string().url(),
        maxResults: z.number().min(1).max(100),
    }),
    execute: async (args) => {
        // args is already validated and typed!
        return fetch(args.url);
    },
});

// Validation happens automatically via Standard Schema
const parsed = await tool.parameters['~standard'].validate(args);
if (parsed.issues) {
    // Handle errors
}
```

### SDK Pattern: McpServer with Zod

The official SDK's `McpServer.registerTool()` also accepts Zod schemas:

```typescript
// SDK pattern
server.registerTool('fetch', {
    inputSchema: z.object({
        url: z.string(),
    }),
}, async (args) => {
    // args typed from Zod schema
});
```

### Recommended Approach

For tools defined with Zod (internal tools), use Zod directly:

```typescript
// Proposed pattern for internal tools
const addToolSchema = z.object({
    actor: z.string().min(1),
});

export const addTool = {
    name: 'add-tool',
    schema: addToolSchema, // Zod schema
    execute: async (args: z.infer<typeof addToolSchema>, context: ToolContext) => {
        // args is typed!
    },
};

// Registration handles conversion
function registerInternalTool(server: McpServer, tool: InternalToolDef) {
    server.registerTool(tool.name, {
        inputSchema: tool.schema, // Zod passed directly
    }, (args) => tool.execute(args, buildContext()));
}
```

For Actor tools (JSON Schema from API), convert once at registration using Zod v4 native conversion:

```typescript
// For Actor tools, convert JSON Schema → Zod at registration time

function registerActorTool(server: McpServer, actorDef: ActorDefinition) {
    const zodSchema = zodFromJsonSchema(actorDef.inputSchema);
    
    server.registerTool(actorDef.name, {
        inputSchema: zodSchema,
    }, createActorToolCallback(actorDef));
}
```

**Benefits:**
- Single source of truth for schemas
- Type-safe argument handling
- Better error messages from Zod
- Removes ~50 lines of AJV setup code

---

## Pattern 4: Automatic Tool List Notifications

### Current Implementation Problem

The codebase manually sends `tools/list_changed` notifications:

```typescript
// Current pattern - manual notification
public upsertTools(tools: ToolEntry[], shouldNotify = false) {
    for (const tool of tools) {
        this.tools.set(tool.name, tool);
    }
    if (shouldNotify) this.notifyToolsChangedHandler();
}

// Callers must remember to notify
await sendNotification({ method: 'notifications/tools/list_changed' });
```

### FastMCP Pattern: Automatic Notifications

FastMCP automatically sends notifications when tools change:

```typescript
// FastMCP pattern - automatic
server.addTool({ ... });  // Automatically notifies clients
server.removeTool('name'); // Automatically notifies clients

// Under the hood
#toolsListChanged(tools: Tool<T>[]) {
    for (const session of this.#sessions) {
        session.toolsListChanged(tools);
    }
}
```

### SDK Pattern: RegisteredTool with Remove

The SDK's `McpServer.registerTool()` returns a `RegisteredTool` handle:

```typescript
// SDK pattern
const registered = server.registerTool('name', config, callback);

// Later, to remove:
registered.remove(); // Automatically notifies
```

### Recommended Approach

Wrap tool mutations to automatically send notifications:

```typescript
// Proposed pattern
class ToolRegistry {
    private tools = new Map<string, RegisteredTool>();
    private onChangeHandler?: (names: string[]) => void;
    
    register(name: string, config: ToolConfig, callback: ToolCallback): RegisteredTool {
        const registered = this.mcpServer.registerTool(name, config, callback);
        this.tools.set(name, registered);
        this.notifyChange();
        return registered;
    }
    
    remove(name: string): boolean {
        const tool = this.tools.get(name);
        if (tool) {
            tool.remove(); // SDK handles MCP notification
            this.tools.delete(name);
            this.notifyChange(); // For external handlers (Redis sync)
            return true;
        }
        return false;
    }
    
    private notifyChange() {
        this.onChangeHandler?.(this.listNames());
    }
}
```

**Benefits:**
- Impossible to forget notifications
- Single place for change tracking
- Works with both MCP protocol and external handlers

---

## Pattern 5: Progress Reporting via Context

### Current Implementation Problem

Progress tracking requires manual setup and passing of tracker:

```typescript
// Current pattern
const progressTracker = createProgressTracker(progressToken, extra.sendNotification);

// Must pass to functions
const result = await callActorGetDataset(..., progressTracker);

// Must stop manually
if (progressTracker) progressTracker.stop();
```

### FastMCP Pattern: Context-Based Progress

FastMCP provides progress reporting directly in the context:

```typescript
// FastMCP pattern
execute: async (args, { reportProgress }) => {
    await reportProgress({ progress: 0, total: 100 });
    
    // Do work...
    
    await reportProgress({ progress: 100, total: 100 });
    return 'done';
}
```

The implementation is simple:

```typescript
// FastMCP internal implementation
const reportProgress = async (progress: Progress) => {
    await this.#server.notification({
        method: 'notifications/progress',
        params: { ...progress, progressToken },
    });
};
```

### Recommended Approach

Include progress reporting in the tool context:

```typescript
// Proposed pattern
interface ToolContext {
    progress: {
        report: (current: number, total?: number, message?: string) => Promise<void>;
        startPolling: (runId: string, actorName: string) => void;
        stop: () => void;
    } | null;
}

function buildToolContext(extra: RequestHandlerExtra): ToolContext {
    const progressToken = extra.progressToken;
    
    return {
        progress: progressToken ? {
            report: async (current, total, message) => {
                await extra.sendNotification({
                    method: 'notifications/progress',
                    params: { progressToken, progress: current, total, message },
                });
            },
            startPolling: (runId, actorName) => { /* ... */ },
            stop: () => { /* ... */ },
        } : null,
    };
}

// Tool usage becomes cleaner
execute: async (args, context) => {
    context.progress?.report(0, 100, 'Starting...');
    const result = await doWork();
    context.progress?.report(100, 100, 'Complete');
    return result;
}
```

**Benefits:**
- No manual tracker creation/cleanup
- Progress availability is obvious from context
- Null-safe - tools don't need to check if tracking is available

---

## Pattern 6: Structured Error Handling

### Current Implementation Problem

Error handling is scattered with inconsistent patterns:

```typescript
// Current patterns (various locations)
throw new McpError(ErrorCode.InvalidParams, msg);

return buildMCPResponse({ texts: [msg], isError: true, toolStatus: TOOL_STATUS.SOFT_FAIL });

log.softFail(msg, { statusCode: 400 });
await this.server.sendLoggingMessage({ level: 'error', data: msg });
```

### FastMCP Pattern: UserError Class

FastMCP uses a dedicated error class for user-facing errors:

```typescript
// FastMCP pattern
import { UserError } from 'fastmcp';

execute: async (args) => {
    if (args.url.startsWith('https://blocked.com')) {
        throw new UserError('This URL is not allowed');
    }
    return await fetch(args.url);
}

// Framework catches and formats appropriately
catch (error) {
    if (error instanceof UserError) {
        return {
            content: [{ type: 'text', text: error.message }],
            isError: true,
        };
    }
    // Handle unexpected errors differently
}
```

### Recommended Approach

Create distinct error types for different scenarios:

```typescript
// Proposed pattern
// In src/errors.ts

/** Error that should be shown to the user (soft fail) */
export class UserError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UserError';
    }
}

/** Error indicating a tool was not found */
export class ToolNotFoundError extends UserError {
    constructor(toolName: string, availableTools: string[]) {
        super(`Tool "${toolName}" not found. Available: ${availableTools.join(', ')}`);
    }
}

/** Error indicating invalid input */
export class ValidationError extends UserError {
    constructor(toolName: string, errors: string[]) {
        super(`Invalid input for "${toolName}": ${errors.join('; ')}`);
    }
}

// Central error handler in tool execution
async function executeWithErrorHandling(callback: () => Promise<ToolResult>): Promise<ToolResult> {
    try {
        return await callback();
    } catch (error) {
        if (error instanceof UserError) {
            return { content: [{ type: 'text', text: error.message }], isError: true };
        }
        // Log unexpected errors, return generic message
        log.error('Unexpected error', { error });
        return { content: [{ type: 'text', text: 'An unexpected error occurred' }], isError: true };
    }
}
```

**Benefits:**
- Consistent error handling across all tools
- Clear distinction between user errors and system errors
- Centralized formatting
- Easier to add telemetry/logging

---

## Pattern 7: Type-Safe Tool Registration with Generics

### Current Implementation Problem

Tool types use a discriminated union which requires runtime type checks:

```typescript
// Current pattern
type ToolEntry = HelperTool | ActorTool | ActorMcpTool;

// Runtime discrimination needed
if (tool.type === 'internal') {
    await tool.call(args);
} else if (tool.type === 'actor') {
    await callActorGetDataset(tool.actorFullName, args);
}
```

### FastMCP Pattern: Generic Tool Types

FastMCP uses generics for type safety:

```typescript
// FastMCP pattern
type Tool<T, Params extends ToolParameters = ToolParameters> = {
    name: string;
    parameters?: Params;
    execute: (
        args: StandardSchemaV1.InferOutput<Params>,
        context: Context<T>,
    ) => Promise<...>;
};
```

### Recommended Approach

Use generics to infer types at compile time:

```typescript
// Proposed pattern
interface ToolDefinition<TSchema extends z.ZodType = z.ZodType> {
    name: string;
    schema: TSchema;
    execute: (args: z.infer<TSchema>, context: ToolContext) => Promise<ToolResult>;
}

function defineTool<T extends z.ZodType>(def: ToolDefinition<T>): ToolDefinition<T> {
    return def;
}

// Usage - fully typed
const searchTool = defineTool({
    name: 'search-actors',
    schema: z.object({
        query: z.string(),
        limit: z.number().default(10),
    }),
    execute: async (args, context) => {
        // args.query is typed as string
        // args.limit is typed as number
        const results = await search(args.query, args.limit);
        return { content: [...] };
    },
});
```

**Benefits:**
- Compile-time type checking
- IDE autocomplete for arguments
- No runtime type discrimination for internal tools

---

## Pattern 8: Session-Aware Operations

### Current Implementation Problem

Session ID is passed through `_meta` and extracted manually:

```typescript
// Current pattern
const params = request.params as ApifyRequestParams;
const mcpSessionId = params._meta?.mcpSessionId;
if (!mcpSessionId) {
    throw new Error('MCP Session ID is required');
}
```

### FastMCP Pattern: Session in Context

FastMCP provides session info directly in context:

```typescript
// FastMCP pattern
execute: async (args, { session, sessionId }) => {
    // sessionId is automatically extracted from headers
    // session contains authenticated user data
    return `Hello, ${session?.userId}!`;
}
```

### Recommended Approach

Include session info in the tool context:

```typescript
// Proposed pattern
interface ToolContext {
    session: {
        id: string;
        apifyToken: string;
        userRentedActorIds?: string[];
    };
}

// Built at request time
function buildToolContext(request: Request, extra: RequestHandlerExtra): ToolContext {
    const meta = request.params._meta as ApifyRequestParams['_meta'];
    
    return {
        session: {
            id: meta?.mcpSessionId ?? generateSessionId(),
            apifyToken: meta?.apifyToken ?? process.env.APIFY_TOKEN,
            userRentedActorIds: meta?.userRentedActorIds,
        },
        // ... other context
    };
}
```

**Benefits:**
- Session info always available
- No manual extraction in each handler
- Consistent access pattern

---

## Implementation Priority

### Phase 1: High Impact (Recommended First)

1. **Callback-Per-Tool Registration** (Pattern 1)
   - Highest LOC reduction (~250 lines)
   - Foundational for other patterns
   - Effort: 3-4 days

2. **Unified Tool Context** (Pattern 2)
   - Simplifies all tool implementations
   - Enables cleaner testing
   - Effort: 2 days

### Phase 2: Medium Impact

3. **Progress Reporting via Context** (Pattern 5)
   - Cleaner API for tools
   - Works well with Pattern 2
   - Effort: 1 day

4. **Structured Error Handling** (Pattern 6)
   - Consistency improvement
   - Better user experience
   - Effort: 1-2 days

### Phase 3: Lower Priority (Nice to Have)

5. **Zod-First Validation** (Pattern 3)
   - Removes AJV dependency for internal tools
   - Better TypeScript integration
   - Effort: 2-3 days (requires JSON Schema → Zod for Actors)

6. **Automatic Notifications** (Pattern 4)
   - Small improvement
   - Less error-prone
   - Effort: 0.5 day

7. **Type-Safe Registration** (Pattern 7)
   - Developer experience improvement
   - Effort: 1 day

8. **Session-Aware Operations** (Pattern 8)
   - Cleaner code
   - Effort: 0.5 day

---

## Summary

The key insight from both the SDK and FastMCP is **moving execution logic closer to where tools are defined**. Instead of a central dispatcher that knows about all tool types, each tool should carry its own execution logic.

This aligns with the principle of **encapsulation** - a tool knows how to execute itself, and the framework just orchestrates the lifecycle (validation, notification, error handling).

**Estimated total effort**: 10-14 days for full implementation
**Recommended minimum**: Patterns 1 + 2 (5-6 days) for highest impact

---

## References

- [Official MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [FastMCP Framework](https://github.com/punkpeye/fastmcp)
- [MCP Server Refactor Analysis](./MCP_SERVER_REFACTOR_ANALYSIS.md)
- [Standard Schema Specification](https://standardschema.dev/)
