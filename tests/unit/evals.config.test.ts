import { describe, expect, it } from 'vitest';

import { isMcpToolName, stripToolPrefix } from '../../evals/config.js';

describe('isMcpToolName()', () => {
    it('matches names with the mcp__apify__ prefix', () => {
        expect(isMcpToolName('mcp__apify__search-actors')).toBe(true);
    });

    it('rejects built-in tool names without the prefix', () => {
        expect(isMcpToolName('Bash')).toBe(false);
        expect(isMcpToolName('Read')).toBe(false);
    });

    it('rejects a prefix for a different server', () => {
        expect(isMcpToolName('mcp__other__search-actors')).toBe(false);
    });

    it('rejects the prefix substring appearing mid-string', () => {
        expect(isMcpToolName('search-mcp__apify__actors')).toBe(false);
    });

    it('matches the bare prefix with nothing after it', () => {
        expect(isMcpToolName('mcp__apify__')).toBe(true);
    });

    it('rejects an empty string', () => {
        expect(isMcpToolName('')).toBe(false);
    });
});

describe('stripToolPrefix()', () => {
    it('removes the mcp__apify__ prefix', () => {
        expect(stripToolPrefix('mcp__apify__search-actors')).toBe('search-actors');
    });

    it('passes through built-in tool names unchanged', () => {
        expect(stripToolPrefix('Bash')).toBe('Bash');
    });

    it('passes through a different server prefix unchanged', () => {
        expect(stripToolPrefix('mcp__other__search-actors')).toBe('mcp__other__search-actors');
    });
});
