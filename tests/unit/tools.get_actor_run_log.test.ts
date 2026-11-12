import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HELPER_TOOLS, MAX_INLINE_BYTES } from '../../src/const.js';
import { getActorRun } from '../../src/tools/runs/get_actor_run.js';
import { getActorRunLog } from '../../src/tools/runs/get_actor_run_log.js';
import { getActorRunLogToolOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool } from '../../src/types.js';
import { type LogServer, startLogServer } from './helpers/log_server.js';
import {
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    stubToolCallContext,
    type TextToolResult,
} from './helpers/tool_context.js';

let logServer: LogServer;

beforeAll(async () => {
    logServer = await startLogServer();
});

afterAll(async () => {
    await logServer.close();
});

const numberedLog = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n');

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
