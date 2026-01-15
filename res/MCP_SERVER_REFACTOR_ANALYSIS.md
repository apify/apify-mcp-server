# MCP Server Refactoring: Migration to High-Level API

## Executive Summary

**What**: Refactor `src/mcp/server.ts` from the deprecated low-level `Server` API to the recommended high-level `McpServer` API.

**Why**: 
- The low-level API is deprecated by the MCP SDK maintainers
- The high-level API provides automatic tool management and notifications
- Opportunity to simplify architecture and reduce code by ~500 lines

**Impact**:
- All existing features preserved (dynamic tool loading, Actor-MCP proxy, notifications)
- Cleaner, more maintainable codebase
- Future-proof against SDK changes

**Effort**: 8-13 developer days

**Risk**: Low-Medium - requires coordination with `apify-mcp-server-internal` repo

---

## Executive Implementation Plan

### Approach: Callback-Per-Tool Architecture

Instead of a central dispatcher that checks `tool.type`, each tool is registered with its own callback that encapsulates execution logic.

**Before (Central Dispatcher):**
```
Request → Handler → Check type → Dispatch to correct execution
```

**After (Callback-Per-Tool):**
```
Request → McpServer → Tool's callback (knows how to execute itself)
```

### Key Changes

1. **Replace `Server` with `McpServer`** - Use high-level API as foundation
2. **Convert JSON Schema to Zod** - Use Zod v4 native JSON Schema conversion for Actor schemas
3. **Move execution logic to callbacks** - Each tool type has its own registration pattern
4. **Remove central dispatcher** - Delete ~300 lines of handler code
5. **Simplify tool storage** - Replace complex `ToolEntry` type with `RegisteredTool`

### Migration Phases

| Phase | Description | Days |
|-------|-------------|------|
| 1 | Setup, dependencies, infrastructure | 1 |
| 2 | Internal tools migration | 1-2 |
| 3 | Actor tools migration | 2-3 |
| 4 | Actor-MCP tools migration | 1-2 |
| 5 | Task support migration | 1-2 |
| 6 | Testing, cleanup, coordination | 2-3 |
| **Total** | | **8-13** |

### Dependencies

- No new dependency required for schema conversion (Zod v4 supports this natively)
- Coordinate with `apify-mcp-server-internal` repository

---

## Detailed Implementation Guide

This section provides comprehensive details for implementing the migration.

### Table of Contents

1. [Current Architecture Analysis](#1-current-architecture-analysis)
2. [Target Architecture](#2-target-architecture)
3. [Feature Preservation Matrix](#3-feature-preservation-matrix)
4. [Implementation Details](#4-implementation-details)
5. [Code Examples](#5-code-examples)
6. [Migration Steps](#6-migration-steps)
7. [Testing Strategy](#7-testing-strategy)
8. [Files to Modify](#8-files-to-modify)

---

### 1. Current Architecture Analysis

#### 1.1 Entry Point

File: `src/mcp/server.ts`

The `ActorsMcpServer` class uses:
- Low-level `Server` class from `@modelcontextprotocol/sdk/server/index.js`
- Manual request handlers via `server.setRequestHandler()`
- Custom `Map<string, ToolEntry>` for tool storage
- Manual `sendToolListChanged()` calls

#### 1.2 Tool Types (Current)

```typescript
// src/types.ts - Lines 135-174
type ToolEntry = HelperTool | ActorTool | ActorMcpTool;

type HelperTool = ToolBase & {
    type: 'internal';
    call: (toolArgs: InternalToolArgs) => Promise<object>;
};

type ActorTool = ToolBase & {
    type: 'actor';
    actorFullName: string;
    memoryMbytes?: number;
};

type ActorMcpTool = ToolBase & {
    type: 'actor-mcp';
    originToolName: string;
    actorId: string;
    serverId: string;
    serverUrl: string;
};
```

#### 1.3 Central Dispatcher (Current)

Location: `src/mcp/server.ts`, `setupToolHandlers()` method, lines 612-917

The current handler:
1. Validates token (lines 644-655)
2. Strips name prefix (lines 657-666)
3. Looks up tool by name OR actorFullName (lines 669-682)
4. Validates with AJV (lines 697-709)
5. Checks task support (lines 713-723)
6. Dispatches based on `tool.type`:
   - `'internal'` → calls `tool.call()` (lines 760-793)
   - `'actor-mcp'` → proxies to external MCP server (lines 795-841)
   - `'actor'` → calls Apify Actor (lines 843-887)

#### 1.4 Dynamic Tool Loading (Current)

```typescript
// Public API methods in ActorsMcpServer
loadToolsByName(toolNames: string[], apifyClient: ApifyClient)  // Line 255
loadActorsAsTools(actorIds: string[], apifyClient: ApifyClient) // Line 291
loadToolsFromUrl(url: string, apifyClient: ApifyClient)         // Line 306
upsertTools(tools: ToolEntry[], shouldNotify?: boolean)         // Line 335
removeToolsByName(names: string[], shouldNotify?: boolean)      // Line 316
```

#### 1.5 Tool Change Notifications (Current)

Two notification mechanisms:
1. **Custom callback** for Redis sync (hosted server):
   ```typescript
   registerToolsChangedHandler(handler: (toolNames: string[]) => void)
   ```
2. **MCP protocol notification**:
   ```typescript
   await sendNotification({ method: 'notifications/tools/list_changed' });
   ```

---

### 2. Target Architecture

#### 2.1 High-Level McpServer

```typescript
import { McpServer } from '@modelcontextprotocol/server';

class ActorsMcpServer {
    private mcpServer: McpServer;
    private registeredTools = new Map<string, RegisteredTool>();
    private actorFullNameMap = new Map<string, string>(); // actorFullName → toolName
    
    constructor(options: ServerOptions) {
        this.mcpServer = new McpServer(
            { name: SERVER_NAME, version: SERVER_VERSION },
            { capabilities: {...}, instructions: SERVER_INSTRUCTIONS }
        );
    }
}
```

#### 2.2 Tool Registration Patterns

Each tool type has a dedicated registration method that creates a self-contained callback:

```typescript
// Internal tools
registerInternalTool(tool: InternalToolDefinition): RegisteredTool

// Actor tools  
registerActorTool(actorDef: ActorDefinition): RegisteredTool

// Actor-MCP proxy tools
registerActorMcpTool(mcpTool: ExternalTool, serverUrl: string, actorId: string): RegisteredTool
```

#### 2.3 No Central Dispatcher

McpServer handles dispatch internally. Each tool's callback is self-contained:

```typescript
server.registerTool('tool-name', config, async (args, extra) => {
    // This callback knows everything it needs:
    // - What type of tool it is (closure context)
    // - How to execute (closure-captured functions)
    // - What telemetry to track (closure-captured config)
});
```

---

### 3. Feature Preservation Matrix

| Feature | Current Implementation | Target Implementation |
|---------|----------------------|----------------------|
| **Dynamic tool loading** | `loadActorsAsTools()` → `upsertTools()` → Map | `loadActorsAsTools()` → `registerTool()` |
| **Tool removal** | `removeToolsByName()` → Map.delete | `removeToolsByName()` → `RegisteredTool.remove()` |
| **Actor-MCP proxy** | Central handler checks type, connects client | Callback connects client, forwards notifications |
| **Tool change notifications** | Manual `sendToolListChanged()` | Automatic + custom handler wrapper |
| **AJV validation** | In central handler | Replaced with Zod (converted from JSON Schema) |
| **actorFullName lookup** | In central handler | Simple Map lookup + redirect |
| **Progress tracking** | `extra.sendNotification()` | Same (available in callback) |
| **Telemetry** | In central handler | Helper function in callbacks |
| **Skyfire mode** | Modify tool in `upsertTools()` | Modify before `registerTool()` |
| **Task support** | Manual task handlers | `experimental.tasks.registerToolTask()` |

---

### 4. Implementation Details

#### 4.1 JSON Schema to Zod Conversion

**Dependency**: None (use Zod v4 native JSON Schema conversion)

```typescript
// src/utils/schema-conversion.ts (NEW FILE)
import { z } from 'zod';

/**
 * Converts Actor input JSON Schema to Zod schema for McpServer registration.
 * 
 * @param jsonSchema - JSON Schema from Actor definition
 * @returns Zod schema compatible with McpServer.registerTool()
 */
export function convertActorSchemaToZod(jsonSchema: Record<string, unknown>): z.ZodTypeAny {
    try {
        // Zod v4 provides native JSON Schema conversion (use the official API name)
        return zodFromJsonSchema(jsonSchema);
    } catch (error) {
        // Fallback: accept any object if conversion fails
        log.warning('Failed to convert JSON Schema to Zod, using permissive schema', {
            error: error instanceof Error ? error.message : String(error),
        });
        return z.record(z.unknown());
    }
}
```

#### 4.2 Internal Tool Registration

```typescript
// src/mcp/tool-registration.ts (NEW FILE)

import type { McpServer, RegisteredTool, RequestHandlerExtra } from '@modelcontextprotocol/server';

export interface InternalToolDefinition {
    name: string;
    title?: string;
    description: string;
    inputSchema: z.ZodTypeAny;
    annotations?: ToolAnnotations;
    execute: (args: Record<string, unknown>, context: ToolContext) => Promise<CallToolResult>;
}

export interface ToolContext {
    extra: RequestHandlerExtra;
    apifyToken: string;
    apifyClient: ApifyClient;
    apifyMcpServer: ActorsMcpServer;
    progressTracker: ProgressTracker | null;
}

export function registerInternalTool(
    server: McpServer,
    tool: InternalToolDefinition,
    getContext: (extra: RequestHandlerExtra) => ToolContext
): RegisteredTool {
    return server.registerTool(tool.name, {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
    }, async (args, extra) => {
        const context = getContext(extra);
        
        // Telemetry
        const telemetryData = prepareTelemetryData(tool.name, args, context);
        
        try {
            const result = await tool.execute(args, context);
            finalizeAndTrackTelemetry(telemetryData, TOOL_STATUS.SUCCESS);
            return result;
        } catch (error) {
            finalizeAndTrackTelemetry(telemetryData, TOOL_STATUS.ERROR);
            throw error;
        }
    });
}
```

#### 4.3 Actor Tool Registration

```typescript
export interface ActorToolConfig {
    actorFullName: string;
    description: string;
    inputSchema: Record<string, unknown>; // JSON Schema
    memoryMbytes: number;
    pictureUrl?: string;
}

export function registerActorTool(
    server: McpServer,
    config: ActorToolConfig,
    getContext: (extra: RequestHandlerExtra) => ToolContext,
    options: { skyfireMode?: boolean } = {}
): RegisteredTool {
    const toolName = actorNameToToolName(config.actorFullName);
    
    // Apply Skyfire modifications if needed
    let description = config.description;
    let inputSchema = config.inputSchema;
    
    if (options.skyfireMode) {
        description += `\n\n${SKYFIRE_TOOL_INSTRUCTIONS}`;
        inputSchema = addSkyfirePayIdProperty(inputSchema);
    }
    
    // Convert JSON Schema to Zod
    const zodSchema = convertActorSchemaToZod(inputSchema);
    
    return server.registerTool(toolName, {
        title: config.actorFullName,
        description,
        inputSchema: zodSchema,
        execution: { taskSupport: 'optional' },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            openWorldHint: true,
        },
    }, async (args, extra) => {
        const context = getContext(extra);
        const { apifyClient, progressTracker } = context;
        
        // Telemetry
        const telemetryData = prepareTelemetryData(config.actorFullName, args, context);
        
        try {
            // Start progress tracking
            progressTracker?.start();
            
            const result = await callActorGetDataset(
                config.actorFullName,
                args,
                apifyClient,
                { memoryMbytes: config.memoryMbytes },
                progressTracker,
                extra.signal // Cancellation support
            );
            
            if (result === null) {
                // Cancelled
                return { content: [] };
            }
            
            finalizeAndTrackTelemetry(telemetryData, TOOL_STATUS.SUCCESS);
            return buildActorResponseContent(result);
        } catch (error) {
            finalizeAndTrackTelemetry(telemetryData, TOOL_STATUS.ERROR);
            throw error;
        }
    });
}
```

#### 4.4 Actor-MCP Proxy Tool Registration

```typescript
export interface ActorMcpToolConfig {
    name: string;           // Original tool name on external server
    description: string;
    inputSchema: Record<string, unknown>;
    annotations?: ToolAnnotations;
    serverUrl: string;
    actorId: string;
}

export function registerActorMcpTool(
    server: McpServer,
    config: ActorMcpToolConfig,
    getApifyToken: () => string
): RegisteredTool {
    const toolName = getProxyMCPServerToolName(config.serverUrl, config.name);
    const zodSchema = convertActorSchemaToZod(config.inputSchema);
    
    return server.registerTool(toolName, {
        title: config.name,
        description: config.description,
        inputSchema: zodSchema,
        annotations: config.annotations,
    }, async (args, extra) => {
        const apifyToken = getApifyToken();
        
        log.info('Calling Actor-MCP', {
            actorId: config.actorId,
            toolName: config.name,
            input: args,
        });
        
        const client = await connectMCPClient(config.serverUrl, apifyToken);
        if (!client) {
            throw new McpError(
                ErrorCode.InternalError,
                `Failed to connect to MCP server at "${config.serverUrl}".`
            );
        }
        
        try {
            // Forward notifications from external server
            client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
                extra.sendNotification(notification);
            });
            
            // Proxy the tool call
            const result = await client.callTool({
                name: config.name, // Original tool name
                arguments: args,
            });
            
            return result as CallToolResult;
        } finally {
            await client.close();
        }
    });
}
```

#### 4.5 ActorsMcpServer Class (Refactored)

```typescript
// src/mcp/server.ts (REFACTORED)

import { McpServer, RegisteredTool } from '@modelcontextprotocol/server';

export class ActorsMcpServer {
    private mcpServer: McpServer;
    
    // Tool management
    private registeredTools = new Map<string, RegisteredTool>();
    private actorFullNameToToolName = new Map<string, string>();
    
    // Notifications
    private toolsChangedHandler: ((toolNames: string[]) => void) | null = null;
    
    constructor(options: ActorsMcpServerOptions) {
        this.mcpServer = new McpServer(
            {
                name: SERVER_NAME,
                version: SERVER_VERSION,
                websiteUrl: APIFY_MCP_URL,
            },
            {
                capabilities: {
                    logging: {},
                    prompts: { listChanged: false },
                    resources: options.skyfireMode ? { listChanged: false } : undefined,
                    tools: { listChanged: true },
                },
                instructions: SERVER_INSTRUCTIONS,
            }
        );
        
        // Register initial internal tools
        this.registerInitialTools();
        
        // Setup prompts
        this.setupPrompts();
        
        // Setup resources (if Skyfire mode)
        if (options.skyfireMode) {
            this.setupResources();
        }
    }
    
    // === Public API (Preserved) ===
    
    public listToolNames(): string[] {
        return Array.from(this.registeredTools.keys());
    }
    
    public listAllToolNames(): string[] {
        return this.listToolNames();
    }
    
    public async loadActorsAsTools(
        actorIds: string[],
        apifyClient: ApifyClient
    ): Promise<ToolEntry[]> {
        const actorDefinitions = await fetchActorDefinitions(actorIds, apifyClient);
        const tools: ToolEntry[] = [];
        
        for (const actorDef of actorDefinitions) {
            if (isActorMcpServer(actorDef)) {
                // Load tools from external MCP server
                const mcpTools = await this.loadMcpServerTools(actorDef, apifyClient);
                tools.push(...mcpTools);
            } else {
                // Register regular Actor tool
                const tool = this.registerActorToolFromDefinition(actorDef);
                tools.push(tool);
            }
        }
        
        this.notifyToolsChanged();
        return tools;
    }
    
    public removeToolsByName(names: string[], shouldNotify = true): void {
        for (const name of names) {
            const registered = this.registeredTools.get(name);
            if (registered) {
                registered.remove(); // McpServer API
                this.registeredTools.delete(name);
                
                // Clean up actorFullName mapping
                for (const [fullName, toolName] of this.actorFullNameToToolName) {
                    if (toolName === name) {
                        this.actorFullNameToToolName.delete(fullName);
                        break;
                    }
                }
            }
        }
        
        if (shouldNotify) {
            this.notifyToolsChanged();
        }
    }
    
    public registerToolsChangedHandler(handler: (toolNames: string[]) => void): void {
        this.toolsChangedHandler = handler;
    }
    
    public unregisterToolsChangedHandler(): void {
        this.toolsChangedHandler = null;
    }
    
    // === Connection ===
    
    public async connect(transport: Transport): Promise<void> {
        await this.mcpServer.server.connect(transport);
    }
    
    public async close(): Promise<void> {
        // Clean up all tools
        for (const [name, tool] of this.registeredTools) {
            tool.remove();
        }
        this.registeredTools.clear();
        this.actorFullNameToToolName.clear();
        
        await this.mcpServer.server.close();
    }
    
    // === Private Methods ===
    
    private notifyToolsChanged(): void {
        if (this.toolsChangedHandler) {
            this.toolsChangedHandler(this.listAllToolNames());
        }
        // McpServer automatically sends tools/list_changed
    }
    
    private registerActorToolFromDefinition(actorDef: ActorDefinition): RegisteredTool {
        const toolName = actorNameToToolName(actorDef.actorFullName);
        
        const registered = registerActorTool(
            this.mcpServer,
            {
                actorFullName: actorDef.actorFullName,
                description: actorDef.description,
                inputSchema: actorDef.inputSchema,
                memoryMbytes: actorDef.memoryMbytes,
                pictureUrl: actorDef.pictureUrl,
            },
            (extra) => this.createToolContext(extra),
            { skyfireMode: this.options.skyfireMode }
        );
        
        this.registeredTools.set(toolName, registered);
        this.actorFullNameToToolName.set(actorDef.actorFullName, toolName);
        
        return registered;
    }
    
    private async loadMcpServerTools(
        actorDef: ActorDefinition,
        apifyClient: ApifyClient
    ): Promise<RegisteredTool[]> {
        const mcpServerUrl = await getActorMCPServerURL(actorDef.id, actorDef.webServerMcpPath);
        const client = await connectMCPClient(mcpServerUrl, this.apifyToken);
        
        if (!client) {
            return [];
        }
        
        try {
            const { tools } = await client.listTools();
            const registered: RegisteredTool[] = [];
            
            for (const tool of tools) {
                const reg = registerActorMcpTool(
                    this.mcpServer,
                    {
                        name: tool.name,
                        description: tool.description || '',
                        inputSchema: tool.inputSchema,
                        annotations: tool.annotations,
                        serverUrl: mcpServerUrl,
                        actorId: actorDef.id,
                    },
                    () => this.apifyToken
                );
                
                const toolName = getProxyMCPServerToolName(mcpServerUrl, tool.name);
                this.registeredTools.set(toolName, reg);
                registered.push(reg);
            }
            
            return registered;
        } finally {
            await client.close();
        }
    }
    
    private createToolContext(extra: RequestHandlerExtra): ToolContext {
        return {
            extra,
            apifyToken: this.apifyToken,
            apifyClient: new ApifyClient({ token: this.apifyToken }),
            apifyMcpServer: this,
            progressTracker: new ProgressTracker(extra.sendNotification),
        };
    }
}
```

---

### 5. Code Examples

#### 5.1 Before/After: Tool Lookup by actorFullName

**Before (in central handler):**
```typescript
const tool = Array.from(this.tools.values())
    .find((t) => t.name === name || (t.type === 'actor' && t.actorFullName === name));
```

**After (simple Map lookup):**
```typescript
// At registration time:
this.actorFullNameToToolName.set(actorDef.actorFullName, toolName);

// At lookup time (if needed for backward compatibility):
public getToolByName(name: string): RegisteredTool | undefined {
    // Try direct lookup first
    let tool = this.registeredTools.get(name);
    
    // Fall back to actorFullName lookup
    if (!tool) {
        const toolName = this.actorFullNameToToolName.get(name);
        if (toolName) {
            tool = this.registeredTools.get(toolName);
        }
    }
    
    return tool;
}
```

#### 5.2 Before/After: Skyfire Mode

**Before (in upsertTools):**
```typescript
if (this.options.skyfireMode && shouldModifyForSkyfire(tool)) {
    const modifiedTool = cloneToolEntry(tool);
    modifiedTool.description += SKYFIRE_TOOL_INSTRUCTIONS;
    modifiedTool.inputSchema = addSkyfirePayIdProperty(modifiedTool.inputSchema);
    this.tools.set(modifiedTool.name, modifiedTool);
}
```

**After (before registration):**
```typescript
// In registerActorTool()
if (options.skyfireMode) {
    description += `\n\n${SKYFIRE_TOOL_INSTRUCTIONS}`;
    inputSchema = addSkyfirePayIdProperty(inputSchema);
}
const zodSchema = convertActorSchemaToZod(inputSchema);
// Then register with modified schema
```

#### 5.3 Before/After: Progress Tracking

**Before (in central handler):**
```typescript
if (tool.type === 'actor') {
    const progressTracker = new ProgressTracker(extra.sendNotification);
    const result = await callActorGetDataset(..., progressTracker);
}
```

**After (in callback):**
```typescript
// In Actor tool callback
async (args, extra) => {
    const progressTracker = new ProgressTracker(extra.sendNotification);
    const result = await callActorGetDataset(..., progressTracker);
    return buildActorResponseContent(result);
}
```

---

### 6. Migration Steps

#### Step 1: Confirm Zod v4 JSON Schema Support

- Use Zod v4 native JSON Schema conversion (no extra dependency)
- Align on the exact Zod v4 API name during implementation

#### Step 2: Create Schema Conversion Utility

Create `src/utils/schema-conversion.ts`:
- `convertActorSchemaToZod()` function using Zod v4 conversion
- Error handling for conversion failures
- Unit tests for various schema patterns

#### Step 3: Create Tool Registration Module

Create `src/mcp/tool-registration.ts`:
- `registerInternalTool()` function
- `registerActorTool()` function
- `registerActorMcpTool()` function
- Type definitions for tool configs

#### Step 4: Migrate Internal Tools

1. Update `src/tools/helpers.ts` to export tool definitions (not ToolEntry)
2. Update internal tools in `src/tools/` to use new registration pattern
3. Tools to migrate:
   - `search-actors` (store_collection.ts)
   - `fetch-actor-details` (fetch-actor-details.ts)
   - `call-actor` (actor.ts)
   - `get-actor-output` (get-actor-output.ts)
   - `add-tool` (helpers.ts)
   - `search-apify-docs` (search-apify-docs.ts)
   - `fetch-apify-docs` (fetch-apify-docs.ts)

#### Step 5: Migrate Actor Tools

1. Update `getActorsAsTools()` in `src/tools/actor.ts`
2. Replace `ActorTool` type with `ActorToolConfig`
3. Use `registerActorTool()` instead of building ToolEntry

#### Step 6: Migrate Actor-MCP Tools

1. Update `getMCPServersAsTools()` in `src/mcp/proxy.ts`
2. Replace `ActorMcpTool` type with `ActorMcpToolConfig`
3. Use `registerActorMcpTool()` instead of building ToolEntry

#### Step 7: Refactor ActorsMcpServer

1. Replace `Server` with `McpServer`
2. Replace `Map<string, ToolEntry>` with `Map<string, RegisteredTool>`
3. Remove `setupToolHandlers()` method entirely
4. Update public API methods to use new registration
5. Keep `toolsChangedHandler` mechanism for Redis sync

#### Step 8: Update Task Support

1. Evaluate `experimental.tasks.registerToolTask()` API
2. If stable enough, migrate Actor tools to use it
3. Otherwise, keep current task implementation via callbacks

#### Step 9: Clean Up

1. Remove `ToolEntry` type from `src/types.ts`
2. Remove central dispatcher code from `src/mcp/server.ts`
3. Remove unused imports and helpers
4. Update all imports across the codebase

#### Step 10: Testing

1. Run existing unit tests - fix failures
2. Run existing integration tests - fix failures
3. Add new tests for schema conversion
4. Add new tests for tool registration patterns
5. Manual testing with MCP clients

#### Step 11: Coordinate with apify-mcp-server-internal

1. Review public API changes
2. Update hosted server integration
3. Test in staging environment

---

### 7. Testing Strategy

#### 7.1 Unit Tests

| Test Area | File | Tests |
|-----------|------|-------|
| Schema conversion | `tests/unit/schema-conversion.test.ts` | JSON Schema → Zod for various patterns |
| Tool registration | `tests/unit/tool-registration.test.ts` | Each registration function |
| Actor tools | `tests/unit/tools.actor.test.ts` | Update existing tests |

#### 7.2 Integration Tests

| Test | Description |
|------|-------------|
| Tool listing | Verify `tools/list` returns correct tools |
| Tool execution | Verify each tool type executes correctly |
| Dynamic loading | Verify `loadActorsAsTools()` works |
| Tool removal | Verify `removeToolsByName()` works |
| Notifications | Verify `tools/list_changed` is sent |

#### 7.3 Manual Testing

1. Connect MCP client (Claude Desktop, VS Code)
2. List tools - verify all appear
3. Execute each tool type
4. Add tool dynamically
5. Remove tool
6. Verify progress notifications work

---

### 8. Files to Modify

#### New Files

| File | Purpose |
|------|---------|
| `src/utils/schema-conversion.ts` | JSON Schema → Zod conversion |
| `src/mcp/tool-registration.ts` | Tool registration factory functions |
| `tests/unit/schema-conversion.test.ts` | Schema conversion tests |
| `tests/unit/tool-registration.test.ts` | Registration tests |

#### Modified Files

| File | Changes |
|------|---------|
| `src/mcp/server.ts` | Major refactor - replace Server with McpServer, remove handlers |
| `src/types.ts` | Remove `ToolEntry`, `ActorTool`, `ActorMcpTool`, `HelperTool` |
| `src/tools/actor.ts` | Update `getActorsAsTools()` |
| `src/tools/helpers.ts` | Update tool exports |
| `src/mcp/proxy.ts` | Update `getMCPServerTools()` |
| `package.json` | No change required for schema conversion |

#### Removed Code

| Location | Lines | Description |
|----------|-------|-------------|
| `src/mcp/server.ts` | ~300 | `setupToolHandlers()` method |
| `src/mcp/server.ts` | ~50 | Central dispatcher logic |
| `src/types.ts` | ~40 | `ToolEntry` discriminated union |

---

### 9. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| JSON Schema conversion fails for some schemas | Medium | High | Fallback to permissive schema; keep AJV as backup validator |
| Task API changes (experimental) | Medium | Medium | Implement tasks in callbacks, don't depend on experimental API |
| Public API breaks apify-mcp-server-internal | Low | High | Keep method signatures; coordinate before merging |
| Performance regression | Low | Medium | Profile registration; cache converted schemas |

---

### 10. Success Criteria

- [ ] All existing unit tests pass
- [ ] All existing integration tests pass
- [ ] Code reduction of ~400+ lines
- [ ] No public API signature changes
- [ ] `apify-mcp-server-internal` works without changes
- [ ] All tool types execute correctly
- [ ] Dynamic tool loading works
- [ ] Tool change notifications work
- [ ] Progress tracking works
- [ ] Telemetry works

---

### 11. Alternative: FastMCP Framework

**FastMCP** ([punkpeye/fastmcp](https://github.com/punkpeye/fastmcp)) is a third-party TypeScript framework built on top of the official MCP SDK that could potentially simplify this codebase further.

#### What FastMCP Provides

FastMCP is essentially an opinionated wrapper around the low-level `Server` class (the same one we currently use) that handles many implementation details automatically:

- **Simple Tool API**: `server.addTool()` / `removeTool()` with automatic `tools/list_changed` notifications
- **Built-in Schema Support**: Uses Standard Schema spec (Zod, ArkType, Valibot) — no JSON Schema conversion needed
- **Session Management**: Built-in `FastMCPSession` class handles per-connection state
- **Multi-Transport**: Stdio, HTTP streaming, and SSE support via `mcp-proxy` dependency
- **Progress & Streaming**: `reportProgress()` and `streamContent()` available in tool context
- **OAuth & Auth**: Built-in authentication and OAuth proxy support
- **Health Endpoints**: Built-in `/health` and `/ready` endpoints for HTTP transports

#### Potential Benefits for apify-mcp-server

| Feature | Current Implementation | With FastMCP |
|---------|----------------------|--------------|
| Tool registration | Manual `Map<string, ToolEntry>` + handler dispatch | `server.addTool()` with callbacks |
| Dynamic tool changes | Manual `sendToolListChanged()` | Automatic on `addTool()`/`removeTool()` |
| Schema handling | AJV validation with JSON Schema | Native Zod via Standard Schema |
| HTTP transport | Custom implementation | Built-in via `mcp-proxy` |
| Progress notifications | Custom `ProgressTracker` | Built-in `reportProgress()` context |

#### Concerns and Considerations

1. **External Dependency**: Adds another abstraction layer and dependency (`fastmcp` + `mcp-proxy`)
2. **Less Control**: FastMCP is opinionated — custom behaviors like Actor-MCP proxy forwarding may need workarounds
3. **Maintenance Risk**: Depends on third-party maintenance vs. official SDK
4. **Actor-MCP Proxy**: Our proxy tool pattern (forwarding to external MCP servers) may require custom implementation
5. **Hosted Server Integration**: `apify-mcp-server-internal` coordination may be more complex

#### Recommendation

FastMCP could simplify the codebase, but a **detailed analysis is needed** to verify:
- Whether Actor-MCP proxy tools can be implemented cleanly
- Compatibility with our telemetry and hosted server requirements
- Migration effort compared to the McpServer high-level API approach

**Next Steps** (if pursuing FastMCP):
1. Create a proof-of-concept branch migrating internal tools to FastMCP
2. Evaluate Actor-MCP proxy tool implementation feasibility
3. Test integration with `apify-mcp-server-internal`
4. Compare complexity/LOC reduction vs. McpServer migration
