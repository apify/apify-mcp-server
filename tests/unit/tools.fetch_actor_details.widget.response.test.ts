import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WIDGET_URIS } from '../../src/resources/widgets.js';
import { fetchActorDetailsWidgetTool } from '../../src/tools/apps/fetch_actor_details_widget.js';
import type { HelperTool } from '../../src/types.js';
import type { ActorDetailsResult } from '../../src/utils/actor_details.js';
import { fetchActorDetails } from '../../src/utils/actor_details.js';
import { getUserInfoCached } from '../../src/utils/userid_cache.js';
import { stubInternalToolArgs } from './tools.search_actors.fixtures.js';

/**
 * Apps / UI mode: fetch-actor-details-widget renders an interactive UI element
 * (widget) with `{ actorDetails: { actorInfo, actorCard, readme } }` in
 * structuredContent and carries widget `_meta` on both the tool definition and
 * the response.
 */
vi.mock('../../src/utils/actor_details.js', async () => {
    const actual = await vi.importActual<Record<string, unknown>>(
        '../../src/utils/actor_details.js',
    );
    return {
        ...actual,
        fetchActorDetails: vi.fn(),
    };
});

vi.mock('../../src/utils/userid_cache.js', () => ({
    getUserInfoCached: vi.fn(),
}));

const MOCK_DETAILS = {
    actorInfo: {
        id: 'actor-id-1',
        name: 'web-scraper',
        username: 'apify',
        title: 'Web Scraper',
        description: 'A web scraper for tests.',
        pictureUrl: 'https://example.com/pic.png',
        categories: ['SCRAPING'],
    },
    buildInfo: {},
    actorCard: '# Actor card',
    actorCardStructured: {
        id: 'actor-id-1',
        fullName: 'apify/web-scraper',
        url: 'https://apify.com/apify/web-scraper',
        title: 'Web Scraper',
        description: 'A web scraper for tests.',
        categories: ['SCRAPING'],
        isDeprecated: false,
        developer: { username: 'apify', isOfficialApify: true, url: 'https://apify.com/apify' },
    },
    inputSchema: { type: 'object', properties: {} },
    readme: '# Web Scraper\nDetails.',
    readmeSummary: 'Short summary.',
} as unknown as ActorDetailsResult;

describe('fetch-actor-details-widget response', () => {
    beforeEach(() => {
        vi.mocked(fetchActorDetails).mockReset();
        vi.mocked(getUserInfoCached).mockReset();
        vi.mocked(getUserInfoCached).mockResolvedValue({ userId: null, userPlanTier: 'FREE' });
    });

    it('returns { actorDetails: { actorInfo, actorCard, readme } } as structuredContent plus widget _meta', async () => {
        vi.mocked(fetchActorDetails).mockResolvedValue(MOCK_DETAILS);

        const result = await (fetchActorDetailsWidgetTool as HelperTool).call(
            stubInternalToolArgs({ actor: 'apify/web-scraper' }),
        );

        const { structuredContent, content, _meta } = result as {
            structuredContent: {
                actorDetails?: { actorInfo?: unknown; actorCard?: string; readme?: string };
            } & Record<string, unknown>;
            content: { type: string; text: string }[];
            _meta?: { ui?: { resourceUri?: string; visibility?: readonly string[]; csp?: unknown }; 'openai/widgetDescription'?: string };
        };

        // Widget-only structuredContent — no top-level actorInfo/inputSchema duplication.
        expect(Object.keys(structuredContent)).toEqual(['actorDetails']);
        expect(structuredContent.actorDetails).toBeDefined();
        expect(structuredContent.actorDetails!.actorInfo).toBeDefined();
        expect(typeof structuredContent.actorDetails!.actorCard).toBe('string');
        expect(typeof structuredContent.actorDetails!.readme).toBe('string');
        expect(structuredContent.actorDetails!.readme!.length).toBeGreaterThan(0);

        // Short pointer text only; no full Actor card / input schema dump.
        expect(content).toHaveLength(1);
        expect(content[0].text).toContain('Actor information');
        expect(content[0].text).toContain('An interactive widget has been rendered');

        // Response-level widget _meta.
        expect(_meta?.ui?.resourceUri).toBe(WIDGET_URIS.SEARCH_ACTORS);
        expect(_meta?.ui?.visibility).toEqual(['model', 'app']);
        expect(_meta?.ui?.csp).toBeDefined();
        expect(_meta?.['openai/widgetDescription']).toContain('apify/web-scraper');
    });

    it('carries widget _meta on the tool definition', () => {
        const tool = fetchActorDetailsWidgetTool as HelperTool;
        const meta = tool._meta as { ui?: { resourceUri?: string; visibility?: readonly string[]; csp?: unknown } };
        expect(meta.ui?.resourceUri).toBe(WIDGET_URIS.SEARCH_ACTORS);
        expect(meta.ui?.visibility).toEqual(['model', 'app']);
        expect(meta.ui?.csp).toBeDefined();
    });

    it('declares a strict input schema and strips stray keys like `output` at validation time', () => {
        const tool = fetchActorDetailsWidgetTool as HelperTool;

        // Schema-level: strict shape (no extra properties allowed).
        const schema = tool.inputSchema as { additionalProperties?: boolean; properties?: Record<string, unknown>; required?: string[] };
        expect(schema.additionalProperties).toBe(false);
        expect(Object.keys(schema.properties ?? {})).toEqual(['actor']);
        expect(schema.required).toEqual(['actor']);

        // Runtime: AJV is configured with `removeAdditional: true`, so stray keys are silently
        // stripped from the input object in place — the widget contract can't be overridden.
        const input: Record<string, unknown> = { actor: 'apify/web-scraper', output: { readme: true } };
        const ok = tool.ajvValidate(input);
        expect(ok).toBe(true);
        expect('output' in input).toBe(false);
    });

    it('accepts a valid actor-only input', () => {
        const tool = fetchActorDetailsWidgetTool as HelperTool;
        const ok = tool.ajvValidate({ actor: 'apify/web-scraper' });
        expect(ok).toBe(true);
    });
});
