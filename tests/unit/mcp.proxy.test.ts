import { createHash } from 'node:crypto';

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { describe, expect, it } from 'vitest';

import {
    MAX_TOOL_NAME_LENGTH,
    MAX_TOOL_NAME_USERNAME_LENGTH,
    SERVER_ID_LENGTH,
    TOOL_NAME_HASH_LENGTH,
} from '../../src/mcp/const.js';
import { getMCPServerID, getMCPServerTools, getProxyMCPServerToolName } from '../../src/mcp/proxy.js';

describe('getMCPServerID()', () => {
    it('returns a stable SERVER_ID_LENGTH hex prefix of sha256(url)', () => {
        const url = 'https://example.com/mcp';
        const expected = createHash('sha256').update(url).digest('hex').slice(0, SERVER_ID_LENGTH);
        expect(getMCPServerID(url)).toBe(expected);
        expect(getMCPServerID(url)).toBe(getMCPServerID(url));
    });

    it('keys by URL so SSE and streamable endpoints stay distinct', () => {
        expect(getMCPServerID('https://actor.example/sse')).not.toBe(getMCPServerID('https://actor.example/mcp'));
    });
});

describe('getProxyMCPServerToolName()', () => {
    it('prefixes the tool name with the Actor tool name', () => {
        expect(getProxyMCPServerToolName('apify/example-mcp-server', 'add')).toBe('apify--example-mcp-server--add');
    });

    it('sanitizes a dotted username the same way Actor tool names do', () => {
        expect(getProxyMCPServerToolName('the.unc/my-mcp-server', 'add')).toBe('the-dot-unc--my-mcp-server--add');
    });

    it('hash-suffixes over-length names instead of bare truncation', () => {
        const originToolName = 'search-actors-and-fetch-full-details-for-each-result';
        const fullName = `apify--my-mcp-server--${originToolName}`;
        const hash = createHash('sha256').update(fullName).digest('hex').slice(0, TOOL_NAME_HASH_LENGTH);
        const name = getProxyMCPServerToolName('apify/my-mcp-server', originToolName);

        expect(name).toBe('apify--my-mcp-server--search-actors-and-fetch-full-details--c5b2');
        expect(name.length).toBe(MAX_TOOL_NAME_LENGTH);
        expect(name.endsWith(`-${hash}`)).toBe(true);
        // Bare slice would drop the distinguishing suffix and collide; hash must survive.
        expect(name).not.toBe(fullName.slice(0, MAX_TOOL_NAME_LENGTH));
    });

    it('keeps two over-length origin names distinct after capping', () => {
        const sharedPrefix = `shared-prefix-${'y'.repeat(80)}`;
        const a = getProxyMCPServerToolName('apify/my-mcp-server', `${sharedPrefix}-alpha`);
        const b = getProxyMCPServerToolName('apify/my-mcp-server', `${sharedPrefix}-beta`);

        expect(a).not.toBe(b);
        expect(a.length).toBe(MAX_TOOL_NAME_LENGTH);
        expect(b.length).toBe(MAX_TOOL_NAME_LENGTH);
    });

    it('caps the username when the assembled name exceeds the limit', () => {
        const actorFullName = 'crawler_enthusiast/web-scraping-dataset-tools-mcp-server';

        expect(getProxyMCPServerToolName(actorFullName, 'search')).toBe(
            'crawler_--web-scraping-dataset-tools-mcp-server--search-e41a',
        );
        expect(getProxyMCPServerToolName(actorFullName, 'analyze')).toBe(
            'crawler_--web-scraping-dataset-tools-mcp-server--analyze-ed60',
        );
    });

    it("keeps one identical prefix across an Actor's over-length tool names", () => {
        const actorFullName = 'crawler_enthusiast/web-scraping-dataset-tools-mcp-server';
        const names = ['search', 'analyze', 'get-company-profile'].map((toolName) =>
            getProxyMCPServerToolName(actorFullName, toolName),
        );

        for (const name of names) {
            expect(name.startsWith('crawler_--web-scraping-dataset-tools-mcp-server--')).toBe(true);
            expect(name.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
        }
    });

    it('truncates the tool name only when capping the username is not enough', () => {
        const uncappedFullName = 'crawler_enthusiast--web-scraping-dataset-tools-mcp-server--get-company-profile';
        const hash = createHash('sha256').update(uncappedFullName).digest('hex').slice(0, TOOL_NAME_HASH_LENGTH);
        const name = getProxyMCPServerToolName(
            'crawler_enthusiast/web-scraping-dataset-tools-mcp-server',
            'get-company-profile',
        );

        expect(name).toBe('crawler_--web-scraping-dataset-tools-mcp-server--get-compan-b992');
        expect(name.length).toBe(MAX_TOOL_NAME_LENGTH);
        expect(name.endsWith(`-${hash}`)).toBe(true);
    });

    it('reads the username from the Actor full name, not from the first "--"', () => {
        const name = getProxyMCPServerToolName(
            'crawler_enthusiast/dataset--exporter-mcp-server',
            'a-very-long-tool-name-that-forces-truncation-of-the-assembled-name',
        );

        expect(name).toBe('crawler_--dataset--exporter-mcp-server--a-very-long-tool-na-fc26');
        expect(name.split('--')[0]).toBe('crawler_enthusiast'.slice(0, MAX_TOOL_NAME_USERNAME_LENGTH));
        expect(name.startsWith('crawler_--dataset--exporter-mcp-server--')).toBe(true);
    });

    it('escapes a dotted username before capping it', () => {
        expect(getProxyMCPServerToolName('actor.fan/web-scraping-dataset-tools-mcp-server', 'get-company')).toBe(
            'actor-do--web-scraping-dataset-tools-mcp-server--get-compan-4ecf',
        );
        // Escaping after capping would exceed the username cap.
        expect(
            getProxyMCPServerToolName('actor.fan/web-scraping-dataset-tools-mcp-server---structured-output', 'add'),
        ).toBe('actor-do--web-scraping-dataset-tools-mcp-server---structure-09ce');
    });

    it('trims a trailing dash off the capped username', () => {
        expect(getProxyMCPServerToolName('web.scraper-club/web-scraping-dataset-tools-mcp-server', 'search')).toBe(
            'web-dot--web-scraping-dataset-tools-mcp-server--search-750f',
        );
    });

    it('truncates and hashes once for an Actor whose name alone exceeds the limit', () => {
        const name = getProxyMCPServerToolName(
            'crawler_enthusiast/web-scraping-dataset-tools-mcp-server---structured-output',
            'search',
        );

        expect(name).toBe('crawler_--web-scraping-dataset-tools-mcp-server---structure-59fe');
        expect(name.length).toBe(MAX_TOOL_NAME_LENGTH);
    });

    it('omits the username segment when the Actor full name has no slash', () => {
        expect(getProxyMCPServerToolName('web-scraping-dataset-tools-mcp-server', 'search')).toBe(
            'web-scraping-dataset-tools-mcp-server--search',
        );
    });

    it('skips the username cap when there is no username to cap', () => {
        const uncappedFullName = 'web-scraping-dataset-tools-mcp-server--a-very-long-tool-name-that-forces-truncation';
        const hash = createHash('sha256').update(uncappedFullName).digest('hex').slice(0, TOOL_NAME_HASH_LENGTH);
        const name = getProxyMCPServerToolName(
            'web-scraping-dataset-tools-mcp-server',
            'a-very-long-tool-name-that-forces-truncation',
        );

        expect(name).toBe('web-scraping-dataset-tools-mcp-server--a-very-long-tool-nam-2f2b');
        expect(name.length).toBe(MAX_TOOL_NAME_LENGTH);
        expect(name.endsWith(`-${hash}`)).toBe(true);
    });

    it('leaves the username segment empty when the capped username is all dashes', () => {
        const actorName = 'web-scraping-dataset-tools-mcp-server---structured-data';
        const name = getProxyMCPServerToolName(`--------/${actorName}`, 'toolname');

        expect(name).toBe('--web-scraping-dataset-tools-mcp-server---structured-data---9d1e');
        expect(name.length).toBe(MAX_TOOL_NAME_LENGTH);
        expect(name).not.toBe(getProxyMCPServerToolName(`----------/${actorName}`, 'toolname'));
    });
});

describe('getMCPServerTools()', () => {
    it('keeps the full username when every tool name fits', async () => {
        const client = {
            listTools: async () => ({
                tools: [
                    { name: 'add', description: 'Adds two numbers', inputSchema: { type: 'object' } },
                    { name: 'subtract', description: 'Subtracts two numbers', inputSchema: { type: 'object' } },
                ],
            }),
        } as unknown as Client;

        const tools = await getMCPServerTools(
            'actor-id',
            client,
            'https://example-mcp-server.apify.actor/mcp',
            'longusername1/my-mcp-server',
        );

        expect(tools.map(({ name }) => name)).toEqual([
            'longusername1--my-mcp-server--add',
            'longusername1--my-mcp-server--subtract',
        ]);
    });

    it("caps the username for every tool when one tool's name exceeds the limit", async () => {
        const client = {
            listTools: async () => ({
                tools: [
                    { name: 'add', description: 'Adds two numbers', inputSchema: { type: 'object' } },
                    {
                        name: 'a-tool-name-long-enough-to-push-past-the-limit-xxxx',
                        description: 'Runs a long operation',
                        inputSchema: { type: 'object' },
                    },
                ],
            }),
        } as unknown as Client;

        const tools = await getMCPServerTools(
            'actor-id',
            client,
            'https://example-mcp-server.apify.actor/mcp',
            'longusername1/my-mcp-server',
        );

        expect(tools.map(({ name }) => name)).toEqual([
            'longuser--my-mcp-server--add',
            'longuser--my-mcp-server--a-tool-name-long-enough-to-push-pa-fa1b',
        ]);
    });
});
