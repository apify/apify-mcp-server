import { beforeEach, describe, expect, it, vi } from 'vitest';

import { callActor } from '../../src/tools/actors/call_actor.js';
import { callActorWidget } from '../../src/tools/widgets/call_actor_widget.js';
import type { HelperTool, ToolEntry } from '../../src/types.js';
import { ACTOR_TOOL_MODE, TOOL_TYPE } from '../../src/types.js';
import { getActorToolResolutionCached } from '../../src/utils/actor.js';
import { mockApifyClient, stubToolCallContext } from './helpers/tool_context.js';

/** call-actor and call-actor-widget start a website-content-crawler run with the same input as its direct tool (#1574). */
vi.mock('../../src/utils/actor.js', () => ({
    getActorToolResolutionCached: vi.fn(),
}));

vi.mock('../../src/tools/actors/actor_tools_factory.js', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('../../src/tools/actors/actor_tools_factory.js');
    return { ...actual, getActorsAsTools: vi.fn() };
});

const { getActorsAsTools } = await import('../../src/tools/actors/actor_tools_factory.js');

const WEBSITE_CONTENT_CRAWLER = 'apify/website-content-crawler';
const START_URLS = [{ url: 'https://example.com' }];

const MOCK_RUN = {
    id: 'run-1',
    actId: 'actor-id-wcc',
    status: 'RUNNING',
    startedAt: new Date('2026-10-14T10:00:00.000Z'),
    defaultDatasetId: 'dataset-id-1',
    defaultKeyValueStoreId: 'kv-id-1',
};

function mockActorTool(actorFullName: string): ToolEntry {
    return {
        type: TOOL_TYPE.ACTOR,
        name: actorFullName.replace('/', '--'),
        actorId: 'actor-id',
        actorFullName,
        description: actorFullName,
        inputSchema: { type: 'object', properties: {}, additionalProperties: true } as never,
        ajvValidate: (() => true) as never,
    } as unknown as ToolEntry;
}

describe.each([
    ['call-actor', callActor, { waitSecs: 0 }],
    ['call-actor-widget', callActorWidget, {}],
])('%s run input', (_name, tool, extraArgs) => {
    const callWithInput = async (actorFullName: string, input: Record<string, unknown>) => {
        vi.mocked(getActorToolResolutionCached).mockResolvedValue({ toolMode: ACTOR_TOOL_MODE.RUN, actorFullName });
        vi.mocked(getActorsAsTools).mockResolvedValue({ tools: [mockActorTool(actorFullName)], errors: [] });
        const startSpy = vi.fn().mockResolvedValue(MOCK_RUN);
        const client = mockApifyClient({ actor: () => ({ start: startSpy }) });
        await (tool as HelperTool).call(stubToolCallContext({ actor: actorFullName, input, ...extraArgs }, client));
        return startSpy.mock.calls[0]?.[0];
    };

    beforeEach(() => {
        vi.mocked(getActorToolResolutionCached).mockReset();
        vi.mocked(getActorsAsTools).mockReset();
    });

    it.each([
        ['an omitted', true, {}],
        ['an explicit false', false, { respectRobotsTxtFile: false }],
    ])('sends %s website-content-crawler respectRobotsTxtFile as %s', async (_label, expected, field) => {
        expect(await callWithInput(WEBSITE_CONTENT_CRAWLER, { startUrls: START_URLS, ...field })).toEqual({
            startUrls: START_URLS,
            respectRobotsTxtFile: expected,
        });
    });

    it('sends respectRobotsTxtFile as true when website-content-crawler is named by its ID', async () => {
        vi.mocked(getActorToolResolutionCached).mockResolvedValue({
            toolMode: ACTOR_TOOL_MODE.RUN,
            actorFullName: WEBSITE_CONTENT_CRAWLER,
        });
        vi.mocked(getActorsAsTools).mockResolvedValue({ tools: [mockActorTool(WEBSITE_CONTENT_CRAWLER)], errors: [] });
        const startSpy = vi.fn().mockResolvedValue(MOCK_RUN);
        const client = mockApifyClient({ actor: () => ({ start: startSpy }) });

        await (tool as HelperTool).call(
            stubToolCallContext({ actor: 'aYG0l9s7dbB7j3gbS', input: { startUrls: START_URLS }, ...extraArgs }, client),
        );

        expect(startSpy.mock.calls[0]?.[0]).toEqual({ startUrls: START_URLS, respectRobotsTxtFile: true });
    });

    it('leaves the input of other Actors unchanged', async () => {
        expect(await callWithInput('apify/cheerio-scraper', { startUrls: START_URLS })).toEqual({
            startUrls: START_URLS,
        });
    });
});
