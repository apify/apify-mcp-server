import { describe, expect, it, vi } from 'vitest';

import { prepareToolCallContext } from '../../src/payments/helpers.js';
import { callActor } from '../../src/tools/actors/call_actor.js';
import { callActorMcpTool } from '../../src/tools/actors/call_actor_mcp_tool.js';
import { ALL_WIDGET_TOOLS, toolCategories, UNCATEGORIZED_TOOLS } from '../../src/tools/registry.js';
import { createSchedule } from '../../src/tools/schedules/create_schedule.js';
import { updateSchedule } from '../../src/tools/schedules/update_schedule.js';
import { createActorTask } from '../../src/tools/tasks/create_actor_task.js';
import { updateActorTask } from '../../src/tools/tasks/update_actor_task.js';
import { callActorWidget } from '../../src/tools/widgets/call_actor_widget.js';
import type { ActorMcpTool, ActorTool, ToolEntry } from '../../src/types.js';
import { TOOL_TYPE } from '../../src/types.js';

const SECRET = 'synthetic-secret-4f2a';

function prepareLoggedArgs(tool: ToolEntry, args: Record<string, unknown>) {
    return prepareToolCallContext({ provider: undefined, tool, args, apifyToken: 'test-token' });
}

function makeActorTool(): ActorTool {
    return {
        type: TOOL_TYPE.ACTOR,
        name: 'apify--website-content-crawler',
        description: 'Crawl a website',
        actorId: 'aYG0l9s7dbB7j3gbS',
        actorFullName: 'apify/website-content-crawler',
        inputSchema: { type: 'object', properties: { startUrls: { type: 'array' } } },
        ajvValidate: vi.fn(() => true) as never,
    };
}

function makeActorMcpTool(): ActorMcpTool {
    return {
        type: TOOL_TYPE.ACTOR_MCP,
        name: 'apify--actors-mcp-server--search',
        description: 'Search',
        originToolName: 'search',
        actorId: 'abc123',
        actorFullName: 'apify/actors-mcp-server',
        serverUrl: 'https://actors-mcp-server.apify.actor/mcp',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        ajvValidate: vi.fn(() => true) as never,
    };
}

describe('Actor input stays out of the logged arguments', () => {
    it.each<[string, ToolEntry, Record<string, unknown>, Record<string, unknown>]>([
        [
            'call-actor',
            callActor,
            {
                actor: 'apify/website-content-crawler',
                input: { startUrls: [{ url: 'https://apify.com' }], password: SECRET },
                waitSecs: 10,
                callOptions: { memory: 1024, build: 'latest', undeclared: SECRET },
                undeclared: SECRET,
            },
            {
                actor: 'apify/website-content-crawler',
                input: { startUrls: '[REDACTED]', password: '[REDACTED]' },
                waitSecs: 10,
                callOptions: { memory: 1024, build: 'latest' },
            },
        ],
        [
            'call-actor-widget',
            callActorWidget,
            {
                actor: 'apify/website-content-crawler',
                input: { password: SECRET },
                waitSecs: 10,
                callOptions: { timeout: 60 },
            },
            {
                actor: 'apify/website-content-crawler',
                input: { password: '[REDACTED]' },
                callOptions: { timeout: 60 },
            },
        ],
        [
            'create-actor-task',
            createActorTask,
            {
                actorId: 'apify/website-content-crawler',
                name: 'daily-crawl',
                title: 'Daily crawl',
                input: { cookie: SECRET },
                timeoutSecs: 60,
                undeclared: SECRET,
            },
            {
                actorId: 'apify/website-content-crawler',
                name: 'daily-crawl',
                title: 'Daily crawl',
                input: { cookie: '[REDACTED]' },
                timeoutSecs: 60,
            },
        ],
        [
            'update-actor-task',
            updateActorTask,
            { taskId: 'daily-crawl', input: { cookie: SECRET }, memoryMbytes: 2048, undeclared: SECRET },
            { taskId: 'daily-crawl', input: { cookie: '[REDACTED]' }, memoryMbytes: 2048 },
        ],
        [
            'create-schedule',
            createSchedule,
            {
                name: 'nightly',
                cronExpression: '0 3 * * *',
                isEnabled: true,
                actions: [
                    { actorId: 'apify/website-content-crawler', input: { apiKey: SECRET }, undeclared: SECRET },
                    { taskId: 'daily-crawl' },
                ],
                undeclared: SECRET,
            },
            {
                name: 'nightly',
                cronExpression: '0 3 * * *',
                isEnabled: true,
                actions: [
                    { actorId: 'apify/website-content-crawler', input: { apiKey: '[REDACTED]' } },
                    { taskId: 'daily-crawl' },
                ],
            },
        ],
        [
            'update-schedule',
            updateSchedule,
            { scheduleId: 'nightly', actions: [{ taskId: 'daily-crawl', input: { apiKey: SECRET } }] },
            { scheduleId: 'nightly', actions: [{ taskId: 'daily-crawl', input: { apiKey: '[REDACTED]' } }] },
        ],
        [
            'call-actor-mcp-tool',
            callActorMcpTool,
            { actor: 'apify/actors-mcp-server', tool: 'search', arguments: { apiKey: SECRET }, undeclared: SECRET },
            { actor: 'apify/actors-mcp-server', tool: 'search', arguments: { apiKey: '[REDACTED]' } },
        ],
        [
            'a direct Actor tool',
            makeActorTool(),
            { startUrls: [{ url: 'https://apify.com' }], password: SECRET },
            { startUrls: '[REDACTED]', password: '[REDACTED]' },
        ],
        [
            'a proxied Actor MCP tool',
            makeActorMcpTool(),
            { query: 'apify', apiKey: SECRET },
            { query: '[REDACTED]', apiKey: '[REDACTED]' },
        ],
    ])('%s logs the control arguments and only the key names of the input', (_, tool, args, expected) => {
        const argsBefore = structuredClone(args);

        const { toolArgsRedacted, toolArgsWithoutPayment } = prepareLoggedArgs(tool, args);

        expect(toolArgsRedacted).toStrictEqual(expected);
        expect(toolArgsWithoutPayment).toStrictEqual(argsBefore);
        expect(args).toStrictEqual(argsBefore);
    });

    it.each<[string, ToolEntry, Record<string, unknown>]>([
        ['input that is a string', callActor, { actor: 'apify/website-content-crawler', input: SECRET }],
        ['input that is a list', createActorTask, { actorId: 'apify/website-content-crawler', input: [SECRET] }],
        ['callOptions that are not an object', callActor, { actor: 'a', input: {}, callOptions: [SECRET] }],
        ['actions that are not a list', createSchedule, { name: 'nightly', actions: SECRET }],
        ['actions that are not objects', updateSchedule, { scheduleId: 'nightly', actions: [SECRET, null] }],
    ])('accepts %s without logging its value', (_, tool, args) => {
        expect(JSON.stringify(prepareLoggedArgs(tool, args).toolArgsRedacted)).not.toContain(SECRET);
    });

    it('every registered tool that takes Actor input redacts its logged arguments', () => {
        const tools = [...Object.values(toolCategories).flat(), ...ALL_WIDGET_TOOLS, ...UNCATEGORIZED_TOOLS];
        const toolsTakingInput = tools.filter((tool) => JSON.stringify(tool.inputSchema).includes('"input":{'));

        expect(toolsTakingInput.length).toBeGreaterThan(0);
        for (const tool of toolsTakingInput) {
            expect({ name: tool.name, hasRedactArgs: 'redactArgs' in tool && !!tool.redactArgs }).toStrictEqual({
                name: tool.name,
                hasRedactArgs: true,
            });
        }
    });
});
