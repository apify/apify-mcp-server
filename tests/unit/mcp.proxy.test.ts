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
    const url = 'https://example.com/mcp';

    it('returns prefix-toolName when under the length cap', () => {
        const name = getProxyMCPServerToolName(url, 'list-items');
        expect(name).toBe(`${getMCPServerID(url)}-list-items`);
        expect(name.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
    });

    it('hash-suffixes over-length names instead of bare truncation', () => {
        const longTool = `very-long-origin-tool-name-${'x'.repeat(80)}`;
        const fullName = `${getMCPServerID(url)}-${longTool}`;
        const hash = createHash('sha256').update(fullName).digest('hex').slice(0, TOOL_NAME_HASH_LENGTH);
        const name = getProxyMCPServerToolName(url, longTool);

        expect(name.length).toBe(MAX_TOOL_NAME_LENGTH);
        expect(name.endsWith(`-${hash}`)).toBe(true);
        // Bare slice would drop the distinguishing suffix and collide; hash must survive.
        expect(name).not.toBe(fullName.slice(0, MAX_TOOL_NAME_LENGTH));
    });

    it('keeps two over-length origin names distinct after capping', () => {
        const sharedPrefix = `shared-prefix-${'y'.repeat(80)}`;
        const a = getProxyMCPServerToolName(url, `${sharedPrefix}-alpha`);
        const b = getProxyMCPServerToolName(url, `${sharedPrefix}-beta`);

        expect(a).not.toBe(b);
        expect(a.length).toBe(MAX_TOOL_NAME_LENGTH);
        expect(b.length).toBe(MAX_TOOL_NAME_LENGTH);
    });
});
