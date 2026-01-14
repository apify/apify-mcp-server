import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { type AvailableWidget, getWidgetConfig, resolveAvailableWidgets, WIDGET_REGISTRY, WIDGET_URIS } from '../../src/utils/widgets.js';

vi.mock('node:fs', () => ({
    default: {
        existsSync: vi.fn(),
    },
    existsSync: vi.fn(),
}));

describe('Widget Utils', () => {
    describe('getWidgetConfig', () => {
        it('should return config for valid URI', () => {
            const uri = WIDGET_URIS.SEARCH_ACTORS;
            const config = getWidgetConfig(uri);
            expect(config).toBeDefined();
            expect(config?.uri).toBe(uri);
        });

        it('should return undefined for invalid URI', () => {
            const config = getWidgetConfig('ui://invalid');
            expect(config).toBeUndefined();
        });
    });

    describe('resolveAvailableWidgets', () => {
        it('should correctly identify existing and missing widgets', async () => {
            const fs = await import('node:fs');
            const mockExistsSync = vi.mocked(fs.existsSync);

            // Mock behavior: search-actors exists, actor-run is missing
            mockExistsSync.mockImplementation((p) => {
                if (typeof p === 'string' && p.includes('search-actors-widget.js')) return true;
                return false;
            });

            const baseDir = '/app/dist/mcp';
            const resolved = await resolveAvailableWidgets(baseDir);

            expect(resolved.size).toBe(Object.keys(WIDGET_REGISTRY).length);

            const searchWidget = resolved.get(WIDGET_URIS.SEARCH_ACTORS);
            expect(searchWidget?.exists).toBe(true);
            expect(searchWidget?.jsPath).toBe(path.resolve('/app/dist/web/dist/search-actors-widget.js'));

            const runWidget = resolved.get(WIDGET_URIS.ACTOR_RUN);
            expect(runWidget?.exists).toBe(false);
        });

        it('should handle path resolution correctly', async () => {
            const fs = await import('node:fs');
            const mockExistsSync = vi.mocked(fs.existsSync);
            mockExistsSync.mockReturnValue(true);

            const baseDir = '/test/path/dist/mcp';
            const resolved = await resolveAvailableWidgets(baseDir);

            for (const widget of resolved.values()) {
                // Should resolve to ../web/dist relative to baseDir
                expect(widget.jsPath).toBe(path.resolve('/test/path/dist/web/dist', (widget as AvailableWidget).jsFilename));
            }
        });
    });
});
