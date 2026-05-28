import type { ActorDefinition } from 'apify-client';
import { describe, expect, it } from 'vitest';

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
    it('should return null if webServerMcpPath is missing', () => {
        const actorDefinition = makeActorDefinitionWithPath();
        const result = getActorMCPServerPath(actorDefinition);
        expect(result).toBeNull();
    });

    it('should return null if webServerMcpPath is not a string', () => {
        const actorDefinition = makeActorDefinitionWithPath(123);
        const result = getActorMCPServerPath(actorDefinition);
        expect(result).toBeNull();
    });

    it('should return the single path if only one is present', () => {
        const actorDefinition = makeActorDefinitionWithPath('/mcp');
        const result = getActorMCPServerPath(actorDefinition);
        expect(result).toBe('/mcp');
    });

    it('should return the streamable path if present among multiple', () => {
        const actorDefinition = makeActorDefinitionWithPath(`/foo, ${MCP_STREAMABLE_ENDPOINT}, /bar`);
        const result = getActorMCPServerPath(actorDefinition);
        expect(result).toBe(MCP_STREAMABLE_ENDPOINT);
    });

    it('should return the first path if streamable is not present', () => {
        const actorDefinition = makeActorDefinitionWithPath('/foo, /bar, /baz');
        const result = getActorMCPServerPath(actorDefinition);
        expect(result).toBe('/foo');
    });

    it('should trim whitespace from paths', () => {
        const actorDefinition = makeActorDefinitionWithPath('   /foo  ,   /bar  ');
        const result = getActorMCPServerPath(actorDefinition);
        expect(result).toBe('/foo');
    });

    it('should handle streamable path with whitespace', () => {
        const actorDefinition = makeActorDefinitionWithPath(` /foo ,   ${MCP_STREAMABLE_ENDPOINT}  , /bar `);
        const result = getActorMCPServerPath(actorDefinition);
        expect(result).toBe(MCP_STREAMABLE_ENDPOINT);
    });
});

describe('getActorMCPServerURL', () => {
    const ACTOR_ID = 'abc123';
    const STANDBY = `https://${ACTOR_ID}.apify.actor`;

    it('returns URL on the standby origin for a normal path', async () => {
        const url = await getActorMCPServerURL(ACTOR_ID, '/mcp');
        expect(url).toBe(`${STANDBY}/mcp`);
    });

    it('returns URL on the standby origin for a path with query and fragment', async () => {
        const url = await getActorMCPServerURL(ACTOR_ID, '/mcp?x=1#frag');
        expect(url).toBe(`${STANDBY}/mcp?x=1#frag`);
    });

    // Apify Actor IDs are mixed-case; WHATWG URL parsing lowercases hostnames.
    // The origin check must compare two parser-normalised values, not raw strings.
    it('accepts a normal path for a mixed-case Actor ID', async () => {
        const url = await getActorMCPServerURL('Iei3c51WbI7eKwgSg', '/mcp');
        expect(url).toBe('https://iei3c51wbi7ekwgsg.apify.actor/mcp');
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
            url = await getActorMCPServerURL(ACTOR_ID, path);
        } catch (err) {
            expect((err as Error).message).toMatch(/resolves outside its standby origin/);
            return;
        }
        const parsed = new URL(url);
        expect(parsed.origin).toBe(STANDBY);
        expect(parsed.username).toBe('');
        expect(parsed.password).toBe('');
    });
});
