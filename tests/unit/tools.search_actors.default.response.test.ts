import { beforeEach, describe, expect, it, vi } from 'vitest';

import { APIFY_STORE_URL, HELPER_TOOLS, MAX_INPUT_FIELDS_IN_ACTOR_CARD } from '../../src/const.js';
import { searchActors } from '../../src/tools/actors/search_actors.js';
import { actorInfoSchema } from '../../src/tools/structured_output_schemas.js';
import type { ActorStoreInputSchema, ActorStoreList, HelperTool } from '../../src/types.js';
import {
    DEFAULT_CARD_OPTIONS,
    formatActorToActorCard,
    formatActorToStructuredCard,
} from '../../src/utils/actor_card.js';
import { searchAgentSafeActors } from '../../src/utils/actor_search.js';
import { getUserInfoCached } from '../../src/utils/userid_cache.js';
import { mockUserInfo } from './helpers/tool_context.js';
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

function buildInputSchema(fieldCount: number): ActorStoreInputSchema {
    const properties: ActorStoreInputSchema['properties'] = {};
    for (let i = 0; i < fieldCount; i++) {
        properties[`field${i}`] = { type: 'string' };
    }

    return {
        type: 'object',
        properties,
        required: Object.keys(properties),
    };
}

describe('search-actors without widget (searchActors)', () => {
    beforeEach(() => {
        vi.mocked(searchAgentSafeActors).mockReset();
        vi.mocked(getUserInfoCached).mockReset();
        vi.mocked(getUserInfoCached).mockResolvedValue(mockUserInfo({ userId: null }));
    });

    it('returns structured actors and markdown text; no widget payload', async () => {
        vi.mocked(searchAgentSafeActors).mockResolvedValue([MOCK_STORE_ACTOR]);

        const result = await (searchActors as HelperTool).call(
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
                userTier?: string;
                instructions?: string;
                widgetActors?: unknown;
            };
            content: { type: string; text: string }[];
            _meta?: unknown;
        };

        expect(structuredContent.widgetActors).toBeUndefined();
        expect(structuredContent.query).toBe(SEARCH_KEYWORDS);
        expect(structuredContent.count).toBe(1);
        expect(structuredContent.userTier).toBe('FREE');
        expect(structuredContent.actors).toHaveLength(1);
        expect(structuredContent.actors[0]).toStrictEqual(
            formatActorToStructuredCard(MOCK_STORE_ACTOR, {
                ...DEFAULT_CARD_OPTIONS,
                userTier: 'FREE',
                simplifyPricingForUserTier: true,
            }),
        );
        expect(structuredContent.instructions).toContain(HELPER_TOOLS.ACTOR_GET_DETAILS);

        expect(content).toHaveLength(1);
        expect((result as { _meta?: unknown })._meta).toBeUndefined();

        const { text } = content[0];
        expect(text).toContain('# Search results:');
        expect(text).toContain(SEARCH_KEYWORDS);
        expect(text).toContain('Number of Actors found:** 1');
        expect(text).toContain('# Actors:');
        expect(text).toContain(HELPER_TOOLS.ACTOR_GET_DETAILS);
        expect(text).toContain(`## [${MOCK_STORE_ACTOR.title}](${APIFY_STORE_URL}/apify/web-scraper)`);
        expect(text).toContain('`apify/web-scraper`');
        expect(text).not.toContain('do NOT print or summarize');
    });

    it('truncates structured inputFields for every Actor and keeps text cards unchanged', async () => {
        const total = MAX_INPUT_FIELDS_IN_ACTOR_CARD + 5;
        const actors = [
            { ...MOCK_STORE_ACTOR, inputSchema: buildInputSchema(total) },
            {
                ...MOCK_STORE_ACTOR,
                id: 'actor-id-2',
                name: 'web-scraper-2',
                title: 'Web Scraper 2',
                inputSchema: buildInputSchema(total),
            },
        ] as ActorStoreList[];
        vi.mocked(searchAgentSafeActors).mockResolvedValue(actors);

        const result = await (searchActors as HelperTool).call(
            stubInternalToolArgs({
                keywords: SEARCH_KEYWORDS,
                limit: 5,
                offset: 0,
            }),
        );

        const { structuredContent, content } = result as {
            structuredContent: {
                actors: ReturnType<typeof formatActorToStructuredCard>[];
            };
            content: { type: string; text: string }[];
        };

        expect(structuredContent.actors).toHaveLength(2);
        for (const actor of structuredContent.actors) {
            expect(Object.keys(actor.inputFields?.properties ?? {})).toHaveLength(MAX_INPUT_FIELDS_IN_ACTOR_CARD);
            expect(actor.inputFields?.properties[`field${MAX_INPUT_FIELDS_IN_ACTOR_CARD}`]).toBeUndefined();
            expect(actor.inputFieldsTruncated).toBe(true);
            expect(actor.inputFieldsTotalCount).toBe(total);
        }

        const expectedActorText = actors
            .map((actor) =>
                formatActorToActorCard(actor, {
                    ...DEFAULT_CARD_OPTIONS,
                    userTier: 'FREE',
                    simplifyPricingForUserTier: true,
                }),
            )
            .join('\n\n');
        expect(content[0].text).toContain(expectedActorText);
    });

    it('returns empty structured content and retry instructions when no actors match', async () => {
        vi.mocked(searchAgentSafeActors).mockResolvedValue([]);

        const result = await (searchActors as HelperTool).call(
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

    it('declares every field the structured card emits (guards schema/runtime drift)', () => {
        // Regression guard for #889: the advertised output schema must declare every field
        // the runtime card actually emits. `pictureUrl` was emitted but undeclared — this
        // asserts no emitted key is missing from `actorInfoSchema`, so the next dropped
        // field fails here instead of silently shipping an inconsistent schema.
        const card = formatActorToStructuredCard(MOCK_STORE_ACTOR, {
            ...DEFAULT_CARD_OPTIONS,
            userTier: 'FREE',
            simplifyPricingForUserTier: true,
        });
        const declared = new Set(Object.keys(actorInfoSchema.properties));
        const undeclared = Object.keys(card).filter((key) => !declared.has(key));
        expect(undeclared).toEqual([]);
    });

    // Org-prefixed and non-Console variants are covered by console_link.test.ts and
    // the get-actor-run response tests.
    it('mints Console links for a Console UI token', async () => {
        vi.mocked(getUserInfoCached).mockResolvedValue(mockUserInfo());
        vi.mocked(searchAgentSafeActors).mockResolvedValue([MOCK_STORE_ACTOR]);

        const result = await (searchActors as HelperTool).call({
            ...stubInternalToolArgs({ keywords: SEARCH_KEYWORDS, limit: 5, offset: 0 }),
            apifyToken: 'apify_ui_test',
        });
        const { structuredContent, content } = result as {
            structuredContent: { actors: { url: string }[] };
            content: { type: string; text: string }[];
        };
        const consoleUrl = `https://console.apify.com/actors/${MOCK_STORE_ACTOR.id}`;

        expect(structuredContent.actors[0].url).toBe(consoleUrl);
        expect(content[0].text).toContain(`## [${MOCK_STORE_ACTOR.title}](${consoleUrl})`);
        expect(content[0].text).not.toContain(`${APIFY_STORE_URL}/apify/web-scraper`);
    });
});
