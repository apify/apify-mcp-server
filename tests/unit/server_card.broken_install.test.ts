import { afterEach, describe, expect, it, vi } from 'vitest';

import { SERVER_NAME, SERVER_TITLE } from '../../src/const.js';
import type * as GenericModule from '../../src/utils/generic.js';
import { getPackageVersion } from '../../src/utils/version.js';

/** Loads a fresh `server_card.js` whose `server.json` read is replaced by `readServerJson`. */
async function importServerCardWith(readServerJson: () => unknown) {
    vi.resetModules();
    vi.doMock('../../src/utils/generic.js', async (importOriginal) => {
        const actual = await importOriginal<typeof GenericModule>();
        // Only server.json is broken; package.json (read for the version) stays real.
        const readJsonFile = ((importMetaUrl: string, relativePath: string) =>
            relativePath.endsWith('server.json')
                ? readServerJson()
                : actual.readJsonFile(importMetaUrl, relativePath)) as typeof actual.readJsonFile;
        return { ...actual, readJsonFile };
    });
    return import('../../src/server_card.js');
}

// A broken install (truncated npx cache, files mixed from two releases) must not stop the stdio server.
describe('server info with a broken server.json install', () => {
    afterEach(() => {
        vi.doUnmock('../../src/utils/generic.js');
        vi.resetModules();
    });

    it('falls back to the constants when server.json is missing', async () => {
        const { getServerInfo } = await importServerCardWith(() => {
            throw Object.assign(new Error("ENOENT: no such file or directory, open 'server.json'"), { code: 'ENOENT' });
        });

        const info = getServerInfo();

        expect(info.name).toBe(SERVER_NAME);
        expect(info.title).toBe(SERVER_TITLE);
        expect(info.version).toBe(getPackageVersion());
        expect(info.icons).toBeUndefined();
    });

    it('omits icons when server.json predates them', async () => {
        const { getServerInfo } = await importServerCardWith(() => ({ title: 'Apify MCP Server' }));

        const info = getServerInfo();

        expect(info.title).toBe('Apify MCP Server');
        expect(info.icons).toBeUndefined();
    });
});
