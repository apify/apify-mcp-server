import { describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { REDACTED } from '../../src/resources/api_resources.js';
import { getActorRun } from '../../src/tools/runs/get_actor_run.js';
import {
    buildLogTail,
    getActorRunLog,
    redactLogSecrets,
    RUN_LOG_TAIL_LINES,
    RUN_LOG_TAIL_MAX_CHARS,
} from '../../src/tools/runs/get_actor_run_log.js';
import { getActorRunLogToolOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool } from '../../src/types.js';
import {
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    mockApifyClient,
    stubToolCallContext,
    type TextToolResult,
} from './helpers/tool_context.js';

const getMock = vi.fn();

const stubClient = mockApifyClient({ run: () => ({ log: () => ({ get: getMock }) }) });

const numberedLog = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n');

const callTool = async (args: Record<string, unknown>) =>
    (await (getActorRunLog as HelperTool).call(stubToolCallContext(args, stubClient))) as TextToolResult;

describe('get-actor-run-log', () => {
    it('has the expected tool name', () => {
        expect(getActorRunLog.name).toBe(HELPER_TOOLS.ACTOR_RUNS_LOG);
    });

    it('returns exactly the requested number of trailing lines', async () => {
        getMock.mockResolvedValue(numberedLog(20));

        const { content } = await callTool({ runId: 'run-1', lines: 10 });
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
        getMock.mockResolvedValue(numberedLog(20));

        const { content } = await callTool({ runId: 'run-1', lines: 1 });

        expect(content[0].text).toBe('line 20');
    });

    it('returns exactly the default 10 lines when lines is omitted', async () => {
        getMock.mockResolvedValue(numberedLog(50));

        const { content } = await callTool({ runId: 'run-1' });

        expect(content[0].text.split('\n')).toHaveLength(10);
    });

    it('returns only content lines when the log ends with a newline', async () => {
        getMock.mockResolvedValue(`${numberedLog(20)}\n`);

        const { content } = await callTool({ runId: 'run-1', lines: 3 });
        const returned = content[0].text.split('\n');

        expect(returned).toEqual(['line 18', 'line 19', 'line 20']);
    });

    it('returns the last content line when one line is requested and the log ends with a newline', async () => {
        getMock.mockResolvedValue(`${numberedLog(20)}\n`);

        const { content } = await callTool({ runId: 'run-1', lines: 1 });

        expect(content[0].text).toBe('line 20');
    });

    it('keeps a trailing blank line that is followed by nothing but one newline', async () => {
        getMock.mockResolvedValue(`${numberedLog(3)}\n\n`);

        const { content } = await callTool({ runId: 'run-1', lines: 2 });

        expect(content[0].text.split('\n')).toEqual(['line 3', '']);
    });

    it('returns the whole log when it is shorter than the requested number of lines', async () => {
        getMock.mockResolvedValue(numberedLog(3));

        const { content } = await callTool({ runId: 'run-1', lines: 10 });

        expect(content[0].text).toBe('line 1\nline 2\nline 3');
    });

    it('mirrors the log text in structuredContent and declares an outputSchema', async () => {
        getMock.mockResolvedValue(numberedLog(20));

        const result = await callTool({ runId: 'run-1', lines: 10 });

        expect(result.structuredContent).toEqual({ log: result.content[0].text });
        expect((getActorRunLog as HelperTool).outputSchema).toBe(getActorRunLogToolOutputSchema);
        expectSchemaConformingStructuredContent(result, getActorRunLogToolOutputSchema);
    });

    it('returns conforming structuredContent for an empty log', async () => {
        getMock.mockResolvedValue('');

        const result = await callTool({ runId: 'run-1', lines: 10 });

        expect(result.content[0].text).toBe('');
        expect(result.structuredContent).toEqual({ log: '' });
        expectSchemaConformingStructuredContent(result, getActorRunLogToolOutputSchema);
    });

    it('returns a not-found error when the run does not exist', async () => {
        getMock.mockResolvedValue(undefined);

        const result = await (getActorRunLog as HelperTool).call(
            stubToolCallContext({ runId: 'run-1', lines: 10 }, stubClient),
        );
        const { content, structuredContent } = result as TextToolResult & { structuredContent?: unknown };

        expectSoftFailInvalidInput(result);
        expect(content[0].text).toBe("Run with ID 'run-1' not found.");
        expect(structuredContent).toBeUndefined();
    });

    it('returns the same not-found error text as get-actor-run for the same missing run', async () => {
        const client = mockApifyClient({
            run: (_id: string) => ({
                get: async () => undefined,
                log: () => ({ get: getMock }),
            }),
        });
        getMock.mockResolvedValue(undefined);

        const logResult = (await (getActorRunLog as HelperTool).call(
            stubToolCallContext({ runId: 'missing-run', lines: 10 }, client),
        )) as TextToolResult;
        const runResult = (await (getActorRun as HelperTool).call(
            stubToolCallContext({ runId: 'missing-run', waitSecs: 0 }, client),
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
    ])('hides %s', (_name, line, secret) => {
        const redacted = redactLogSecrets(line, 's3ss10nT0ken');

        expect(redacted).not.toContain(secret);
        expect(redacted).toContain(REDACTED);
    });

    it('leaves the text unchanged when the session token is empty', () => {
        expect(redactLogSecrets('Run started', '')).toBe('Run started');
    });

    it('keeps the proxy host and user so the line stays useful', () => {
        const redacted = redactLogSecrets(
            'http://groups-RESIDENTIAL:apify_proxy_Xk29fLq@proxy.apify.com:8000',
            undefined,
        );

        expect(redacted).toBe(`http://groups-RESIDENTIAL:${REDACTED}@proxy.apify.com:8000`);
    });
});

describe('the log tail keeps the end of the log within its limits', () => {
    it('keeps only the last lines of the log', () => {
        const tail = buildLogTail(`${numberedLog(RUN_LOG_TAIL_LINES + 5)}\n`, undefined);

        expect(tail.split('\n')).toEqual(
            numberedLog(RUN_LOG_TAIL_LINES + 5)
                .split('\n')
                .slice(-RUN_LOG_TAIL_LINES),
        );
    });

    it('drops the carriage return of Windows line endings', () => {
        const tail = buildLogTail('line 1\r\nline 2\r\n', undefined);

        expect(tail).toBe('line 1\nline 2');
    });

    it('drops whole leading lines while the tail is over the character limit', () => {
        const longLine = 'x'.repeat(RUN_LOG_TAIL_MAX_CHARS - 10);
        const tail = buildLogTail(`${longLine}\nApifyApiError: Insufficient permissions\n  statusCode: 403`, undefined);

        expect(tail).toBe('ApifyApiError: Insufficient permissions\n  statusCode: 403');
    });

    it('keeps the end of a last line that is longer than the character limit', () => {
        const tail = buildLogTail(`first line\n${'y'.repeat(RUN_LOG_TAIL_MAX_CHARS * 2)}`, undefined);

        expect(tail).toBe('y'.repeat(RUN_LOG_TAIL_MAX_CHARS));
    });

    it('redacts a token before the cut, so no part of it is kept', () => {
        // The cut falls inside the token: without redaction first, a fragment that no pattern matches would remain.
        const token = 'apify_api_AbC123xYz789';
        const line = `${'z'.repeat(RUN_LOG_TAIL_MAX_CHARS)}${token}${'z'.repeat(RUN_LOG_TAIL_MAX_CHARS - 10)}`;

        const tail = buildLogTail(line, undefined);

        expect(tail).toHaveLength(RUN_LOG_TAIL_MAX_CHARS);
        expect(tail).not.toContain('xYz789');
        expect(tail).toContain(REDACTED);
    });
});
