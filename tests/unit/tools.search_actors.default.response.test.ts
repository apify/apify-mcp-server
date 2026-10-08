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
import { VERBATIM_LINKS_NUDGE } from '../../src/utils/console_link.js';
import { getUserInfoCached } from '../../src/utils/userid_cache.js';
import { mockApifyClient, mockUserInfo, only, stubToolCallContext } from './helpers/tool_context.js';
import { MOCK_STORE_ACTOR, SEARCH_KEYWORDS } from './tools.search_actors.fixtures.js';

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

const DETAILS_HINT = `If you need more detailed information about any of these Actors, including their input
schemas and usage instructions, use the ${HELPER_TOOLS.ACTOR_GET_DETAILS} tool with the
specific Actor name.`;
const CALLABILITY_CAVEAT = `This session can run only Actors already exposed as dedicated tools. Other Actors found
here are informational and cannot be run in this configuration. To use another Actor, open
its Apify page or configure it separately.`;

describe('search-actors without widget (searchActors)', () => {
    beforeEach(() => {
        vi.mocked(searchAgentSafeActors).mockReset();
        vi.mocked(getUserInfoCached).mockReset();
        vi.mocked(getUserInfoCached).mockResolvedValue(mockUserInfo({ userId: null }));
    });

    it('returns structured actors and markdown text; no widget payload', async () => {
        vi.mocked(searchAgentSafeActors).mockResolvedValue([MOCK_STORE_ACTOR]);

        const result = await (searchActors as HelperTool).call(
            stubToolCallContext({ keywords: SEARCH_KEYWORDS, limit: 5, offset: 0 }, mockApifyClient(), {
                loadedToolNames: [HELPER_TOOLS.ACTOR_GET_DETAILS],
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
            stubToolCallContext(
                {
                    keywords: SEARCH_KEYWORDS,
                    limit: 5,
                    offset: 0,
                },
                mockApifyClient(),
                { loadedToolNames: [] },
            ),
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

    it('returns empty structured content and keyword guidance when no actors match', async () => {
        vi.mocked(searchAgentSafeActors).mockResolvedValue([]);

        const result = await (searchActors as HelperTool).call(
            stubToolCallContext(
                {
                    keywords: SEARCH_KEYWORDS,
                    limit: 5,
                    offset: 0,
                },
                mockApifyClient(),
                { loadedToolNames: [] },
            ),
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
        // Line wraps are not pinned, so compare with whitespace collapsed.
        expect(structuredContent.instructions.replace(/\s+/g, ' ')).toBe(
            `No Actors were found for the search query "${SEARCH_KEYWORDS}". Broad, generic keywords usually return better matches - for example, just the platform name ("TikTok" instead of "TikTok posts").`,
        );

        expect(content).toHaveLength(1);
        expect(content[0].text).toContain('No Actors were found');
        expect(content[0].text).toContain(SEARCH_KEYWORDS);
        expect(content[0].text).toBe(structuredContent.instructions);
        expect(content[0].text.split('\n')[0]).toBe(`No Actors were found for the search query "${SEARCH_KEYWORDS}".`);
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

    it('searches using the request-scoped apifyClient, not a token-only client', async () => {
        vi.mocked(searchAgentSafeActors).mockResolvedValue([MOCK_STORE_ACTOR]);
        const taggedApifyClient = mockApifyClient({ marker: 'tagged-client' });

        await (searchActors as HelperTool).call(
            stubToolCallContext({ keywords: SEARCH_KEYWORDS, limit: 5, offset: 0 }, taggedApifyClient, {
                loadedToolNames: [],
            }),
        );

        expect(searchAgentSafeActors).toHaveBeenCalledWith(expect.objectContaining({ apifyClient: taggedApifyClient }));
    });

    // Org-prefixed and non-Console variants are covered by console_link.test.ts and
    // the get-actor-run response tests.
    it('mints Console links for a Console UI token', async () => {
        vi.mocked(getUserInfoCached).mockResolvedValue(mockUserInfo());
        vi.mocked(searchAgentSafeActors).mockResolvedValue([MOCK_STORE_ACTOR]);

        const result = await (searchActors as HelperTool).call({
            ...stubToolCallContext({ keywords: SEARCH_KEYWORDS, limit: 5, offset: 0 }, mockApifyClient(), {
                loadedToolNames: [],
            }),
            apifyToken: 'apify_ui_test',
        });
        const { structuredContent, content } = result as {
            structuredContent: { actors: { url: string }[]; instructions?: string };
            content: { type: string; text: string }[];
        };
        const consoleUrl = `https://console.apify.com/actors/${MOCK_STORE_ACTOR.id}`;

        expect(structuredContent.actors[0].url).toBe(consoleUrl);
        expect(content[0].text).toContain(`## [${MOCK_STORE_ACTOR.title}](${consoleUrl})`);
        expect(content[0].text).not.toContain(`${APIFY_STORE_URL}/apify/web-scraper`);
        expect(structuredContent.instructions?.split('\n')[0]).toBe(VERBATIM_LINKS_NUDGE);
    });

    it('places the verbatim-links nudge on its own line between the details hint and the caveat for a Console UI token', async () => {
        vi.mocked(getUserInfoCached).mockResolvedValue(mockUserInfo());
        vi.mocked(searchAgentSafeActors).mockResolvedValue([MOCK_STORE_ACTOR]);

        const result = await (searchActors as HelperTool).call({
            ...stubToolCallContext({ keywords: SEARCH_KEYWORDS, limit: 5, offset: 0 }, mockApifyClient(), {
                loadedToolNames: [HELPER_TOOLS.STORE_SEARCH, HELPER_TOOLS.ACTOR_GET_DETAILS],
            }),
            apifyToken: 'apify_ui_test',
        });
        const { structuredContent, content } = result as {
            structuredContent: { instructions?: string };
            content: { type: string; text: string }[];
        };

        expect(structuredContent.instructions).toBe(`${DETAILS_HINT}\n${VERBATIM_LINKS_NUDGE}\n${CALLABILITY_CAVEAT}`);
        expect(content[0].text.endsWith(`\n\n${structuredContent.instructions}`)).toBe(true);
        expect(content[0].text.split(VERBATIM_LINKS_NUDGE)).toHaveLength(2);
    });

    // The footer is result text, which `tools.mode_contract.test.ts` cannot see — it renders
    // descriptions only. A `?tools=search-actors` session is served no fetch-actor-details.
    it('names no follow-up tool in the footer when the session was not served one', async () => {
        vi.mocked(searchAgentSafeActors).mockResolvedValue([MOCK_STORE_ACTOR]);

        const result = await (searchActors as HelperTool).call(
            stubToolCallContext({ keywords: SEARCH_KEYWORDS, limit: 5, offset: 0 }, mockApifyClient(), {
                loadedToolNames: [],
            }),
        );
        const { structuredContent, content } = result as {
            structuredContent: { instructions?: string };
            content: { type: string; text: string }[];
        };

        expect(structuredContent.instructions).not.toContain(HELPER_TOOLS.ACTOR_GET_DETAILS);
        expect(content[0].text).not.toContain(HELPER_TOOLS.ACTOR_GET_DETAILS);
    });

    // Claude-connector session shape: fetch-actor-details served, call-actor absent.
    it('builds the footer from the details hint and the not-runnable caveat only when call-actor is absent', async () => {
        vi.mocked(searchAgentSafeActors).mockResolvedValue([MOCK_STORE_ACTOR]);

        const result = await (searchActors as HelperTool).call(
            stubToolCallContext({ keywords: SEARCH_KEYWORDS, limit: 5, offset: 0 }, mockApifyClient(), {
                loadedToolNames: [HELPER_TOOLS.STORE_SEARCH, HELPER_TOOLS.ACTOR_GET_DETAILS],
            }),
        );
        const { structuredContent, content } = result as {
            structuredContent: { instructions?: string };
            content: { type: string; text: string }[];
        };

        expect(structuredContent.instructions).toBe(`${DETAILS_HINT}\n${CALLABILITY_CAVEAT}`);
        expect(content[0].text.endsWith(`\n\n${structuredContent.instructions}`)).toBe(true);
        expect(content[0].text).not.toMatch(/second search|MUST|broader/);
    });

    it('adds no second-search instruction to the footer when fetch-actor-details and call-actor are loaded', async () => {
        vi.mocked(searchAgentSafeActors).mockResolvedValue([MOCK_STORE_ACTOR]);

        const result = await (searchActors as HelperTool).call(
            stubToolCallContext({ keywords: SEARCH_KEYWORDS, limit: 5, offset: 0 }, mockApifyClient(), {
                loadedToolNames: [HELPER_TOOLS.ACTOR_GET_DETAILS, HELPER_TOOLS.ACTOR_CALL],
            }),
        );
        const { structuredContent, content } = result as {
            structuredContent: { instructions?: string };
            content: { type: string; text: string }[];
        };

        expect(structuredContent.instructions).toBe(DETAILS_HINT);
        expect(content[0].text).not.toMatch(/second search|MUST/);
    });

    // `?tools=search-actors,call-actor` with an API token: no details hint, no caveat, no nudge.
    it('omits instructions and ends the text at the last card when no footer part applies', async () => {
        vi.mocked(searchAgentSafeActors).mockResolvedValue([MOCK_STORE_ACTOR]);

        const result = await (searchActors as HelperTool).call(
            stubToolCallContext({ keywords: SEARCH_KEYWORDS, limit: 5, offset: 0 }, mockApifyClient(), {
                loadedToolNames: [HELPER_TOOLS.STORE_SEARCH, HELPER_TOOLS.ACTOR_CALL],
            }),
        );
        const { structuredContent, content } = result as {
            structuredContent: Record<string, unknown>;
            content: { type: string; text: string }[];
        };
        const cardText = formatActorToActorCard(MOCK_STORE_ACTOR, {
            ...DEFAULT_CARD_OPTIONS,
            userTier: 'FREE',
            simplifyPricingForUserTier: true,
        });

        expect('instructions' in structuredContent).toBe(false);
        expect(Object.keys(structuredContent).sort()).toEqual(['actors', 'count', 'query', 'userTier']);
        expect(content[0].text).toBe(
            `# Search results:\n- **Search query:** ${SEARCH_KEYWORDS}\n- **Number of Actors found:** 1\n\n# Actors:\n\n${cardText}`,
        );
        expect(content[0].text).toBe(content[0].text.trimEnd());
    });

    it('adds the not-runnable caveat to text and structured content when call-actor is absent', async () => {
        vi.mocked(searchAgentSafeActors).mockResolvedValue([MOCK_STORE_ACTOR]);

        const result = await (searchActors as HelperTool).call(
            stubToolCallContext({ keywords: SEARCH_KEYWORDS, limit: 5, offset: 0 }, mockApifyClient(), {
                loadedToolNames: [],
            }),
        );
        const { structuredContent, content } = result as {
            structuredContent: { instructions?: string };
            content: { type: string; text: string }[];
        };

        expect(structuredContent.instructions).toContain('cannot be run in this configuration');
        expect(content[0].text).toContain('cannot be run in this configuration');
    });

    it('omits the not-runnable caveat when call-actor is loaded', async () => {
        vi.mocked(searchAgentSafeActors).mockResolvedValue([MOCK_STORE_ACTOR]);

        const result = await (searchActors as HelperTool).call(
            stubToolCallContext({ keywords: SEARCH_KEYWORDS, limit: 5, offset: 0 }, mockApifyClient(), {
                loadedToolNames: [HELPER_TOOLS.ACTOR_CALL],
            }),
        );
        const { structuredContent, content } = result as {
            structuredContent: { instructions?: string };
            content: { type: string; text: string }[];
        };

        // No footer part applies in this session, so `instructions` is left out.
        expect(structuredContent.instructions).toBeUndefined();
        expect(content[0].text).not.toContain('cannot be run in this configuration');
    });

    it('omits the not-runnable caveat when call-actor is absent but every result is already loaded', async () => {
        vi.mocked(searchAgentSafeActors).mockResolvedValue([MOCK_STORE_ACTOR]);

        const result = await (searchActors as HelperTool).call(
            stubToolCallContext({ keywords: SEARCH_KEYWORDS, limit: 5, offset: 0 }, mockApifyClient(), {
                loadedToolNames: [],
                loadedActorIds: [MOCK_STORE_ACTOR.id],
            }),
        );
        const { structuredContent, content } = result as {
            structuredContent: { instructions?: string };
            content: { type: string; text: string }[];
        };

        // No footer part applies in this session, so `instructions` is left out.
        expect(structuredContent.instructions).toBeUndefined();
        expect(content[0].text).not.toContain('cannot be run in this configuration');
    });

    it('adds the not-runnable caveat for mixed results when call-actor is absent and only one result is loaded', async () => {
        const otherActor = { ...MOCK_STORE_ACTOR, id: 'actor-id-2' };
        vi.mocked(searchAgentSafeActors).mockResolvedValue([MOCK_STORE_ACTOR, otherActor]);

        const result = await (searchActors as HelperTool).call(
            stubToolCallContext({ keywords: SEARCH_KEYWORDS, limit: 5, offset: 0 }, mockApifyClient(), {
                loadedToolNames: [],
                loadedActorIds: [MOCK_STORE_ACTOR.id],
            }),
        );
        const { structuredContent, content } = result as {
            structuredContent: { instructions?: string };
            content: { type: string; text: string }[];
        };

        expect(structuredContent.instructions).toContain('cannot be run in this configuration');
        expect(content[0].text).toContain('cannot be run in this configuration');
    });

    it('keeps the broad-keywords tip in the description without a second-search mandate', () => {
        const tool = searchActors as HelperTool;

        // ALL_TOOLS_PRESENT render and the `?tools=search-actors` render.
        for (const description of [tool.description, tool.buildDescription?.(only(HELPER_TOOLS.STORE_SEARCH))]) {
            expect(description).toContain(
                '- Prefer broad, generic keywords - use just the platform name (e.g. "Instagram" instead of "Instagram scraper").',
            );
            expect(description).not.toMatch(/MUST always do|two searches|second search/);
        }
    });
});
