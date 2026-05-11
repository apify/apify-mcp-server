import { describe, expect, it, vi } from 'vitest';

import { SKYFIRE_README_CONTENT } from '../../src/const.js';
import { resolvePaymentProvider } from '../../src/payments/index.js';
import type { PaymentProvider } from '../../src/payments/types.js';
import { createResourceService } from '../../src/resources/resource_service.js';
import type { AvailableWidget } from '../../src/resources/widgets.js';
import { WIDGET_REGISTRY, WIDGET_URIS } from '../../src/resources/widgets.js';

vi.mock('node:fs', () => ({
    readFileSync: vi.fn(),
    default: {
        readFileSync: vi.fn(),
    },
}));

const buildAvailableWidget = (uri: string, exists: boolean): AvailableWidget => ({
    ...WIDGET_REGISTRY[uri],
    jsPath: `/tmp/${WIDGET_REGISTRY[uri].jsFilename}`,
    exists,
});

describe('createResourceService()', () => {
    describe('listResources()', () => {
        it('lists the Skyfire readme only when enabled', async () => {
            const skyfireService = createResourceService({
                getMode: () => 'default',
                paymentProvider: await resolvePaymentProvider('skyfire'),
                getAvailableWidgets: () => new Map(),
            });
            const defaultService = createResourceService({
                getMode: () => 'default',
                paymentProvider: undefined,
                getAvailableWidgets: () => new Map(),
            });

            const skyfireResources = await skyfireService.listResources();
            const defaultResources = await defaultService.listResources();

            expect(skyfireResources.resources.some((resource) => resource.uri === 'file://readme.md')).toBe(true);
            expect(defaultResources.resources.some((resource) => resource.uri === 'file://readme.md')).toBe(false);
        });

        it('does not list the readme when the provider returns no usage guide', async () => {
            const provider = { getUsageGuide: () => null } as unknown as PaymentProvider;
            const service = createResourceService({
                getMode: () => 'default',
                paymentProvider: provider,
                getAvailableWidgets: () => new Map(),
            });

            const { resources } = await service.listResources();

            expect(resources.some((resource) => resource.uri === 'file://readme.md')).toBe(false);
        });

        it('lists apps widgets only when their files exist', async () => {
            const widgets = new Map<string, AvailableWidget>([
                [WIDGET_URIS.SEARCH_ACTORS, buildAvailableWidget(WIDGET_URIS.SEARCH_ACTORS, true)],
                [WIDGET_URIS.ACTOR_RUN, buildAvailableWidget(WIDGET_URIS.ACTOR_RUN, false)],
            ]);
            const service = createResourceService({
                getMode: () => 'apps',
                getAvailableWidgets: () => widgets,
            });

            const { resources } = await service.listResources();

            expect(resources.map((resource) => resource.uri)).toEqual([WIDGET_URIS.SEARCH_ACTORS]);
        });
    });

    describe('readResource()', () => {
        it('returns the Skyfire readme content', async () => {
            const service = createResourceService({
                getMode: () => 'default',
                paymentProvider: await resolvePaymentProvider('skyfire'),
                getAvailableWidgets: () => new Map(),
            });

            const result = await service.readResource('file://readme.md');

            expect(result.contents[0].text).toBe(SKYFIRE_README_CONTENT);
            expect(result.contents[0].mimeType).toBe('text/markdown');
        });

        it('returns a plain-text fallback for an unknown URI', async () => {
            const service = createResourceService({
                getMode: () => 'default',
                getAvailableWidgets: () => new Map(),
            });

            const result = await service.readResource('file://missing.md');

            expect(result.contents[0].text).toBe('Resource file://missing.md not found');
            expect(result.contents[0].mimeType).toBe('text/plain');
        });

        it('returns widget HTML when the widget exists', async () => {
            const fs = await import('node:fs');
            const readFileSync = vi.mocked(fs.readFileSync);
            readFileSync.mockReturnValue('console.log("widget");');

            const widgets = new Map<string, AvailableWidget>([
                [WIDGET_URIS.SEARCH_ACTORS, buildAvailableWidget(WIDGET_URIS.SEARCH_ACTORS, true)],
            ]);
            const service = createResourceService({
                getMode: () => 'apps',
                getAvailableWidgets: () => widgets,
            });

            const result = await service.readResource(WIDGET_URIS.SEARCH_ACTORS);

            expect(result.contents[0].mimeType).toBe('text/html;profile=mcp-app');
            expect(result.contents[0].text).toContain('console.log("widget");');
            expect(result.contents[0].html).toContain('<script type="module">console.log("widget");</script>');
        });

        it('returns a plain-text fallback for a widget URI not in the registry', async () => {
            const service = createResourceService({
                getMode: () => 'apps',
                getAvailableWidgets: () => new Map(),
            });

            const result = await service.readResource('ui://widget/unknown.html');

            expect(result.contents[0].text).toContain('Not found in registry.');
            expect(result.contents[0].mimeType).toBe('text/plain');
        });

        it('returns a plain-text fallback when the widget file is missing on disk', async () => {
            const widgets = new Map<string, AvailableWidget>([
                [WIDGET_URIS.SEARCH_ACTORS, buildAvailableWidget(WIDGET_URIS.SEARCH_ACTORS, false)],
            ]);
            const service = createResourceService({
                getMode: () => 'apps',
                getAvailableWidgets: () => widgets,
            });

            const result = await service.readResource(WIDGET_URIS.SEARCH_ACTORS);

            expect(result.contents[0].text).toContain('File not found at');
            expect(result.contents[0].text).toContain(WIDGET_REGISTRY[WIDGET_URIS.SEARCH_ACTORS].jsFilename);
            expect(result.contents[0].mimeType).toBe('text/plain');
        });
    });

    describe('listResourceTemplates()', () => {
        it('returns an empty list', async () => {
            const service = createResourceService({
                getMode: () => 'default',
                getAvailableWidgets: () => new Map(),
            });

            const result = await service.listResourceTemplates();

            expect(result).toEqual({ resourceTemplates: [] });
        });
    });
});
