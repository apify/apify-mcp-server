import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { MAX_TOOL_NAME_LENGTH, SERVER_ID_LENGTH, TOOL_NAME_HASH_LENGTH } from '../../src/mcp/const.js';
import { getMCPServerID, getProxyMCPServerToolName } from '../../src/mcp/proxy.js';

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
        expect(getProxyMCPServerToolName('jiri.spilka/my-mcp-server', 'add')).toBe(
            'jiri-dot-spilka--my-mcp-server--add',
        );
    });

    it('hash-suffixes over-length names instead of bare truncation', () => {
        const originToolName = 'search-actors-and-fetch-full-details-for-each-result';
        const fullName = `apify--actors-mcp-server--${originToolName}`;
        const hash = createHash('sha256').update(fullName).digest('hex').slice(0, TOOL_NAME_HASH_LENGTH);
        const name = getProxyMCPServerToolName('apify/actors-mcp-server', originToolName);

        expect(name).toBe('apify--actors-mcp-server--search-actors-and-fetch-full-deta-5a82');
        expect(name.length).toBe(MAX_TOOL_NAME_LENGTH);
        expect(name.endsWith(`-${hash}`)).toBe(true);
        // Bare slice would drop the distinguishing suffix and collide; hash must survive.
        expect(name).not.toBe(fullName.slice(0, MAX_TOOL_NAME_LENGTH));
    });

    it('keeps two over-length origin names distinct after capping', () => {
        const sharedPrefix = `shared-prefix-${'y'.repeat(80)}`;
        const a = getProxyMCPServerToolName('apify/actors-mcp-server', `${sharedPrefix}-alpha`);
        const b = getProxyMCPServerToolName('apify/actors-mcp-server', `${sharedPrefix}-beta`);

        expect(a).not.toBe(b);
        expect(a.length).toBe(MAX_TOOL_NAME_LENGTH);
        expect(b.length).toBe(MAX_TOOL_NAME_LENGTH);
    });
});
