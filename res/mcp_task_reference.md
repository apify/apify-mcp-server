# MCP Tasks and SDK Features Reference

Reference document for MCP protocol features relevant to the Apify MCP server.
Created during the #582 redesign (async call-actor + waitSecs).

## MCP Task Lifecycle

Tasks enable long-running tool execution with the "call-now, fetch-later" pattern.

### Task States

```
working → completed
working → failed
working → cancelled
working → input_required → working (elicitation loop)
```

Terminal states: `completed`, `failed`, `cancelled`. Cannot transition out.

### Protocol Flow

```
1. Client sends:  tools/call  with  params.task = { ttl: 60000 }
2. Server returns: { task: { taskId, status: "working", createdAt, ttl } }
3. Server runs tool in background (setImmediate)
4. Client polls:  tasks/get   → { status: "working", statusMessage: "Actor running (15s)..." }
5. Server sends:  notifications/tasks/status  (optional push)
6. Tool returns → server stores result → task status: "completed"
7. Client calls:  tasks/result → CallToolResult (the actual tool output)
```

### Task Support Declaration

Tools declare task support via `execution.taskSupport`:
- `"optional"` — can be called with or without tasks (default)
- `"required"` — MUST be called with task params
- `"forbidden"` — does NOT support tasks

### Key SDK Types

```typescript
// Task object
interface Task {
    taskId: string;            // 32 hex chars
    status: TaskStatus;        // "working" | "input_required" | "completed" | "failed" | "cancelled"
    ttl: number | null;
    createdAt: string;         // ISO 8601
    lastUpdatedAt: string;
    pollInterval?: number;     // Suggested polling interval (ms)
    statusMessage?: string;
}

// Client streaming API
type ResponseMessage =
    | { type: 'taskCreated', task: Task }
    | { type: 'taskStatus', task: Task }
    | { type: 'result', result: CallToolResult }
    | { type: 'error', error: McpError }

// TaskStore interface
interface TaskStore {
    createTask(params, requestId, request, sessionId?): Promise<Task>
    getTask(taskId, sessionId?): Promise<Task | null>
    storeTaskResult(taskId, status, result, sessionId?): Promise<void>
    getTaskResult(taskId, sessionId?): Promise<Result>
    updateTaskStatus(taskId, status, statusMessage?, sessionId?): Promise<void>
    listTasks(cursor?, sessionId?): Promise<{ tasks: Task[], nextCursor? }>
}
```

### How Our Server Implements Tasks

**Location**: `src/mcp/server.ts` → `executeToolAndUpdateTask()`

1. Tool call with `task` params → server creates task via `taskStore.createTask()`
2. Returns `{ task }` immediately to client
3. Runs tool in `setImmediate` callback (truly async)
4. Progress tracked via `ProgressTracker` with `taskId` — status messages flow to `taskStore.updateTaskStatus()`
5. Cancellation checks before execution, after execution, and before storing results
6. Tool result stored via `taskStore.storeTaskResult(taskId, 'completed', result)`

**Key**: The `mcpTaskExecution` flag on `InternalToolArgs` tells the tool it's running inside a task. Server-internal only, NOT a tool input parameter.

## MCP SDK Features (Available but Unused)

### Resource Links in Tool Results

Tools can return `ResourceLink` content blocks — references to resources without embedding data inline.

```typescript
// In CallToolResult.content:
{ type: "resource_link", uri: "apify://dataset/abc123", name: "Output", mimeType: "application/json" }
```

Clients that support resources can fetch the data automatically. Others ignore the link.
**Status**: Not used. Planned in roadmap #587 Phase 5.

### Dynamic Resource Notifications

```typescript
// Server notifies client that resource list changed:
server.sendResourceListChanged();

// Server notifies about a specific resource update:
notifications/resources/updated  { uri: "apify://dataset/abc123" }

// Client can subscribe to specific resources:
resources/subscribe  { uri: "apify://dataset/abc123" }
```

**Status**: Not used. Planned in roadmap #587 Phase 6.

### Resource Templates

```typescript
interface ResourceTemplate {
    uriTemplate: string;      // RFC 6570 URI template, e.g. "apify://run/{runId}/dataset"
    description?: string;
    mimeType?: string;
}
```

**Status**: Handler exists but returns empty array. Future: register dataset/KV store templates.

### Elicitation (User Input During Tool Execution)

Server can ask the client to get user input via forms:

```typescript
// Form mode:
elicitation/create {
    mode: "form",
    message: "Run web-scraper with 50 URLs? Estimated cost: $0.15",
    requestedSchema: {
        type: "object",
        properties: { confirm: { type: "boolean" } }
    }
}

// Response:
{ action: "accept" | "decline" | "cancel", content?: { confirm: true } }
```

Also supports URL mode (redirect to auth page, etc.).
**Status**: Not used. Planned in roadmap #587 Phase 8.

### Completion (Argument Autocompletion)

```typescript
// Client sends:
completion/complete {
    ref: { type: "ref/resource", uri: "apify://run/{runId}/dataset" },
    argument: { name: "runId", value: "abc" }
}

// Server responds:
{ completion: { values: ["abc123", "abc456"], hasMore: true } }
```

Works for prompt arguments, resource template variables, tool arguments.
**Status**: Not used. Planned in roadmap #587 Phase 9.

### Structured Content in Tool Results

```typescript
interface CallToolResult {
    content: ContentBlock[];           // text, image, audio, resource_link, embedded_resource
    structuredContent?: Record<string, unknown>;  // arbitrary JSON
    isError?: boolean;
}
```

**Status**: Actively used. All tools return `structuredContent` for widget rendering and LLM consumption.

## Server Capabilities (Current)

```typescript
{
    tools: { listChanged: true },
    tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
    resources: {},
    prompts: {},
    logging: {},
}
```

- `tools.listChanged` — sent when `add-actor` adds a new tool
- `tasks` — full implementation (create, get, result, cancel, list)
- `resources` — widgets + readme only, no dynamic resources
- `prompts` — 8 helper prompts
- `logging` — proxy with filtering

## Related Issues

- **#582** — Async call-actor + waitSecs on get-actor-run (core redesign)
- **#587** — Post-#582 roadmap (9 phases: direct actor tools, dataset tools, KV store, resource links, dynamic resources, elicitation, completion)
- **#588** — Actor tool naming convention (`actor-{name}-by-{author}`)
- **#579** — Original issue (superseded by #582)
