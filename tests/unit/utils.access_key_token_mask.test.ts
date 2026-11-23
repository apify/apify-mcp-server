import { describe, expect, it, vi } from 'vitest';

import log from '@apify/log';

import { maskAccessKeyTokens, maskAccessKeyTokensInLogs } from '../../src/utils/access_key_token_mask.js';

const TOKEN_SECRET = 'a1B2'.repeat(9);

describe('access tokens are masked in text', () => {
    it('masks a token', () => {
        expect(maskAccessKeyTokens(`Bearer apify_api_${TOKEN_SECRET} failed`)).toBe('Bearer [TKN] failed');
    });

    // The token types are not listed, so any `apify_<type>_<secret>` value is masked.
    it('masks a token whose type has several words', () => {
        expect(maskAccessKeyTokens(`apify_some_other_type_${TOKEN_SECRET}`)).toBe('[TKN]');
    });

    // Stack traces in log lines name files such as `src/tools/api/apify_api_request.ts`.
    it('keeps a file name that starts like a token', () => {
        const stack = 'at callApi (/app/dist/tools/api/apify_api_request.js:42:7)';
        expect(maskAccessKeyTokens(stack)).toBe(stack);
    });

    it('masks two tokens joined with no separator', () => {
        const token = `apify_api_${TOKEN_SECRET}`;
        expect(maskAccessKeyTokens(`${token}${token}`)).toBe('[TKN][TKN]');
    });

    // A cut-off token is too short to match alone; the match must not start there and run into the next prefix.
    it('masks a token that directly follows a cut-off token', () => {
        const cutOffToken = `apify_api_${'x'.repeat(15)}`;
        expect(maskAccessKeyTokens(`${cutOffToken}apify_api_${TOKEN_SECRET}`)).toBe(`${cutOffToken}[TKN]`);
    });
});

describe('access tokens are masked in log lines', () => {
    it('masks a token in the message and in the data of a line written after the call', () => {
        const token = `apify_api_${'a1B2'.repeat(9)}`;
        const lines: string[] = [];
        const spies = (['log', 'error'] as const).map((method) =>
            vi.spyOn(console, method).mockImplementation((line) => void lines.push(String(line))),
        );
        const { logger } = log.getOptions();
        const writeLine = logger._outputWithConsole;
        maskAccessKeyTokensInLogs();

        log.error(`Actor '${token}' was not found`, { actorName: token });

        logger._outputWithConsole = writeLine;
        for (const spy of spies) spy.mockRestore();
        expect(lines).toHaveLength(1);
        expect(lines[0]).not.toContain(token);
        expect(lines[0].split('[TKN]')).toHaveLength(3);
    });
});
