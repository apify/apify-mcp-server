import { describe, expect, it } from 'vitest';

import {
    resolveFirstToolMatch,
    resolveMeasuredCall,
    SELECTION_DENY_REASON,
    SELECTION_MAX_TURNS,
    TOOL_SEARCH_TOOL_NAME,
    type AttemptedToolCall,
} from '../../evals/mcp_agent/selection_mode.js';

describe('SELECTION_DENY_REASON', () => {
    it('is the spike-calibrated clean-stop wording, verbatim', () => {
        expect(SELECTION_DENY_REASON).toBe(
            'Tool calls are disabled in this evaluation. Do not retry with a different tool or ' +
                'arguments — report to the user, in your final answer, which tool you would have ' +
                'called and with what arguments, then stop.',
        );
    });
});

describe('constants', () => {
    it('fixes the selection turn budget at 2', () => {
        expect(SELECTION_MAX_TURNS).toBe(2);
    });

    it('names the ToolSearch built-in', () => {
        expect(TOOL_SEARCH_TOOL_NAME).toBe('ToolSearch');
    });
});

describe('resolveMeasuredCall()', () => {
    it('takes the only attempt when there is no ToolSearch capture', () => {
        const attempts: AttemptedToolCall[] = [{ toolName: 'mcp__apify__search-actors', input: { keywords: 'x' } }];
        expect(resolveMeasuredCall(attempts)).toEqual({ measured: attempts[0], skippedCount: 0 });
    });

    it('skips a leading ToolSearch capture and measures the next attempt', () => {
        const attempts: AttemptedToolCall[] = [
            { toolName: 'ToolSearch', input: { query: 'select:WebFetch', max_results: 5 } },
            { toolName: 'mcp__apify__apify--web-fetch', input: { url: 'https://example.com' } },
        ];
        expect(resolveMeasuredCall(attempts)).toEqual({ measured: attempts[1], skippedCount: 1 });
    });

    it('reports no measured call and the skip count when only ToolSearch was captured', () => {
        const attempts: AttemptedToolCall[] = [{ toolName: 'ToolSearch', input: { query: 'select:WebFetch' } }];
        expect(resolveMeasuredCall(attempts)).toEqual({ measured: undefined, skippedCount: 1 });
    });

    it('reports no measured call and zero skips with no attempts at all', () => {
        expect(resolveMeasuredCall([])).toEqual({ measured: undefined, skippedCount: 0 });
    });
});

describe('resolveFirstToolMatch()', () => {
    it('matches on name membership, stripping the mcp__apify__ prefix', () => {
        const attempts: AttemptedToolCall[] = [
            { toolName: 'mcp__apify__search-actors', input: { keywords: 'tiktok' } },
        ];
        const result = resolveFirstToolMatch(attempts, ['search-actors']);
        expect(result).toEqual({
            isMatch: true,
            comment: 'search-actors({"keywords":"tiktok"}) — matched expectedTools [search-actors]',
        });
    });

    it('compares a built-in tool name verbatim, with no prefix to strip', () => {
        const attempts: AttemptedToolCall[] = [{ toolName: 'WebFetch', input: { url: 'https://example.com' } }];
        const result = resolveFirstToolMatch(attempts, ['WebFetch']);
        expect(result.isMatch).toBe(true);
    });

    it('fails on a tool name not in expectedTools, naming the expected set', () => {
        const attempts: AttemptedToolCall[] = [{ toolName: 'WebFetch', input: { url: 'https://example.com' } }];
        const result = resolveFirstToolMatch(attempts, ['apify--web-fetch']);
        expect(result).toEqual({
            isMatch: false,
            comment: 'WebFetch({"url":"https://example.com"}) — expected one of [apify--web-fetch]',
        });
    });

    it('fails when no non-ToolSearch call was attempted at all', () => {
        const result = resolveFirstToolMatch([], ['search-actors']);
        expect(result).toEqual({ isMatch: false, comment: 'no tool call attempted' });
    });

    it('fails with the skip count noted when the agent stopped after a denied ToolSearch', () => {
        const attempts: AttemptedToolCall[] = [{ toolName: 'ToolSearch', input: { query: 'select:WebFetch' } }];
        const result = resolveFirstToolMatch(attempts, ['apify--web-fetch']);
        expect(result).toEqual({ isMatch: false, comment: 'no tool call attempted (1 ToolSearch capture skipped)' });
    });

    it('skips a ToolSearch capture and scores the next attempt, noting the skip in the comment', () => {
        const attempts: AttemptedToolCall[] = [
            { toolName: 'ToolSearch', input: { query: 'select:WebFetch', max_results: 5 } },
            { toolName: 'mcp__apify__apify--web-fetch', input: { url: 'https://example.com' } },
        ];
        const result = resolveFirstToolMatch(attempts, ['apify--web-fetch']);
        expect(result).toEqual({
            isMatch: true,
            comment:
                'apify--web-fetch({"url":"https://example.com"}) — matched expectedTools ' +
                '[apify--web-fetch] (1 ToolSearch capture skipped)',
        });
    });

    it('passes with no expectedArgs: a name-only check', () => {
        const attempts: AttemptedToolCall[] = [
            { toolName: 'mcp__apify__fetch-actor-details', input: { actor: 'apify/rag-web-browser' } },
        ];
        expect(resolveFirstToolMatch(attempts, ['fetch-actor-details']).isMatch).toBe(true);
    });

    it('passes expectedArgs when every listed key deep-equals, ignoring unlisted keys', () => {
        const attempts: AttemptedToolCall[] = [
            {
                toolName: 'mcp__apify__fetch-actor-details',
                input: { actor: 'apify/rag-web-browser', output: { inputSchema: true } },
            },
        ];
        const result = resolveFirstToolMatch(attempts, ['fetch-actor-details'], { actor: 'apify/rag-web-browser' });
        expect(result).toEqual({
            isMatch: true,
            comment:
                'fetch-actor-details({"actor":"apify/rag-web-browser","output":{"inputSchema":true}}) ' +
                '— matched expectedTools [fetch-actor-details]',
        });
    });

    it('does deep equality on nested expectedArgs values', () => {
        const attempts: AttemptedToolCall[] = [
            { toolName: 'mcp__apify__call-actor', input: { actor: 'apify/rag-web-browser', input: { query: 'x' } } },
        ];
        const result = resolveFirstToolMatch(attempts, ['call-actor'], { input: { query: 'x' } });
        expect(result.isMatch).toBe(true);
    });

    it('fails on a mismatched expectedArgs key, naming expected vs. got', () => {
        const attempts: AttemptedToolCall[] = [
            { toolName: 'mcp__apify__fetch-actor-details', input: { actor: 'rag-web-browser' } },
        ];
        const result = resolveFirstToolMatch(attempts, ['fetch-actor-details'], { actor: 'apify/rag-web-browser' });
        expect(result).toEqual({
            isMatch: false,
            comment:
                'fetch-actor-details({"actor":"rag-web-browser"}) — tool name matched; ' +
                'arg "actor" expected "apify/rag-web-browser", got "rag-web-browser"',
        });
    });
});
