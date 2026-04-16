# Task status workaround: why errors are stored as 'completed'

## The problem

The MCP SDK's `requestStream()` (in `shared/protocol.js`) handles terminal task states differently:

- **`'completed'`** → calls `getTaskResult()` → yields `{ type: 'result', result }` → client gets the full `CallToolResult`
- **`'failed'`** → yields `{ type: 'error', error: "Task {id} failed" }` → client gets a generic error, **stored result is discarded**
- **`'cancelled'`** → same as failed, generic error

This means any result stored with `status: 'failed'` is never delivered to the client. The actual error text, x402 payment payload, structured content — all lost.

## What we do

We store **all** task results as `'completed'`, including errors. The error nature is conveyed through:

1. **`isError: true`** in the `CallToolResult` payload — this is what clients (mcpc, Claude, Cursor) use to determine success/failure
2. **`[error]` prefix** in `statusMessage` — so `tasks/list` and `tasks/get` polling clearly shows the task failed

### Affected paths in `executeToolAndUpdateTask()`

| Path | Result | Status | statusMessage |
|---|---|---|---|
| Success | tool output | `'completed'` | `tool-name: completed` |
| SOFT_FAIL (actor not found, validation) | error text + `isError: true` | `'completed'` | `[error] tool-name: Actor not found...` |
| Payment required (pre-flight) | x402 payload + `isError: true` | `'completed'` | `[error] tool-name: payment required` |
| Payment required (catch 402) | x402 payload + `isError: true` | `'completed'` | `[error] tool-name: payment required` |
| Hard error (5xx, network, etc.) | error text + `isError: true` | `'completed'` | `[error] tool-name: error text...` |
| Aborted (signal) | none | `'cancelled'` | `tool-name: aborted by client` |

### Why x402 payment specifically requires 'completed'

The mcpc bridge's `handlePaymentRequiredRetry()` inspects the tool result for `isError: true` + `x402Version` + `accepts` fields. If the task is stored as `'failed'`, the SDK never delivers the result, and the auto-pay retry never triggers.

## What should be fixed upstream

### SDK: `requestStream()` should deliver results for 'failed' tasks

Location: `@modelcontextprotocol/sdk/shared/protocol.js`, lines ~566-583

```javascript
// Current behavior (broken):
if (task.status === 'failed') {
    yield { type: 'error', error: new McpError(ErrorCode.InternalError, `Task ${taskId} failed`) };
}

// Desired behavior:
if (task.status === 'failed') {
    const result = await this.getTaskResult({ taskId }, resultSchema, options);
    yield { type: 'result', result };  // result has isError: true
}
```

The `'failed'` status was stored alongside a result via `storeTaskResult()`. The SDK should deliver that result, not discard it. The `isError` flag in the result already tells the client it's an error.

Alternatively, `requestStream()` could yield both the result and a status indicator, but the simplest fix is to treat `'failed'` the same as `'completed'` for result delivery.

### SDK: `requestStream()` 'failed' error should include statusMessage

Even without delivering the full result, the generic `"Task {id} failed"` message should at least include `task.statusMessage`:

```javascript
yield {
    type: 'error',
    error: new McpError(ErrorCode.InternalError, task.statusMessage || `Task ${taskId} failed`)
};
```

### SDK: `storeTaskResult()` should accept a statusMessage

Currently we use `storeTaskResultWithMessage()` which calls `updateTaskStatus('working', message)` then `storeTaskResult(status, result)` — two non-atomic calls. The SDK's `storeTaskResult()` should accept an optional `statusMessage` parameter to make this atomic.

### mcpc: `pollTask()` should fetch result for 'completed' tasks

Location: `mcp-cli/src/core/mcp-client.ts`, lines ~715-720

```javascript
// Current behavior (incomplete):
if (task.status === 'completed') {
    return { content: [{ type: 'text', text: task.statusMessage || 'Task completed' }] };
}

// Desired behavior:
if (task.status === 'completed') {
    const result = await this.getTaskResult(taskId);
    return result;
}
```

The polling fallback returns the `statusMessage` as fake content instead of fetching the actual stored result.

## When to remove this workaround

Once the SDK's `requestStream()` delivers results for `'failed'` tasks, we can:
1. Store errors as `'failed'` (semantically correct)
2. Remove the `[error]` prefix from statusMessages
3. Remove `storeTaskResultWithMessage()` if `storeTaskResult()` accepts statusMessage
