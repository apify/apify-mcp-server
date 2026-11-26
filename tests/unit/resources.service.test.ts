import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { InternalError, InvalidParamsError } from '../../src/mcp/errors.js';
import { createResourceService } from '../../src/resources/resource_service.js';
import type { AvailableWidget } from '../../src/resources/widgets.js';
import { WIDGET_REGISTRY, WIDGET_URIS } from '../../src/resources/widgets.js';
import { mockApifyClient } from './helpers/tool_context.js';

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
        it('throws InvalidParams for an unknown URI', async () => {
            const service = createResourceService({
                getMode: () => 'default',
                getAvailableWidgets: () => new Map(),
            });

            const error = await service.readResource('file://missing.md').catch((e: unknown) => e);

            expect(error).toBeInstanceOf(InvalidParamsError);
            expect((error as InvalidParamsError).message).toContain('file://missing.md');
            expect((error as InvalidParamsError).data).toEqual({ uri: 'file://missing.md' });
        });

        it('throws the origin refusal for a non-Apify https URL', async () => {
            // http(s) URIs route to readApiResource, whose origin gate owns the refusal — the user
            // sees why the read was rejected, not the generic not-a-readable-resource fallback.
            const service = createResourceService({
                getMode: () => 'default',
                getAvailableWidgets: () => new Map(),
            });

            const error = await service.readResource('https://example.com/steal-my-token').catch((e: unknown) => e);

            expect(error).toBeInstanceOf(InvalidParamsError);
            expect((error as InvalidParamsError).message).toContain('only Apify API URLs');
        });

        it('throws InternalError when the API read hits a 5xx', async () => {
            // http(s) URIs route to readApiResource; a resolved 5xx maps to the InternalError class,
            // which must survive back out of readResource untouched (message + data preserved).
            const uri = 'https://api.apify.com/v2/datasets/ds-1/items';
            const apifyClient = mockApifyClient({
                httpClient: {
                    call: async () => ({
                        data: Readable.from([]),
                        headers: { 'content-type': 'application/json' },
                        status: 500,
                    }),
                },
            });
            const service = createResourceService({
                getMode: () => 'default',
                getAvailableWidgets: () => new Map(),
            });

            const error = await service.readResource(uri, apifyClient).catch((e: unknown) => e);

            expect(error).toBeInstanceOf(InternalError);
            expect((error as InternalError).message).toContain('Failed to read');
            expect((error as InternalError).message).toContain('HTTP 500');
            expect((error as InternalError).data).toEqual({ uri });
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

        it('throws InternalError without the server path when the widget file cannot be read', async () => {
            const fs = await import('node:fs');
            const widget = buildAvailableWidget(WIDGET_URIS.SEARCH_ACTORS, true);
            vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
                throw new Error(`EACCES: permission denied, open '${widget.jsPath}'`);
            });
            const service = createResourceService({
                getMode: () => 'apps',
                getAvailableWidgets: () => new Map([[WIDGET_URIS.SEARCH_ACTORS, widget]]),
            });

            const error = await service.readResource(WIDGET_URIS.SEARCH_ACTORS).catch((e: unknown) => e);

            expect(error).toBeInstanceOf(InternalError);
            expect((error as InternalError).data).toEqual({ uri: WIDGET_URIS.SEARCH_ACTORS });
            expect((error as InternalError).message).not.toContain(widget.jsPath);
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
