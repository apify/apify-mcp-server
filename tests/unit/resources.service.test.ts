import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';

import { SKYFIRE_README_CONTENT } from '../../src/payments/const.js';
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

// `contents[0]` is a text|blob union; narrow it in tests that read the text/widget shape.
function firstContent(result: { contents: unknown[] }): { mimeType?: string; text?: string; html?: string } {
    return result.contents[0] as { mimeType?: string; text?: string; html?: string };
}

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

            expect(firstContent(result).text).toBe(SKYFIRE_README_CONTENT);
            expect(firstContent(result).mimeType).toBe('text/markdown');
        });

        it('throws InvalidParams for an unknown URI', async () => {
            const service = createResourceService({
                getMode: () => 'default',
                getAvailableWidgets: () => new Map(),
            });

            const error = await service.readResource('file://missing.md').catch((e: unknown) => e);

            expect(error).toBeInstanceOf(McpError);
            expect((error as McpError).code).toBe(ErrorCode.InvalidParams);
            expect((error as McpError).message).toContain('file://missing.md');
            expect((error as McpError).data).toEqual({ uri: 'file://missing.md' });
        });

        it('throws the origin refusal for a non-Apify https URL', async () => {
            // http(s) URIs route to readApiResource, whose origin gate owns the refusal — the user
            // sees why the read was rejected, not the generic not-a-readable-resource fallback.
            const service = createResourceService({
                getMode: () => 'default',
                getAvailableWidgets: () => new Map(),
            });

            const error = await service.readResource('https://example.com/steal-my-token').catch((e: unknown) => e);

            expect(error).toBeInstanceOf(McpError);
            expect((error as McpError).code).toBe(ErrorCode.InvalidParams);
            expect((error as McpError).message).toContain('only Apify API URLs');
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

            expect(firstContent(result).mimeType).toBe('text/html;profile=mcp-app');
            expect(firstContent(result).text).toContain('console.log("widget");');
            expect(firstContent(result).html).toContain('<script type="module">console.log("widget");</script>');
        });

        it('returns a plain-text fallback for a widget URI not in the registry', async () => {
            const service = createResourceService({
                getMode: () => 'apps',
                getAvailableWidgets: () => new Map(),
            });

            const result = await service.readResource('ui://widget/unknown.html');

            expect(firstContent(result).text).toContain('Not found in registry.');
            expect(firstContent(result).mimeType).toBe('text/plain');
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

            expect(firstContent(result).text).toContain('File not found at');
            expect(firstContent(result).text).toContain(WIDGET_REGISTRY[WIDGET_URIS.SEARCH_ACTORS].jsFilename);
            expect(firstContent(result).mimeType).toBe('text/plain');
        });
    });

    describe('listResourceTemplates()', () => {
        it('advertises the common API URL shapes with descriptions', async () => {
            const service = createResourceService({
                getMode: () => 'default',
                getAvailableWidgets: () => new Map(),
            });

            const { resourceTemplates } = await service.listResourceTemplates();

            expect(resourceTemplates.map((t) => t.name)).toEqual([
                'dataset-items',
                'key-value-store-record',
                'key-value-store-keys',
                'actor-run',
                'actor-run-log',
            ]);
            for (const template of resourceTemplates) {
                expect(template.uriTemplate).toMatch(/^https:\/\/api\.apify\.com\/v2\//);
                expect(template.description).toBeTruthy();
            }
            // dataset-items advertises `format` (7 response types), so it must not pin a mimeType —
            // the spec allows a template mimeType only when all matching resources share one type.
            expect(resourceTemplates.find((t) => t.name === 'dataset-items')).not.toHaveProperty('mimeType');
        });

        it('exposes paging parameters as RFC 6570 query expansions', async () => {
            const service = createResourceService({
                getMode: () => 'default',
                getAvailableWidgets: () => new Map(),
            });

            const { resourceTemplates } = await service.listResourceTemplates();
            const byName = new Map(resourceTemplates.map((t) => [t.name, t.uriTemplate]));

            expect(byName.get('dataset-items')).toContain('{?limit,offset,');
            // KV key listings page with exclusiveStartKey, not offset.
            expect(byName.get('key-value-store-keys')).toContain('{?limit,exclusiveStartKey}');
            // A single record has no paging parameters at all.
            expect(byName.get('key-value-store-record')).not.toContain('{?');
        });
    });
});
