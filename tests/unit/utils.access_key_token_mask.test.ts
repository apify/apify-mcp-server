import { describe, expect, it, vi } from 'vitest';

import log from '@apify/log';

import { maskAccessKeyTokens, maskAccessKeyTokensInLogs } from '../../src/utils/access_key_token_mask.js';

const TOKEN_SECRET = 'a1B2'.repeat(9);

describe('access tokens are masked in text', () => {
    it('masks a token', () => {
        expect(maskAccessKeyTokens(`Bearer apify_api_${TOKEN_SECRET} failed`)).toBe('Bearer [TKN] failed');
    });

    // The same list as `ACCESS_KEY_TYPE_TOKEN_PREFIXES` in apify-core: API tokens of every type and proxy passwords.
    it('masks a token of every other type the platform issues', () => {
        const prefixes = [
            'apify_proxy',
            'apify_ui',
            'apify_actor_run_api',
            'apify_actor_run_proxy',
            'integration_api_token',
            'apify_webhook_dispatch',
            'apify_adhoc_api',
        ];
        const text = prefixes.map((prefix) => `${prefix}_${TOKEN_SECRET}`).join(' ');
        expect(maskAccessKeyTokens(text)).toBe(prefixes.map(() => '[TKN]').join(' '));
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
