import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { prepareToolCall } from '../../src/mcp/tool_call_engine.js';
import { getNormalActorsAsTools } from '../../src/tools/actors/actor_tools_factory.js';
import { callActor } from '../../src/tools/actors/call_actor.js';
import { fetchActorDetails } from '../../src/tools/actors/fetch_actor_details.js';
import { callActorWidget } from '../../src/tools/widgets/call_actor_widget.js';
import type { ActorDefinitionWithInfo, ActorInfo, HelperTool } from '../../src/types.js';
import { ACTOR_TOOL_MODE } from '../../src/types.js';
import { getActorDefinitionCached, getActorToolResolutionCached } from '../../src/utils/actor.js';
import { mockApifyClient, stubToolCallContext } from './helpers/tool_context.js';

vi.mock('../../src/utils/actor.js', () => ({
    getActorDefinitionCached: vi.fn(),
    getActorToolResolutionCached: vi.fn(),
}));

const ACTOR_FULL_NAME = 'apify/website-content-crawler';
const actorInfo: ActorInfo = {
    webServerMcpPath: null,
    actor: {
        id: 'wcc-id',
        username: 'apify',
        name: 'website-content-crawler',
        actorPermissionLevel: 'LIMITED_PERMISSIONS',
    } as ActorInfo['actor'],
    definition: {
        id: 'wcc-id',
        actorFullName: ACTOR_FULL_NAME,
        buildTag: 'latest',
        readme: '',
        description: 'Crawler',
        defaultRunOptions: { memoryMbytes: 1024, timeoutSecs: 300, build: 'latest' },
        input: {
            type: 'object',
            required: ['url'],
            properties: {
                url: { type: 'string', title: 'URL', description: 'URL' },
                respectRobotsTxtFile: { type: 'boolean', title: 'Robots', description: 'Robots', default: false },
                pageFunction: { type: 'string', title: 'Code', description: 'Code', editor: 'hidden', default: '' },
                initialCookies: {
                    type: 'array',
                    title: 'Cookies',
                    description: 'Cookies',
                    editor: 'json',
                    isSecret: true,
                },
            },
        },
    },
};

Object.assign(actorInfo.definition.input!, { additionalProperties: false });

beforeEach(() => {
    vi.mocked(getActorDefinitionCached).mockResolvedValue({
        definition: actorInfo.definition,
        info: actorInfo.actor,
    } as ActorDefinitionWithInfo);
    vi.mocked(getActorToolResolutionCached).mockResolvedValue({
        toolMode: ACTOR_TOOL_MODE.RUN,
        actorFullName: ACTOR_FULL_NAME,
    });
});

describe.each([
    ['call-actor', callActor, { waitSecs: 0 }],
    ['call-actor-widget', callActorWidget, {}],
])('%s original Actor contract', (_name, tool, options) => {
    it.each([ACTOR_FULL_NAME, 'wcc-id'])('keeps original inputs and omitted defaults for %s', async (actor) => {
        // Constructing a direct tool first must not contaminate cached definitions or generic validation.
        await getNormalActorsAsTools([actorInfo]);
        const start = vi.fn().mockResolvedValue({
            id: 'run-id',
            actId: 'wcc-id',
            status: 'RUNNING',
            startedAt: new Date(),
            defaultDatasetId: 'dataset-id',
            defaultKeyValueStoreId: 'store-id',
        });
        const input = { url: 'https://example.com', pageFunction: 'async () => {}', initialCookies: [] };
        const result = await (tool as HelperTool).call(
            stubToolCallContext({ actor, input, ...options }, mockApifyClient({ actor: () => ({ start }) })),
        );
        expect(result.isError).not.toBe(true);
        expect(start.mock.calls[0]?.[0]).toEqual(input);
        expect(start.mock.calls[0]?.[0]).not.toHaveProperty('respectRobotsTxtFile');
        expect(start.mock.calls[0]?.[0]).toHaveProperty('pageFunction');
        expect(start.mock.calls[0]?.[0]).toHaveProperty('initialCookies');
    });

    it('reports the unrestricted input schema for invalid input', async () => {
        const start = vi.fn();
        const result = await (tool as HelperTool).call(
            stubToolCallContext(
                { actor: ACTOR_FULL_NAME, input: {}, ...options },
                mockApifyClient({ actor: () => ({ start }) }),
            ),
        );
        expect(result.isError).toBe(true);
        expect(start).not.toHaveBeenCalled();
        const text = JSON.stringify(result.content);
        expect(text).toContain('pageFunction');
        expect(text).toContain('initialCookies');
    });
});

it('points restricted direct-tool errors at the tool schema instead of the original Actor schema', async () => {
    const [tool] = await getNormalActorsAsTools([actorInfo]);
    const result = await prepareToolCall({
        tools: new Map([
            [tool.name, tool],
            [HELPER_TOOLS.ACTOR_GET_DETAILS, fetchActorDetails],
        ]),
        apifyToken: 'test-token',
        name: tool.name,
        args: { url: 'https://example.com', initialCookies: [] },
        meta: undefined,
        requestHeaders: undefined,
        isTaskRequest: false,
        mcpSessionId: 'test-session',
        telemetryData: null,
        clientContext: undefined,
    });
    expect('message' in result).toBe(true);
    if (!('message' in result)) throw new Error('Denied input passed validation');
    expect(result.message).toContain('initialCookies');
    expect(result.message).toContain('in tools/list');
    expect(result.message).not.toContain(HELPER_TOOLS.ACTOR_GET_DETAILS);
});
