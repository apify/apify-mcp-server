import { describe, expect, it, vi } from 'vitest';

import log from '@apify/log';

import { redactApifyTokens, redactApifyTokensInLogs } from '../../src/utils/apify_token_redaction.js';

describe('Apify tokens are redacted from text', () => {
    it('replaces a token', () => {
        expect(redactApifyTokens(`Bearer apify_api_${'a1B2'.repeat(9)} failed`)).toBe('Bearer apify_api_*** failed');
    });

    // The Apify API accepts each of these as the Apify token, so a client can send any of them.
    it('replaces a token of every other type the Apify API accepts', () => {
        const prefixes = [
            'apify_ui_',
            'apify_actor_run_api_',
            'apify_webhook_dispatch_',
            'apify_adhoc_api_',
            'integration_api_token_',
        ];
        const text = prefixes.map((prefix) => `${prefix}${'a1B2'.repeat(9)}`).join(' ');
        expect(redactApifyTokens(text)).toBe(prefixes.map((prefix) => `${prefix}***`).join(' '));
    });

    // Stack traces in log lines name files such as `src/tools/api/apify_api_request.ts`.
    it('keeps a file name that starts like a token', () => {
        const stack = 'at callApi (/app/dist/tools/api/apify_api_request.js:42:7)';
        expect(redactApifyTokens(stack)).toBe(stack);
    });

    // A greedy match would take the `apify` of the second token and leave its secret part in the text.
    it('replaces two tokens joined with no separator', () => {
        const token = `apify_api_${'a1B2'.repeat(9)}`;
        expect(redactApifyTokens(`${token}${token}`)).toBe('apify_api_***apify_api_***');
    });

    // A cut-off token is too short to match alone; the match must not start there and run into the next prefix.
    it('replaces a token that directly follows a cut-off token', () => {
        const cutOffToken = `apify_api_${'x'.repeat(15)}`;
        expect(redactApifyTokens(`${cutOffToken}apify_api_${'a1B2'.repeat(9)}`)).toBe(`${cutOffToken}apify_api_***`);
    });

    // Log lines and telemetry carry caller input of any length; the redaction must not throw on it.
    it('replaces a token followed by a multi-megabyte run of alphanumerics', () => {
        expect(redactApifyTokens(`apify_api_${'a'.repeat(10_000_000)} end`)).toBe('apify_api_*** end');
    });
});

describe('Apify tokens are redacted from log lines', () => {
    it('replaces a token in the message and in the data of a line written after the call', () => {
        const token = `apify_api_${'a1B2'.repeat(9)}`;
        const lines: string[] = [];
        const spies = (['log', 'error'] as const).map((method) =>
            vi.spyOn(console, method).mockImplementation((line) => void lines.push(String(line))),
        );
        const { logger } = log.getOptions();
        const writeLine = logger._outputWithConsole;
        redactApifyTokensInLogs();

        log.error(`Actor '${token}' was not found`, { actorName: token });

        logger._outputWithConsole = writeLine;
        for (const spy of spies) spy.mockRestore();
        expect(lines).toHaveLength(1);
        expect(lines[0]).not.toContain(token);
        expect(lines[0].split('apify_api_***')).toHaveLength(3);
    });
});
