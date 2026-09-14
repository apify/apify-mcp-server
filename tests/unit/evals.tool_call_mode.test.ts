import { describe, expect, it } from 'vitest';

import {
    resolveFirstToolMatch,
    TOOL_CALL_DENY_REASON,
    type AttemptedToolCall,
} from '../../evals/mcp_agent/tool_call_mode.js';

describe('TOOL_CALL_DENY_REASON', () => {
    it('keeps the spike-calibrated wording', () => {
        expect(TOOL_CALL_DENY_REASON).toBe(
            'Tool calls are disabled in this evaluation. Do not retry with a different tool or ' +
                'arguments — report to the user, in your final answer, which tool you would have ' +
                'called and with what arguments, then stop.',
        );
    });
});

describe('resolveFirstToolMatch()', () => {
    it('skips ToolSearch and matches MCP and built-in tool names', () => {
        expect(
            resolveFirstToolMatch(
                [
                    { toolName: 'ToolSearch', input: { query: 'select:search-actors' } },
                    { toolName: 'mcp__apify__search-actors', input: { keywords: 'tiktok' } },
                ],
                ['search-actors'],
            ),
        ).toEqual({
            isMatch: true,
            comment:
                'search-actors({"keywords":"tiktok"}) — matched expectedTools ' +
                '[search-actors] (1 ToolSearch capture skipped)',
        });
        expect(resolveFirstToolMatch([{ toolName: 'WebFetch', input: {} }], ['WebFetch']).isMatch).toBe(true);
    });

    it('reports a mismatched tool name', () => {
        expect(
            resolveFirstToolMatch(
                [{ toolName: 'WebFetch', input: { url: 'https://example.com' } }],
                ['apify--web-fetch'],
            ),
        ).toEqual({
            isMatch: false,
            comment: 'WebFetch({"url":"https://example.com"}) — expected one of [apify--web-fetch]',
        });
    });

    it('skips ToolSearch and reports when no measured call remains', () => {
        const attempts: AttemptedToolCall[] = [{ toolName: 'ToolSearch', input: { query: 'select:WebFetch' } }];
        expect(resolveFirstToolMatch(attempts, ['apify--web-fetch'])).toEqual({
            isMatch: false,
            comment: 'no tool call attempted (1 ToolSearch capture skipped)',
        });
    });

    it('matches the expected argument subset with deep equality', () => {
        const attempts: AttemptedToolCall[] = [
            {
                toolName: 'mcp__apify__call-actor',
                input: { actor: 'apify/rag-web-browser', input: { query: 'x' }, timeout: 30 },
            },
        ];
        expect(resolveFirstToolMatch(attempts, ['call-actor'], { input: { query: 'x' } }).isMatch).toBe(true);
    });

    it('reports the first mismatched expected argument', () => {
        const attempts: AttemptedToolCall[] = [
            { toolName: 'mcp__apify__fetch-actor-details', input: { actor: 'rag-web-browser' } },
        ];
        expect(resolveFirstToolMatch(attempts, ['fetch-actor-details'], { actor: 'apify/rag-web-browser' })).toEqual({
            isMatch: false,
            comment:
                'fetch-actor-details({"actor":"rag-web-browser"}) — tool name matched; ' +
                'arg "actor" expected "apify/rag-web-browser", got "rag-web-browser"',
        });
    });
});
