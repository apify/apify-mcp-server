import { afterAll, describe, expect, it } from 'vitest';

import { HELPER_TOOLS, MAX_INLINE_BYTES } from '../../src/const.js';
import { REDACTION_PLACEHOLDER, redactLogSecrets } from '../../src/resources/api_resources.js';
import { getActorRun } from '../../src/tools/runs/get_actor_run.js';
import {
    buildLogTail,
    getActorRunLog,
    RUN_LOG_TAIL_LINES,
    RUN_LOG_TAIL_MAX_CHARS,
} from '../../src/tools/runs/get_actor_run_log.js';
import { getActorRunLogToolOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool } from '../../src/types.js';
import type { LogTail } from '../../src/utils/log_tail.js';
import { numberedLog, startLogServer } from './helpers/log_server.js';
import {
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    stubToolCallContext,
    type TextToolResult,
} from './helpers/tool_context.js';

const logServer = await startLogServer();

afterAll(async () => logServer.close());

/** Calls the tool on a run whose log is `log`. */
const callTool = async (log: string, args: Record<string, unknown> = {}) =>
    (await (getActorRunLog as HelperTool).call(
        stubToolCallContext({ runId: logServer.serveLog(log), ...args }, logServer.client),
    )) as TextToolResult;

describe('get-actor-run-log', () => {
    it('has the expected tool name', () => {
        expect(getActorRunLog.name).toBe(HELPER_TOOLS.ACTOR_RUNS_LOG);
    });

    it('returns exactly the requested number of trailing lines', async () => {
        const { content } = await callTool(numberedLog(20), { lines: 10 });
        const returned = content[0].text.split('\n');

        expect(returned).toHaveLength(10);
        expect(returned).toEqual([
            'line 11',
            'line 12',
            'line 13',
            'line 14',
            'line 15',
            'line 16',
            'line 17',
            'line 18',
            'line 19',
            'line 20',
        ]);
    });

    it('returns a single line when one line is requested', async () => {
        const { content } = await callTool(numberedLog(20), { lines: 1 });

        expect(content[0].text).toBe('line 20');
    });

    it('returns exactly the default 10 lines when lines is omitted', async () => {
        const { content } = await callTool(numberedLog(50));

        expect(content[0].text.split('\n')).toHaveLength(10);
    });

    it('returns only content lines when the log ends with a newline', async () => {
        const { content } = await callTool(`${numberedLog(20)}\n`, { lines: 3 });
        const returned = content[0].text.split('\n');

        expect(returned).toEqual(['line 18', 'line 19', 'line 20']);
    });

    it('returns the last content line when one line is requested and the log ends with a newline', async () => {
        const { content } = await callTool(`${numberedLog(20)}\n`, { lines: 1 });

        expect(content[0].text).toBe('line 20');
    });

    it('keeps a trailing blank line that is followed by nothing but one newline', async () => {
        const { content } = await callTool(`${numberedLog(3)}\n\n`, { lines: 2 });

        expect(content[0].text.split('\n')).toEqual(['line 3', '']);
    });

    it('returns the whole log when it is shorter than the requested number of lines', async () => {
        const { content } = await callTool(numberedLog(3), { lines: 10 });

        expect(content[0].text).toBe('line 1\nline 2\nline 3');
    });

    describe('log over the inline limit', () => {
        // 'line 1' … 'line N' with N = MAX_INLINE_BYTES / 10 run past MAX_INLINE_BYTES.
        const longLog = numberedLog(MAX_INLINE_BYTES / 10);

        it('returns the full lines of the last MAX_INLINE_BYTES and says the start is cut when lines is 0', async () => {
            const result = await callTool(longLog, { lines: 0 });
            const returned = result.content[0].text.split('\n');

            expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(MAX_INLINE_BYTES);
            expect(returned).toEqual(longLog.split('\n').slice(-returned.length));
            expect(result.content[1].text).toContain(`${MAX_INLINE_BYTES} bytes`);
            expect(result.structuredContent).toEqual({ log: result.content[0].text });
        });

        it('returns the requested trailing lines without a note when they fit', async () => {
            const { content } = await callTool(longLog, { lines: 2 });

            expect(content).toHaveLength(1);
            expect(content[0].text).toBe(longLog.split('\n').slice(-2).join('\n'));
        });
    });

    it('mirrors the log text in structuredContent and declares an outputSchema', async () => {
        const result = await callTool(numberedLog(20), { lines: 10 });

        expect(result.structuredContent).toEqual({ log: result.content[0].text });
        expect((getActorRunLog as HelperTool).outputSchema).toBe(getActorRunLogToolOutputSchema);
        expectSchemaConformingStructuredContent(result, getActorRunLogToolOutputSchema);
    });

    it('returns conforming structuredContent for an empty log', async () => {
        const result = await callTool('', { lines: 10 });

        expect(result.content[0].text).toBe('');
        expect(result.structuredContent).toEqual({ log: '' });
        expectSchemaConformingStructuredContent(result, getActorRunLogToolOutputSchema);
    });

    it('returns a not-found error when the run does not exist', async () => {
        const result = await (getActorRunLog as HelperTool).call(
            stubToolCallContext({ runId: 'missing-run', lines: 10 }, logServer.client),
        );
        const { content, structuredContent } = result as TextToolResult & { structuredContent?: unknown };

        expectSoftFailInvalidInput(result);
        expect(content[0].text).toBe("Run with ID 'missing-run' not found.");
        expect(structuredContent).toBeUndefined();
    });

    it('throws the API error of a failed log request', async () => {
        const runId = logServer.serveResponses([
            {
                status: 500,
                contentType: 'application/json',
                body: JSON.stringify({ error: { type: 'internal-error', message: 'Log storage unavailable' } }),
            },
        ]);

        await expect(
            (getActorRunLog as HelperTool).call(stubToolCallContext({ runId }, logServer.client)),
        ).rejects.toMatchObject({ statusCode: 500, type: 'internal-error', message: 'Log storage unavailable' });
    });

    it('accepts only whole line counts from 0 to 50', () => {
        const tool = getActorRunLog as HelperTool;
        expect(tool.ajvValidate({ runId: 'run-1', lines: 0 })).toBe(true);
        expect(tool.ajvValidate({ runId: 'run-1', lines: 50 })).toBe(true);
        expect(tool.ajvValidate({ runId: 'run-1', lines: -1 })).toBe(false);
        expect(tool.ajvValidate({ runId: 'run-1', lines: 1.5 })).toBe(false);
    });

    it('returns the same not-found error text as get-actor-run for the same missing run', async () => {
        const logResult = (await (getActorRunLog as HelperTool).call(
            stubToolCallContext({ runId: 'missing-run', lines: 10 }, logServer.client),
        )) as TextToolResult;
        const runResult = (await (getActorRun as HelperTool).call(
            stubToolCallContext({ runId: 'missing-run', waitSecs: 0 }, logServer.client),
        )) as TextToolResult;

        expect(logResult.isError).toBe(true);
        expect(runResult.isError).toBe(true);
        expect(logResult.content[0].text).toBe(runResult.content[0].text);
    });
});

describe('secrets in a run log are redacted', () => {
    it.each([
        ['the session token', 'Using token s3ss10nT0ken for the request', 's3ss10nT0ken'],
        ['an Apify API token', 'APIFY_TOKEN=apify_api_AbC123xYz789 loaded', 'apify_api_AbC123xYz789'],
        [
            'an Apify Proxy password',
            'Proxy: http://groups-RESIDENTIAL:apify_proxy_Xk29fLq@proxy.apify.com:8000',
            'apify_proxy_Xk29fLq',
        ],
        ['a proxy password with no user', 'Proxy: http://:Xk29fLqPass@proxy.apify.com:8000', 'Xk29fLqPass'],
        ['a URL password with no user', 'Connecting to redis://:pw0rdSecret@cache:6379', 'pw0rdSecret'],
        ['a URL password that holds an @', 'Proxy: http://auto:p@ssw0rd@proxy.apify.com:8000', 'ssw0rd'],
        ['the proxy password in an env line', 'APIFY_PROXY_PASSWORD=SECRETPW123', 'SECRETPW123'],
        ['the proxy password in a printed env object', "  APIFY_PROXY_PASSWORD: 'SECRETPW123',", 'SECRETPW123'],
        ['a password in JSON', 'Config: {"proxy":{"password":"SECRETPW123"}}', 'SECRETPW123'],
        [
            'a password in a printed object',
            "ProxyConfiguration { groups: [], password: 'SECRETPW123', hostname: 'proxy.apify.com' }",
            'SECRETPW123',
        ],
        ['a printed password that holds a single quote', `{ password: "it's-SECRETPW123" }`, 'SECRETPW123'],
        ['a printed password that holds both quote types', '{ password: `it\'s "SECRETPW123"` }', 'SECRETPW123'],
    ])('hides %s', (_name, line, secret) => {
        const redacted = redactLogSecrets(line, 's3ss10nT0ken');

        expect(redacted).not.toContain(secret);
        expect(redacted).toContain(REDACTION_PLACEHOLDER);
    });

    it.each([
        ['an empty proxy password env var', 'APIFY_PROXY_PASSWORD:\n  Error: boom'],
        ['an unclosed JSON password', '{"password":"abc\n  ApifyApiError: Insufficient permissions'],
    ])('keeps the next line intact after %s', (_name, text) => {
        const [, nextLine] = text.split('\n');

        expect(redactLogSecrets(text, undefined).split('\n')[1]).toBe(nextLine);
    });

    it('leaves a password prompt in prose unchanged', () => {
        expect(redactLogSecrets('Enter password: hunter2', undefined)).toBe('Enter password: hunter2');
    });

    it('leaves the text unchanged when the session token is empty', () => {
        expect(redactLogSecrets('Run started', '')).toBe('Run started');
    });

    it('keeps the proxy host and user so the line stays useful', () => {
        const redacted = redactLogSecrets(
            'http://groups-RESIDENTIAL:apify_proxy_Xk29fLq@proxy.apify.com:8000',
            undefined,
        );

        expect(redacted).toBe(`http://groups-RESIDENTIAL:${REDACTION_PLACEHOLDER}@proxy.apify.com:8000`);
    });
});

describe('the log tail keeps the end of the log within its limits', () => {
    /** A log tail as `readLogTail` returns it for a log that was not cut. */
    const wholeLog = (text: string): LogTail => ({ text, isTruncated: false, startsMidLine: false });

    it('keeps only the last lines of the log', () => {
        const tail = buildLogTail(wholeLog(`${numberedLog(RUN_LOG_TAIL_LINES + 5)}\n`), undefined);

        expect(tail.split('\n')).toEqual(
            numberedLog(RUN_LOG_TAIL_LINES + 5)
                .split('\n')
                .slice(-RUN_LOG_TAIL_LINES),
        );
    });

    it('drops whole leading lines while the tail is over the character limit', () => {
        const longLine = 'x'.repeat(RUN_LOG_TAIL_MAX_CHARS - 10);
        const tail = buildLogTail(
            wholeLog(`${longLine}\nApifyApiError: Insufficient permissions\n  statusCode: 403`),
            undefined,
        );

        expect(tail).toBe('ApifyApiError: Insufficient permissions\n  statusCode: 403');
    });

    it('keeps the end of a last line that is longer than the character limit', () => {
        const tail = buildLogTail(wholeLog(`first line\n${'y'.repeat(RUN_LOG_TAIL_MAX_CHARS * 2)}`), undefined);

        expect(tail).toBe('y'.repeat(RUN_LOG_TAIL_MAX_CHARS));
    });

    it('redacts a token before the cut, so no part of it is kept', () => {
        // The cut falls inside the token: without redaction first, a fragment that no pattern matches would remain.
        const token = 'apify_api_AbC123xYz789';
        const line = `${'z'.repeat(RUN_LOG_TAIL_MAX_CHARS)}${token}${'z'.repeat(RUN_LOG_TAIL_MAX_CHARS - 10)}`;

        const tail = buildLogTail(wholeLog(line), undefined);

        expect(tail).toHaveLength(RUN_LOG_TAIL_MAX_CHARS);
        expect(tail).not.toContain('xYz789');
        expect(tail).toContain(REDACTION_PLACEHOLDER);
    });
});
