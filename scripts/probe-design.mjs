#!/usr/bin/env node
// Tiny mcpc-equivalent: spawn dist/stdio.js, list tools, call a few.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/stdio.js'],
    env: { ...process.env },
});

const client = new Client({ name: 'design-probe', version: '0.0.1' }, { capabilities: {} });
await client.connect(transport);

const out = (label, obj) => {
    console.log(`\n=== ${label} ===`);
    console.log(JSON.stringify(obj, null, 2));
};

// 1. List tools — confirm shape
const tools = await client.listTools();
out('tools/list (names + taskSupport)', tools.tools.map(t => ({
    name: t.name,
    taskSupport: t.execution?.taskSupport ?? null,
})));

// 2. fetch-actor-details for a fast actor
const details = await client.callTool({
    name: 'fetch-actor-details',
    arguments: { actor: 'apify/rag-web-browser', output: { inputSchema: true, stats: true } },
});
out('fetch-actor-details(rag-web-browser) — structuredContent', details.structuredContent);

// 3. call-actor synchronous (default) — fast actor, expect terminal in <30s
const t0 = Date.now();
const callRes = await client.callTool({
    name: 'call-actor',
    arguments: {
        actor: 'apify/rag-web-browser',
        input: { query: 'model context protocol', maxResults: 1 },
    },
});
out(`call-actor (sync, default) — ${Date.now() - t0}ms — structuredContent`, callRes.structuredContent);
out('call-actor — content[0]', callRes.content?.[0]);
out('call-actor — _meta', callRes._meta);

// 4. call-actor async
const t1 = Date.now();
const asyncRes = await client.callTool({
    name: 'call-actor',
    arguments: {
        actor: 'apify/rag-web-browser',
        input: { query: 'mcp tasks spec', maxResults: 1 },
        async: true,
    },
});
out(`call-actor (async:true) — ${Date.now() - t1}ms — structuredContent`, asyncRes.structuredContent);
const runId = asyncRes.structuredContent?.runId;

// 5. get-actor-run on the running run
const runRes = await client.callTool({
    name: 'get-actor-run',
    arguments: { runId },
});
out('get-actor-run (mid-flight) — structuredContent', runRes.structuredContent);

// 6. Wait briefly, get-actor-run again
await new Promise(r => setTimeout(r, 8000));
const runRes2 = await client.callTool({
    name: 'get-actor-run',
    arguments: { runId },
});
out('get-actor-run (after 8s) — structuredContent', runRes2.structuredContent);

// 7. get-actor-output if dataset exists
const datasetId = runRes2.structuredContent?.dataset?.datasetId
    ?? callRes.structuredContent?.datasetId;
if (datasetId) {
    const outRes = await client.callTool({
        name: 'get-actor-output',
        arguments: { datasetId, limit: 2 },
    });
    out('get-actor-output(limit:2) — structuredContent', outRes.structuredContent);
}

// 8. get-dataset-items shape
if (datasetId) {
    const dsRes = await client.callTool({
        name: 'get-dataset-items',
        arguments: { datasetId, limit: 2 },
    });
    out('get-dataset-items(limit:2) — structuredContent', dsRes.structuredContent);
}

await client.close();
process.exit(0);
