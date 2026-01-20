import { describe, expect, it, vi } from 'vitest';

import { SKYFIRE_README_CONTENT } from '../../src/const.js';
import { parseInputParamsFromUrl } from '../../src/mcp/utils.js';
import { createResourceService } from '../../src/resources/resource_service.js';
import type { AvailableWidget } from '../../src/resources/widgets.js';
import { WIDGET_REGISTRY, WIDGET_URIS } from '../../src/resources/widgets.js';

vi.mock('node:fs', () => ({
    readFileSync: vi.fn(),
    default: {
        readFileSync: vi.fn(),
    },
}));

describe('parseInputParamsFromUrl', () => {
    it('should parse Actors from URL query params (as tools)', () => {
        const url = 'https://mcp.apify.com?token=123&actors=apify/web-scraper';
        const result = parseInputParamsFromUrl(url);
        expect(result.tools).toEqual(['apify/web-scraper']);
        expect(result.actors).toBeUndefined();
    });

    it('should parse multiple Actors from URL (as tools)', () => {
        const url = 'https://mcp.apify.com?actors=apify/instagram-scraper,lukaskrivka/google-maps';
        const result = parseInputParamsFromUrl(url);
        expect(result.tools).toEqual(['apify/instagram-scraper', 'lukaskrivka/google-maps']);
        expect(result.actors).toBeUndefined();
    });

    it('should handle URL without query params', () => {
        const url = 'https://mcp.apify.com';
        const result = parseInputParamsFromUrl(url);
        expect(result.actors).toBeUndefined();
    });

    it('should parse enableActorAutoLoading flag', () => {
        const url = 'https://mcp.apify.com?enableActorAutoLoading=true';
        const result = parseInputParamsFromUrl(url);
        expect(result.enableAddingActors).toBe(true);
    });

    it('should parse enableAddingActors flag', () => {
        const url = 'https://mcp.apify.com?enableAddingActors=true';
        const result = parseInputParamsFromUrl(url);
        expect(result.enableAddingActors).toBe(true);
    });

    it('should parse enableAddingActors flag', () => {
        const url = 'https://mcp.apify.com?enableAddingActors=false';
        const result = parseInputParamsFromUrl(url);
        expect(result.enableAddingActors).toBe(false);
    });

    it('should handle Actors as string parameter (as tools)', () => {
        const url = 'https://mcp.apify.com?actors=apify/rag-web-browser';
        const result = parseInputParamsFromUrl(url);
        expect(result.tools).toEqual(['apify/rag-web-browser']);
        expect(result.actors).toBeUndefined();
    });
});

describe('MCP resources', () => {
    const buildAvailableWidget = (uri: string, exists: boolean): AvailableWidget => ({
        ...WIDGET_REGISTRY[uri],
        jsPath: `/tmp/${WIDGET_REGISTRY[uri].jsFilename}`,
        exists,
    });

    it('lists the Skyfire readme only when enabled', async () => {
        const skyfireService = createResourceService({
            skyfireMode: true,
            getAvailableWidgets: () => new Map(),
        });
        const defaultService = createResourceService({
            skyfireMode: false,
            getAvailableWidgets: () => new Map(),
        });

        const skyfireResources = await skyfireService.listResources();
        const defaultResources = await defaultService.listResources();

        expect(skyfireResources.resources.some((resource) => resource.uri === 'file://readme.md')).toBe(true);
        expect(defaultResources.resources.some((resource) => resource.uri === 'file://readme.md')).toBe(false);
    });

    it('lists OpenAI widgets only when available', async () => {
        const widgets = new Map<string, AvailableWidget>([
            [WIDGET_URIS.SEARCH_ACTORS, buildAvailableWidget(WIDGET_URIS.SEARCH_ACTORS, true)],
            [WIDGET_URIS.ACTOR_RUN, buildAvailableWidget(WIDGET_URIS.ACTOR_RUN, false)],
        ]);
        const service = createResourceService({
            uiMode: 'openai',
            getAvailableWidgets: () => widgets,
        });

        const { resources } = await service.listResources();

        expect(resources.map((resource) => resource.uri)).toEqual([WIDGET_URIS.SEARCH_ACTORS]);
    });

    it('returns a plain-text message for missing resources', async () => {
        const service = createResourceService({
            getAvailableWidgets: () => new Map(),
        });

        const result = await service.readResource('file://missing.md');

        expect(result.contents[0].text).toBe('Resource file://missing.md not found');
        expect(result.contents[0].mimeType).toBe('text/plain');
    });

    it('returns the Skyfire readme content when requested', async () => {
        const service = createResourceService({
            skyfireMode: true,
            getAvailableWidgets: () => new Map(),
        });

        const result = await service.readResource('file://readme.md');

        expect(result.contents[0].text).toBe(SKYFIRE_README_CONTENT);
        expect(result.contents[0].mimeType).toBe('text/markdown');
    });

    it('returns a plain-text message for unknown widgets', async () => {
        const service = createResourceService({
            uiMode: 'openai',
            getAvailableWidgets: () => new Map(),
        });

        const result = await service.readResource('ui://widget/unknown.html');

        expect(result.contents[0].text).toContain('Not found in registry.');
        expect(result.contents[0].mimeType).toBe('text/plain');
    });

    it('returns widget HTML when a widget exists', async () => {
        const fs = await import('node:fs');
        const readFileSync = vi.mocked(fs.readFileSync);
        readFileSync.mockReturnValue('console.log("widget");');

        const widgets = new Map<string, AvailableWidget>([
            [WIDGET_URIS.SEARCH_ACTORS, buildAvailableWidget(WIDGET_URIS.SEARCH_ACTORS, true)],
        ]);
        const service = createResourceService({
            uiMode: 'openai',
            getAvailableWidgets: () => widgets,
        });

        const result = await service.readResource(WIDGET_URIS.SEARCH_ACTORS);

        expect(result.contents[0].mimeType).toBe('text/html+skybridge');
        expect(result.contents[0].text).toContain('console.log("widget");');
        expect(result.contents[0].html).toContain('<script type="module">console.log("widget");</script>');
    });

    it('returns an empty resource templates list', async () => {
        const service = createResourceService({
            getAvailableWidgets: () => new Map(),
        });

        const result = await service.listResourceTemplates();

        expect(result).toEqual({ resourceTemplates: [] });
    });
});
