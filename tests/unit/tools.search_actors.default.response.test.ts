import { beforeEach, describe, expect, it, vi } from 'vitest';

import { APIFY_STORE_URL, HelperTools } from '../../src/const.js';
import { defaultSearchActors } from '../../src/tools/default/search_actors.js';
import type { HelperTool } from '../../src/types.js';
import { formatActorToStructuredCard } from '../../src/utils/actor_card.js';
import { searchAgentSafeActors } from '../../src/utils/actor_search.js';
import { CONSOLE_CHAT_CLIENT_NAME } from '../../src/utils/console_link.js';
import { getUserInfoCached } from '../../src/utils/userid_cache.js';
import { MOCK_STORE_ACTOR, SEARCH_KEYWORDS, stubInternalToolArgs } from './tools.search_actors.fixtures.js';

/**
 * Default server mode: search-actors returns markdown + structured cards for the LLM only
 * (no widgetActors, no tool _meta).
 */
vi.mock('../../src/utils/actor_search.js', () => ({
    searchAgentSafeActors: vi.fn(),
}));

vi.mock('../../src/utils/userid_cache.js', () => ({
    getUserInfoCached: vi.fn(),
}));

describe('search-actors without widget (defaultSearchActors)', () => {
    beforeEach(() => {
        vi.mocked(searchAgentSafeActors).mockReset();
        vi.mocked(getUserInfoCached).mockReset();
        vi.mocked(getUserInfoCached).mockResolvedValue({ userId: null, userPlanTier: 'FREE', isOrganization: false });
    });

    it('returns structured actors and markdown text; no widget payload', async () => {
        vi.mocked(searchAgentSafeActors).mockResolvedValue([MOCK_STORE_ACTOR]);

        const result = await (defaultSearchActors as HelperTool).call(
            stubInternalToolArgs({
                keywords: SEARCH_KEYWORDS,
                limit: 5,
                offset: 0,
            }),
        );

        const { structuredContent, content } = result as {
            structuredContent: {
                actors: ReturnType<typeof formatActorToStructuredCard>[];
                query: string;
                count: number;
                instructions?: string;
                widgetActors?: unknown;
            };
            content: { type: string; text: string }[];
            _meta?: unknown;
        };

        expect(structuredContent.widgetActors).toBeUndefined();
        expect(structuredContent.query).toBe(SEARCH_KEYWORDS);
        expect(structuredContent.count).toBe(1);
        expect(structuredContent.actors).toHaveLength(1);
        expect(structuredContent.actors[0]).toStrictEqual(formatActorToStructuredCard(MOCK_STORE_ACTOR));
        expect(structuredContent.instructions).toContain(HelperTools.ACTOR_GET_DETAILS);

        expect(content).toHaveLength(1);
        expect((result as { _meta?: unknown })._meta).toBeUndefined();

        const { text } = content[0];
        expect(text).toContain('# Search results:');
        expect(text).toContain(SEARCH_KEYWORDS);
        expect(text).toContain('Number of Actors found:** 1');
        expect(text).toContain('# Actors:');
        expect(text).toContain(HelperTools.ACTOR_GET_DETAILS);
        expect(text).toContain(`## [${MOCK_STORE_ACTOR.title}](${APIFY_STORE_URL}/apify/web-scraper)`);
        expect(text).toContain('`apify/web-scraper`');
        expect(text).not.toContain('do NOT print or summarize');
    });

    it('returns empty structured content and retry instructions when no actors match', async () => {
        vi.mocked(searchAgentSafeActors).mockResolvedValue([]);

        const result = await (defaultSearchActors as HelperTool).call(
            stubInternalToolArgs({
                keywords: SEARCH_KEYWORDS,
                limit: 5,
                offset: 0,
            }),
        );

        const { structuredContent, content } = result as {
            structuredContent: {
                actors: unknown[];
                query: string;
                count: number;
                instructions: string;
                widgetActors?: unknown;
            };
            content: { type: string; text: string }[];
        };

        expect(structuredContent.widgetActors).toBeUndefined();
        expect(structuredContent.actors).toEqual([]);
        expect(structuredContent.count).toBe(0);
        expect(structuredContent.query).toBe(SEARCH_KEYWORDS);
        expect(structuredContent.instructions).toContain('broader, more generic keywords');

        expect(content).toHaveLength(1);
        expect(content[0].text).toContain('No Actors were found');
        expect(content[0].text).toContain(SEARCH_KEYWORDS);
    });

    describe('Console AI chat sessions (personalized Console links)', () => {
        const callWithClient = async (clientName?: string) => {
            vi.mocked(searchAgentSafeActors).mockResolvedValue([MOCK_STORE_ACTOR]);
            const base = stubInternalToolArgs({ keywords: SEARCH_KEYWORDS, limit: 5, offset: 0 });
            const result = await (defaultSearchActors as HelperTool).call({
                ...base,
                apifyMcpServer: {
                    ...base.apifyMcpServer,
                    options: {
                        ...base.apifyMcpServer.options,
                        initializeRequestData: clientName
                            ? { params: { clientInfo: { name: clientName, version: '0.0.1' } } }
                            : undefined,
                    },
                } as typeof base.apifyMcpServer,
            });
            return result as {
                structuredContent: { actors: { url: string }[] };
                content: { type: string; text: string }[];
            };
        };

        it('mints personal Console links for a Console chat session', async () => {
            vi.mocked(getUserInfoCached).mockResolvedValue({
                userId: 'USER_ID',
                userPlanTier: 'FREE',
                isOrganization: false,
            });

            const { structuredContent, content } = await callWithClient(CONSOLE_CHAT_CLIENT_NAME);
            const consoleUrl = `https://console.apify.com/actors/${MOCK_STORE_ACTOR.id}`;

            expect(structuredContent.actors[0].url).toBe(consoleUrl);
            expect(content[0].text).toContain(`## [${MOCK_STORE_ACTOR.title}](${consoleUrl})`);
            expect(content[0].text).not.toContain(`${APIFY_STORE_URL}/apify/web-scraper`);
        });

        it('mints org-prefixed Console links for an org-scoped Console chat session', async () => {
            vi.mocked(getUserInfoCached).mockResolvedValue({
                userId: 'ORG_ID',
                userPlanTier: 'FREE',
                isOrganization: true,
            });

            const { structuredContent, content } = await callWithClient(CONSOLE_CHAT_CLIENT_NAME);
            const consoleUrl = `https://console.apify.com/organization/ORG_ID/actors/${MOCK_STORE_ACTOR.id}`;

            expect(structuredContent.actors[0].url).toBe(consoleUrl);
            expect(content[0].text).toContain(`## [${MOCK_STORE_ACTOR.title}](${consoleUrl})`);
        });

        it('keeps public website links for other MCP clients', async () => {
            vi.mocked(getUserInfoCached).mockResolvedValue({
                userId: 'USER_ID',
                userPlanTier: 'FREE',
                isOrganization: false,
            });

            for (const clientName of ['claude-ai', undefined]) {
                const { structuredContent, content } = await callWithClient(clientName);

                expect(structuredContent.actors[0].url).toBe(`${APIFY_STORE_URL}/apify/web-scraper`);
                expect(content[0].text).toContain(`${APIFY_STORE_URL}/apify/web-scraper`);
                expect(content[0].text).not.toContain('console.apify.com');
            }
        });
    });
});
