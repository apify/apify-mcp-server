import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';

import { APIFY_MCP_URL, SERVER_NAME, SERVER_TITLE } from '../../src/const.js';
import { getServerCard, getServerInfo } from '../../src/server_card.js';
import type { ServerCard, ServerCardRemote, ServerCardRepository } from '../../src/types.js';
import { readJsonFile } from '../../src/utils/generic.js';
import { getPackageVersion } from '../../src/utils/version.js';

const serverJson = readJsonFile<{
    $schema: string;
    name: string;
    description: string;
    title: string;
    websiteUrl: string;
    repository: ServerCardRepository;
    icons: ServerCard['icons'];
    remotes: ServerCardRemote[];
}>(import.meta.url, '../../server.json');

/**
 * Offline copy of the MCP Registry schema `server.json` declares in `$schema`. Dated registry
 * schemas are never edited, so the copy only needs replacing when `$schema` moves to a new date.
 */
const registrySchema = readJsonFile<{ $id: string }>(import.meta.url, './fixtures/server.schema.2025-12-11.json');

/** Returns the registry schema violations in `data`, empty when it conforms. */
function getRegistrySchemaErrors(data: unknown) {
    // `strict: false` because the schema uses OpenAPI's `example` keyword. Formats such as `uri` stay
    // unchecked: ajv-formats is not a dependency.
    const validate = new Ajv({ strict: false, validateFormats: false }).compile(registrySchema);
    validate(data);
    return validate.errors ?? [];
}

/**
 * The tools a default session serves, minus the client-gated `report-problem`. Pinned as a
 * literal so a change to the default set shows up in the diff instead of passing silently.
 */
const EXPECTED_TOOL_NAMES = [
    'search-actors',
    'fetch-actor-details',
    'call-actor',
    'get-actor-run',
    'get-dataset-items',
    'get-key-value-store-record',
    'abort-actor-run',
    'fetch-actor-mcp-tool-list',
    'call-actor-mcp-tool',
    'send-server-actor-request',
    'search-apify-docs',
    'fetch-apify-docs',
];

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

        it('sources repository, icons and remotes from server.json', () => {
            const card = getServerCard();

            expect(card.repository).toEqual(serverJson.repository);
            expect(card.icons).toEqual(serverJson.icons);
            expect(card.remotes).toEqual(serverJson.remotes);
        });

        it('sources title and websiteUrl from server.json', () => {
            const card = getServerCard();

            expect(card.title).toBe(serverJson.title);
            expect(card.websiteUrl).toBe(serverJson.websiteUrl);
            expect(card.serverUrl).toBe(APIFY_MCP_URL);
        });

        it('includes a PNG icon, which every icon-rendering client must support', () => {
            const card = getServerCard();

            expect(card.icons.some((icon) => icon.mimeType === 'image/png')).toBe(true);
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

            expect(card.documentationUrl).toBe('https://docs.apify.com/integrations/mcp');
        });
    });

    describe('tools', () => {
        it('lists exactly the tools a default session serves, without report-problem', () => {
            const card = getServerCard();

            expect(card.tools.map((tool) => tool.name)).toEqual(EXPECTED_TOOL_NAMES);
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
        expect(info.title).toBe(serverJson.title);
        expect(info.version).toBe(getPackageVersion());
        expect(info.description).toBe(serverJson.description);
        expect(info.websiteUrl).toBe(serverJson.websiteUrl);
        expect(info.icons).toEqual(serverJson.icons);
    });
});

describe('MCP Registry schema conformance', () => {
    it('declares the registry schema version the offline copy pins', () => {
        expect(serverJson.$schema).toBe(registrySchema.$id);
    });

    it('accepts server.json', () => {
        expect(getRegistrySchemaErrors(serverJson)).toEqual([]);
    });

    it('accepts the server card', () => {
        expect(getRegistrySchemaErrors(getServerCard())).toEqual([]);
    });

    it('rejects a name that is not reverse-DNS', () => {
        expect(getRegistrySchemaErrors({ ...serverJson, name: 'apify-mcp-server' })).not.toEqual([]);
    });
});
