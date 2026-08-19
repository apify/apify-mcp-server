import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
    MAX_TOOL_NAME_LENGTH,
    MAX_TOOL_NAME_USERNAME_LENGTH,
    SERVER_ID_LENGTH,
    TOOL_NAME_HASH_LENGTH,
} from '../../src/mcp/const.js';
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
        const actorFullName = 'alizarin_refrigerator-owner/competitive-intelligence-mcp-server';

        expect(getProxyMCPServerToolName(actorFullName, 'search')).toBe(
            'alizarin--competitive-intelligence-mcp-server--search-0b0d',
        );
        expect(getProxyMCPServerToolName(actorFullName, 'analyze')).toBe(
            'alizarin--competitive-intelligence-mcp-server--analyze-3ab5',
        );
    });

    it('keeps one identical prefix across every tool of the same Actor', () => {
        const actorFullName = 'alizarin_refrigerator-owner/competitive-intelligence-mcp-server';
        const names = ['search', 'analyze', 'get-company-profile'].map((toolName) =>
            getProxyMCPServerToolName(actorFullName, toolName),
        );

        // A constant cap gives one Actor one prefix; a shrink-to-fit cap would give these three tools three.
        for (const name of names) {
            expect(name.startsWith('alizarin--competitive-intelligence-mcp-server--')).toBe(true);
            expect(name.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
        }
    });

    it('caps only the names that exceed the limit, so a straddling Actor has two prefixes', () => {
        const actorFullName = 'longusername1/my-mcp-server';

        expect(getProxyMCPServerToolName(actorFullName, 'add')).toBe('longusername1--my-mcp-server--add');
        expect(getProxyMCPServerToolName(actorFullName, 'a-tool-name-long-enough-to-push-past-the-limit-xxxx')).toBe(
            'longuser--my-mcp-server--a-tool-name-long-enough-to-push-pa-fa1b',
        );
    });

    it('truncates the tool name only when capping the username is not enough', () => {
        const uncappedFullName =
            'alizarin_refrigerator-owner--competitive-intelligence-mcp-server--get-company-profile';
        const hash = createHash('sha256').update(uncappedFullName).digest('hex').slice(0, TOOL_NAME_HASH_LENGTH);
        const name = getProxyMCPServerToolName(
            'alizarin_refrigerator-owner/competitive-intelligence-mcp-server',
            'get-company-profile',
        );

        expect(name).toBe('alizarin--competitive-intelligence-mcp-server--get-company--fd6c');
        expect(name.length).toBe(MAX_TOOL_NAME_LENGTH);
        // The hash covers the name assembled from the uncapped username, whichever tier produced the result.
        expect(name.endsWith(`-${hash}`)).toBe(true);
    });

    it('reads the username from the Actor full name, not from the first "--"', () => {
        const name = getProxyMCPServerToolName(
            'doshikevin361/commet--apify-1',
            'a-very-long-tool-name-that-forces-truncation-of-the-assembled-name',
        );

        expect(name).toBe('doshikev--commet--apify-1--a-very-long-tool-name-that-force-cbb1');
        expect(name.split('--')[0]).toBe('doshikevin361'.slice(0, MAX_TOOL_NAME_USERNAME_LENGTH));
        // Actor names legally contain '--', so this one must survive whole right after the capped username.
        expect(name.startsWith('doshikev--commet--apify-1--')).toBe(true);
    });

    it('escapes a dotted username before capping it', () => {
        expect(getProxyMCPServerToolName('jiri.spilka/competitive-intelligence-mcp-server', 'get-company')).toBe(
            'jiri-dot--competitive-intelligence-mcp-server--get-company-d373',
        );
        // Capping the raw username first would leave 'ab-dot-cdefg' — 12 chars, over the username cap.
        expect(
            getProxyMCPServerToolName('ab.cdefgh/some-actor-name-that-is-long-enough-to-push-past-the-cap', 'add'),
        ).toBe('ab-dot-c--some-actor-name-that-is-long-enough-to-push-past--4f1b');
    });

    it('trims a trailing dash off the capped username', () => {
        expect(getProxyMCPServerToolName('dev.tools-collective/competitive-intelligence-mcp-server', 'search')).toBe(
            'dev-dot--competitive-intelligence-mcp-server--search-3c76',
        );
    });

    it('truncates and hashes once for an Actor whose name alone exceeds the limit', () => {
        const name = getProxyMCPServerToolName(
            'alizarin_refrigerator-owner/government-research-mcp-server---unified-data-access',
            'search',
        );

        expect(name).toBe('alizarin--government-research-mcp-server---unified-data-acc-bd1a');
        expect(name.length).toBe(MAX_TOOL_NAME_LENGTH);
    });

    it('omits the username segment when the Actor full name has no slash', () => {
        expect(getProxyMCPServerToolName('competitive-intelligence-mcp-server', 'search')).toBe(
            'competitive-intelligence-mcp-server--search',
        );
    });

    it('skips the username cap when there is no username to cap', () => {
        const uncappedFullName = 'competitive-intelligence-mcp-server--a-very-long-tool-name-that-forces-truncation';
        const hash = createHash('sha256').update(uncappedFullName).digest('hex').slice(0, TOOL_NAME_HASH_LENGTH);
        const name = getProxyMCPServerToolName(
            'competitive-intelligence-mcp-server',
            'a-very-long-tool-name-that-forces-truncation',
        );

        // No username segment to cap, so tail truncation is the only tier left.
        expect(name).toBe('competitive-intelligence-mcp-server--a-very-long-tool-name--acb9');
        expect(name.length).toBe(MAX_TOOL_NAME_LENGTH);
        expect(name.endsWith(`-${hash}`)).toBe(true);
    });

    it('leaves the username segment empty when the capped username is all dashes', () => {
        const actorName = 'some-actor-name-that-is-long-enough-to-need-a-cap-xx';
        const name = getProxyMCPServerToolName(`--------/${actorName}`, 'toolname');

        // Same shape an empty username segment already gets: '/actor' + 'tool' -> '--actor--tool'.
        expect(name).toBe('--some-actor-name-that-is-long-enough-to-need-a-cap-xx--too-2890');
        expect(name.length).toBe(MAX_TOOL_NAME_LENGTH);
        // The hash covers the uncapped username, so a longer dash run still reads distinct.
        expect(name).not.toBe(getProxyMCPServerToolName(`----------/${actorName}`, 'toolname'));
    });
});
