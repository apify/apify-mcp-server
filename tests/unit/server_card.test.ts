import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

import { SERVER_NAME, SERVER_TITLE, SERVER_VERSION } from '../../src/const.js';
import { getServerCard } from '../../src/server_card.js';
import { readJsonFile } from '../../src/utils/generic.js';

const serverJson = readJsonFile<{ description: string }>(import.meta.url, '../../server.json');

describe('getServerCard', () => {
    it('should return a valid MCP server card object', () => {
        const card = getServerCard();

        expect(card.$schema).toBe('https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json');
        expect(card.version).toBe('1.0');
        expect(card.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    });

    it('should contain required serverInfo fields using constants from const.ts', () => {
        const card = getServerCard();

        expect(card.serverInfo.name).toBe(SERVER_NAME);
        expect(card.serverInfo.title).toBe(SERVER_TITLE);
        expect(card.serverInfo.version).toBe(SERVER_VERSION);
    });

    it('should declare streamable-http transport at root endpoint', () => {
        const card = getServerCard();

        expect(card.transport.type).toBe('streamable-http');
        expect(card.transport.endpoint).toBe('/');
    });

    it('should declare tools capability with listChanged', () => {
        const card = getServerCard();

        expect(card.capabilities.tools.listChanged).toBe(true);
    });

    it('should require authentication with bearer and oauth2 schemes', () => {
        const card = getServerCard();

        expect(card.authentication.required).toBe(true);
        expect(card.authentication.schemes).toEqual(['bearer', 'oauth2']);
    });

    it('should declare tools as dynamic', () => {
        const card = getServerCard();

        expect(card.tools).toBe('dynamic');
    });

    it('should load description from server.json', () => {
        const card = getServerCard();

        expect(card.description).toBe(serverJson.description);
    });

    it('should include documentation URL', () => {
        const card = getServerCard();

        expect(card.documentationUrl).toBe('https://docs.apify.com/platform/integrations/mcp');
    });
});
