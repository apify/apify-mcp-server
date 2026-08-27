import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

import { APIFY_LOGO_URL, APIFY_MCP_URL, SERVER_NAME, SERVER_TITLE } from '../../src/const.js';
import { getServerCard, getServerInfo } from '../../src/server_card.js';
import { getDefaultTools } from '../../src/tools/index.js';
import type { ServerCardRemote, ServerCardRepository } from '../../src/types.js';
import { readJsonFile } from '../../src/utils/generic.js';
import { getPackageVersion } from '../../src/utils/version.js';

const serverJson = readJsonFile<{
    $schema: string;
    name: string;
    description: string;
    repository: ServerCardRepository;
    remotes: ServerCardRemote[];
}>(import.meta.url, '../../server.json');

/** Registry schema constraint on `name`: reverse-DNS with exactly one forward slash. */
const REGISTRY_NAME_PATTERN = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;

describe('getServerCard()', () => {
    it('inherits $schema from server.json', () => {
        const card = getServerCard();

        expect(card.$schema).toBe(serverJson.$schema);
    });

    it('declares the latest protocol version', () => {
        const card = getServerCard();

        expect(card.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    });

    describe('registry-shaped identity', () => {
        it('carries the three fields the registry schema requires', () => {
            const card = getServerCard();

            expect(card.name).toBe(serverJson.name);
            expect(card.description).toBe(serverJson.description);
            expect(card.version).toBe(getPackageVersion());
        });

        it('uses a name matching the registry reverse-DNS pattern', () => {
            const card = getServerCard();

            expect(card.name).toMatch(REGISTRY_NAME_PATTERN);
        });

        it('sources repository and remotes from server.json', () => {
            const card = getServerCard();

            expect(card.repository).toEqual(serverJson.repository);
            expect(card.remotes).toEqual(serverJson.remotes);
        });

        it('exposes title, websiteUrl and serverUrl', () => {
            const card = getServerCard();

            expect(card.title).toBe(SERVER_TITLE);
            expect(card.websiteUrl).toBe(APIFY_MCP_URL);
            expect(card.serverUrl).toBe(APIFY_MCP_URL);
        });

        it('uses an icon with a registry-permitted mime type', () => {
            const card = getServerCard();

            expect(card.icons).toEqual([{ src: APIFY_LOGO_URL, mimeType: 'image/png', sizes: ['180x180'] }]);
        });
    });

    describe('SEP-1649 compatibility fields', () => {
        it('keeps serverInfo populated from constants', () => {
            const card = getServerCard();

            expect(card.serverInfo.name).toBe(SERVER_NAME);
            expect(card.serverInfo.title).toBe(SERVER_TITLE);
            expect(card.serverInfo.version).toBe(getPackageVersion());
        });

        it('declares streamable-http transport at root endpoint', () => {
            const card = getServerCard();

            expect(card.transport.type).toBe('streamable-http');
            expect(card.transport.endpoint).toBe('/');
        });

        it('declares the tools capability with no sub-capabilities', () => {
            const card = getServerCard();

            expect(card.capabilities.tools).toEqual({});
        });

        it('requires authentication with bearer and oauth2 schemes', () => {
            const card = getServerCard();

            expect(card.authentication.required).toBe(true);
            expect(card.authentication.schemes).toEqual(['bearer', 'oauth2']);
        });

        it('includes documentation URL', () => {
            const card = getServerCard();

            expect(card.documentationUrl).toBe('https://docs.apify.com/platform/integrations/mcp');
        });
    });

    describe('tools', () => {
        it('lists exactly the default-mode tools', () => {
            const card = getServerCard();

            expect(card.tools.map((tool) => tool.name)).toEqual(getDefaultTools().map((tool) => tool.name));
        });

        it('gives every tool a title, a description and annotations', () => {
            const card = getServerCard();

            expect(card.tools.length).toBeGreaterThan(0);
            for (const tool of card.tools) {
                expect(tool.title).toBeTruthy();
                expect(tool.description?.length ?? 0).toBeGreaterThan(20);
                expect(tool.annotations).toBeDefined();
            }
        });

        it('omits input schemas to keep the card small', () => {
            const card = getServerCard();

            for (const tool of card.tools) {
                expect(tool).not.toHaveProperty('inputSchema');
            }
        });
    });
});

describe('getServerInfo()', () => {
    it('returns name, title and version', () => {
        const info = getServerInfo();

        expect(info.name).toBe(SERVER_NAME);
        expect(info.title).toBe(SERVER_TITLE);
        expect(info.version).toBe(getPackageVersion());
        expect(info.description).toBe(serverJson.description);
        expect(info.websiteUrl).toBe(APIFY_MCP_URL);
        expect(info.icons).toEqual([{ src: APIFY_LOGO_URL, mimeType: 'image/png', sizes: ['180x180'] }]);
    });
});
