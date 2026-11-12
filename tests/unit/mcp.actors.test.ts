import type { ActorDefinition } from 'apify-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getActorMCPServerPath, getActorMCPServerURL } from '../../src/mcp/actors.js';
import { MCP_STREAMABLE_ENDPOINT } from '../../src/mcp/const.js';

// Helper to create a valid ActorDefinition and allow webServerMcpPath for testing
function makeActorDefinitionWithPath(webServerMcpPath?: unknown): ActorDefinition {
    return {
        actorSpecification: 0,
        name: 'dummy',
        version: '0.0',
        ...(webServerMcpPath !== undefined ? { webServerMcpPath } : {}),
    };
}

describe('getActorMCPServerPath', () => {
    it('returns null if webServerMcpPath is missing', () => {
        const actorDefinition = makeActorDefinitionWithPath();
        const result = getActorMCPServerPath(actorDefinition);
        expect(result).toBeNull();
    });

    it('returns null if webServerMcpPath is not a string', () => {
        const actorDefinition = makeActorDefinitionWithPath(123);
        const result = getActorMCPServerPath(actorDefinition);
        expect(result).toBeNull();
    });

    it('returns the single path if only one is present', () => {
        const actorDefinition = makeActorDefinitionWithPath('/mcp');
        const result = getActorMCPServerPath(actorDefinition);
        expect(result).toBe('/mcp');
    });

    it('returns the streamable path if present among multiple', () => {
        const actorDefinition = makeActorDefinitionWithPath(`/foo, ${MCP_STREAMABLE_ENDPOINT}, /bar`);
        const result = getActorMCPServerPath(actorDefinition);
        expect(result).toBe(MCP_STREAMABLE_ENDPOINT);
    });

    it('returns the first path if streamable is not present', () => {
        const actorDefinition = makeActorDefinitionWithPath('/foo, /bar, /baz');
        const result = getActorMCPServerPath(actorDefinition);
        expect(result).toBe('/foo');
    });

    it('trims whitespace from paths', () => {
        const actorDefinition = makeActorDefinitionWithPath('   /foo  ,   /bar  ');
        const result = getActorMCPServerPath(actorDefinition);
        expect(result).toBe('/foo');
    });

    it('handles streamable path with whitespace', () => {
        const actorDefinition = makeActorDefinitionWithPath(` /foo ,   ${MCP_STREAMABLE_ENDPOINT}  , /bar `);
        const result = getActorMCPServerPath(actorDefinition);
        expect(result).toBe(MCP_STREAMABLE_ENDPOINT);
    });
});

describe('getActorMCPServerURL', () => {
    const STANDBY = 'https://acme-mcp-server.apify.actor';
    const ACTOR = { id: 'abc123', standbyUrl: STANDBY };

    it('returns URL on the standby origin for a normal path', async () => {
        const url = await getActorMCPServerURL(ACTOR, '/mcp');
        expect(url).toBe(`${STANDBY}/mcp`);
    });

    it('returns URL on the standby origin for a path with query and fragment', async () => {
        const url = await getActorMCPServerURL(ACTOR, '/mcp?x=1#frag');
        expect(url).toBe(`${STANDBY}/mcp?x=1#frag`);
    });

    // WHATWG URL parsing lowercases hostnames. The origin check must compare two
    // parser-normalised values, not raw strings.
    it('accepts a normal path for a mixed-case standby host', async () => {
        const url = await getActorMCPServerURL(
            { id: 'abc123', standbyUrl: 'https://Acme-MCP-Server.apify.actor' },
            '/mcp',
        );
        expect(url).toBe(`${STANDBY}/mcp`);
    });

    // Inputs that, under the buggy `${standby}${path}` concat, would produce a URL
    // whose hostname is NOT *.apify.actor and would leak the caller's Apify token
    // to a third party. The fix uses `new URL(path, base)` which resolves these as
    // either same-origin path components or rejects them outright — either way no
    // request leaves the standby origin.
    it.each([
        // Original CVE PoC — userinfo authority injection (`@host`).
        '@evil.example/mcp',
        // Subdomain concatenation — fetch-clean variant that worked against production.
        '.evil.example/mcp',
        // Protocol-relative authority hijack.
        '//evil.example/mcp',
        // Absolute URL pointing elsewhere.
        'https://evil.example/mcp',
        // Backslash variant of protocol-relative (some URL parsers normalize \ → /).
        '\\\\evil.example/mcp',
    ])('never resolves outside the standby origin for malicious input: %s', async (path) => {
        let url: string | undefined;
        try {
            url = await getActorMCPServerURL(ACTOR, path);
        } catch (err) {
            expect((err as Error).message).toMatch(/resolves outside its standby origin/);
            return;
        }
        const parsed = new URL(url);
        expect(parsed.origin).toBe(STANDBY);
        expect(parsed.username).toBe('');
        expect(parsed.password).toBe('');
    });

    // The API omits `standbyUrl` when Actor Standby is off; a guessed host would carry the caller's token elsewhere.
    it('throws a configuration error instead of inventing a host when the Actor has no standby URL', async () => {
        await expect(getActorMCPServerURL({ id: 'abc123' }, '/mcp')).rejects.toThrow(/no valid standby URL/);
    });

    it('throws a configuration error for an unparsable standby URL', async () => {
        await expect(getActorMCPServerURL({ id: 'abc123', standbyUrl: 'not a url' }, '/mcp')).rejects.toThrow(
            /standby URL/,
        );
    });
});

describe('accepts a standby URL only on the platform standby domain', () => {
    afterEach(() => vi.unstubAllEnvs());

    describe('with the platform API', () => {
        beforeEach(() => vi.stubEnv('APIFY_API_BASE_URL', 'https://api.apify.com'));

        it.each(['https://acme--mcp-server.apify.actor', 'https://acme--mcp-server.eu.apify.actor'])(
            'accepts an https subdomain of the standby domain: %s',
            async (standbyUrl) => {
                await expect(getActorMCPServerURL({ id: 'abc123', standbyUrl }, '/mcp')).resolves.toBe(
                    `${standbyUrl}/mcp`,
                );
            },
        );

        it.each([
            ['another host', 'https://acme.example.com'],
            ['the bare standby domain', 'https://apify.actor'],
            ['a host that only ends with the domain name', 'https://xapify.actor'],
            ['the domain as a label of another host', 'https://acme.apify.actor.example'],
            ['a trailing dot', 'https://acme.apify.actor.'],
            ['a non-ASCII lookalike', 'https://acme.apify.аctor'],
            ['plain http', 'http://acme.apify.actor'],
            ['an explicit port', 'https://acme.apify.actor:8443'],
            ['credentials', 'https://user:pass@acme.apify.actor'],
            ['a loopback host', 'http://127.0.0.1:8003'],
        ])('refuses %s', async (_case, standbyUrl) => {
            await expect(getActorMCPServerURL({ id: 'abc123', standbyUrl }, '/mcp')).rejects.toThrow(
                /Actor abc123 .*not on the platform standby domain/,
            );
        });
    });

    describe('with a local API', () => {
        beforeEach(() => {
            vi.stubEnv('APIFY_API_BASE_URL', 'http://localhost:3333');
            vi.stubEnv('APIFY_IS_AT_HOME', '');
        });

        it.each(['http://127.0.0.1:8003', 'http://acme--mcp-server.localhost:8003', 'http://[::1]:8003'])(
            'accepts a loopback host: %s',
            async (standbyUrl) => {
                await expect(getActorMCPServerURL({ id: 'abc123', standbyUrl }, '/mcp')).resolves.toBe(
                    `${standbyUrl}/mcp`,
                );
            },
        );

        it('refuses plain http on another host', async () => {
            await expect(
                getActorMCPServerURL({ id: 'abc123', standbyUrl: 'http://acme.example.com' }, '/mcp'),
            ).rejects.toThrow(/standby domain/);
        });

        // On the platform, the configured API is the platform API whatever APIFY_API_BASE_URL says.
        it('refuses a loopback host when running on the platform', async () => {
            vi.stubEnv('APIFY_IS_AT_HOME', '1');

            await expect(
                getActorMCPServerURL({ id: 'abc123', standbyUrl: 'http://127.0.0.1:8003' }, '/mcp'),
            ).rejects.toThrow(/standby domain/);
        });
    });
});
