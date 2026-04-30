#!/usr/bin/env node
// Task-mode probe: call-actor under MCP task augmentation, with progress + cancel.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ProgressNotificationSchema, TaskStatusNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/stdio.js'],
    env: { ...process.env },
});

const client = new Client(
    { name: 'task-probe', version: '0.0.1' },
    { capabilities: { tasks: { list: {}, cancel: {}, requests: {} } } },
);
await client.connect(transport);

const out = (label, obj) => {
    console.log(`\n=== ${label} ===`);
    if (obj === undefined) return;
    console.log(typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
};

// Capture progress notifications
const progressEvents = [];
client.setNotificationHandler(
    ProgressNotificationSchema,
    async (n) => { progressEvents.push({ at: Date.now(), ...n.params }); },
);
const taskStatusEvents = [];
client.setNotificationHandler(
    TaskStatusNotificationSchema,
    async (n) => { taskStatusEvents.push({ at: Date.now(), ...n.params }); },
);

// ---- 1. Server capabilities — does it declare tasks support? ----
const caps = client.getServerCapabilities();
out('serverCapabilities', caps);
const tools = await client.listTools();
out('tools (filter: taskSupport)', tools.tools
    .filter(t => t.execution?.taskSupport)
    .map(t => ({ name: t.name, taskSupport: t.execution.taskSupport })));

// ---- 2. Task-mode call-actor (rag-web-browser, fast, completes within ttl) ----
const t0 = Date.now();
const stream1 = client.experimental.tasks.callToolStream({
    name: 'call-actor',
    arguments: {
        actor: 'apify/rag-web-browser',
        input: { query: 'mcp tasks 2025-11-25', maxResults: 1 },
    },
    _meta: { progressToken: 'probe-task-1' },
}, undefined, { task: { ttl: 120000 } });

let taskId1 = null;
for await (const msg of stream1) {
    if (msg.type === 'taskCreated') {
        taskId1 = msg.task.taskId;
        out(`[+${Date.now() - t0}ms] taskCreated`, msg.task);
    } else if (msg.type === 'taskStatus') {
        out(`[+${Date.now() - t0}ms] taskStatus`, msg.task);
    } else if (msg.type === 'result') {
        out(`[+${Date.now() - t0}ms] result.structuredContent (truncated)`, {
            ...msg.result.structuredContent,
            items: msg.result.structuredContent?.items
                ? `<${msg.result.structuredContent.items.length} items, omitted>`
                : undefined,
        });
        if (msg.result._meta) out('result._meta', msg.result._meta);
    } else if (msg.type === 'error') {
        out(`[+${Date.now() - t0}ms] error`, msg.error);
    }
}
out(`progressEvents count`, progressEvents.length);
if (progressEvents.length > 0) out('first 3 progress events', progressEvents.slice(0, 3));
out('taskStatusEvents count', taskStatusEvents.length);

// ---- 3. Task-mode call-actor + cancel mid-flight ----
progressEvents.length = 0;
taskStatusEvents.length = 0;
const t1 = Date.now();
const stream2 = client.experimental.tasks.callToolStream({
    name: 'call-actor',
    arguments: {
        actor: 'apify/rag-web-browser',
        input: { query: 'cancel me please', maxResults: 5 },  // bigger so we can cancel
    },
    _meta: { progressToken: 'probe-task-2' },
}, undefined, { task: { ttl: 120000 } });

let taskId2 = null;
let cancelTimer = null;
let cancelResult = null;
const events2 = [];
try {
    for await (const msg of stream2) {
        events2.push({ at: Date.now() - t1, type: msg.type, taskId: msg.task?.taskId, status: msg.task?.status });
        if (msg.type === 'taskCreated') {
            taskId2 = msg.task.taskId;
            // Schedule cancel 5s later
            cancelTimer = setTimeout(async () => {
                try {
                    cancelResult = await client.experimental.tasks.cancelTask(taskId2);
                    console.log(`\n[+${Date.now() - t1}ms] cancelTask returned:`, JSON.stringify(cancelResult, null, 2));
                } catch (e) {
                    console.log(`\n[+${Date.now() - t1}ms] cancelTask error:`, e.message);
                }
            }, 5000);
        }
    }
} catch (e) {
    out(`stream2 threw at +${Date.now() - t1}ms`, e.message);
} finally {
    if (cancelTimer) clearTimeout(cancelTimer);
}
out('events2 (timeline)', events2);

// ---- 4. Wait, then check task state via tasks/get and tasks/list ----
await new Promise(r => setTimeout(r, 1500));
if (taskId2) {
    try {
        const t = await client.experimental.tasks.getTask(taskId2);
        out(`tasks/get(${taskId2.slice(0, 8)}…)`, t);
    } catch (e) { out('tasks/get error', e.message); }
}
try {
    const list = await client.experimental.tasks.listTasks();
    out('tasks/list (count)', list.tasks?.length ?? 0);
    if (list.tasks?.length) out('tasks/list[0]', list.tasks[0]);
} catch (e) { out('tasks/list error', e.message); }

// ---- 5. Slow actor + abort-actor-run mid-flight (non-task path) ----
const t2 = Date.now();
const slowStart = await client.callTool({
    name: 'call-actor',
    arguments: {
        actor: 'apify/rag-web-browser',
        input: { query: 'long crawl test', maxResults: 5 },
        async: true,
    },
});
const slowRunId = slowStart.structuredContent?.runId;
out(`call-actor async @+${Date.now() - t2}ms`, slowStart.structuredContent);

await new Promise(r => setTimeout(r, 3000));
const runMid = await client.callTool({ name: 'get-actor-run', arguments: { runId: slowRunId } });
out(`get-actor-run mid (3s)`, runMid.structuredContent);

const aborted = await client.callTool({ name: 'abort-actor-run', arguments: { runId: slowRunId } });
out('abort-actor-run', aborted.structuredContent);

await new Promise(r => setTimeout(r, 2000));
const runAfter = await client.callTool({ name: 'get-actor-run', arguments: { runId: slowRunId } });
out('get-actor-run after abort', runAfter.structuredContent);

await client.close();
process.exit(0);
