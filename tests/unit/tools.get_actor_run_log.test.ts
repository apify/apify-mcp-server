import { describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { getActorRun } from '../../src/tools/runs/get_actor_run.js';
import { getActorRunLog } from '../../src/tools/runs/get_actor_run_log.js';
import { getActorRunLogToolOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import {
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    stubToolCallContext,
    type TextToolResult,
} from './helpers/tool_context.js';

const getMock = vi.fn();
const buildLogGetMock = vi.fn();
const buildMock = vi.fn(() => ({ log: () => ({ get: buildLogGetMock }) }));

const stubClient = {
    run: () => ({ log: () => ({ get: getMock }) }),
    build: buildMock,
} as unknown as InternalToolArgs['apifyClient'];

const numberedLog = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n');

const callTool = async (args: Record<string, unknown>) =>
    (await (getActorRunLog as HelperTool).call(stubToolCallContext(args, stubClient))) as TextToolResult;

describe('get-actor-log', () => {
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
        const client = {
            run: (_id: string) => ({
                get: async () => undefined,
                log: () => ({ get: getMock }),
            }),
        } as unknown as InternalToolArgs['apifyClient'];
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

    describe('buildId', () => {
        it('returns the requested number of trailing lines of the build log', async () => {
            buildMock.mockClear();
            getMock.mockClear();
            buildLogGetMock.mockResolvedValue(`${numberedLog(20)}\n`);

            const { content } = await callTool({ buildId: 'build-1', lines: 3 });

            expect(buildMock).toHaveBeenCalledWith('build-1');
            expect(getMock).not.toHaveBeenCalled();
            expect(content[0].text.split('\n')).toEqual(['line 18', 'line 19', 'line 20']);
        });

        it('returns the default 10 lines of the build log when lines is omitted', async () => {
            buildLogGetMock.mockResolvedValue(numberedLog(50));

            const { content } = await callTool({ buildId: 'build-1' });

            expect(content[0].text.split('\n')).toHaveLength(10);
        });

        it('returns the entire build log when lines is 0', async () => {
            buildLogGetMock.mockResolvedValue(numberedLog(50));

            const { content } = await callTool({ buildId: 'build-1', lines: 0 });
            const returned = content[0].text.split('\n');

            expect(returned).toHaveLength(50);
            expect(returned[0]).toBe('line 1');
            expect(returned[49]).toBe('line 50');
        });

        it('mirrors the build log in structuredContent that conforms to the outputSchema', async () => {
            buildLogGetMock.mockResolvedValue(numberedLog(20));

            const result = await callTool({ buildId: 'build-1', lines: 5 });

            expect(result.structuredContent).toEqual({ log: result.content[0].text });
            expectSchemaConformingStructuredContent(result, getActorRunLogToolOutputSchema);
        });

        it('returns a not-found error when the build does not exist', async () => {
            buildLogGetMock.mockResolvedValue(undefined);

            const result = await (getActorRunLog as HelperTool).call(
                stubToolCallContext({ buildId: 'missing-build', lines: 10 }, stubClient),
            );
            const { content, structuredContent } = result as TextToolResult & { structuredContent?: unknown };

            expectSoftFailInvalidInput(result);
            expect(content[0].text).toBe("Build with ID 'missing-build' not found.");
            expect(structuredContent).toBeUndefined();
        });
    });

    describe('runId / buildId exclusivity', () => {
        it('rejects a call with both runId and buildId without fetching a log', async () => {
            getMock.mockClear();
            buildMock.mockClear();

            const result = await (getActorRunLog as HelperTool).call(
                stubToolCallContext({ runId: 'run-1', buildId: 'build-1' }, stubClient),
            );
            const { content, structuredContent } = result as TextToolResult & { structuredContent?: unknown };

            expectSoftFailInvalidInput(result);
            expect(content[0].text).toBe('Provide exactly one of runId or buildId.');
            expect(structuredContent).toBeUndefined();
            expect(getMock).not.toHaveBeenCalled();
            expect(buildMock).not.toHaveBeenCalled();
        });

        it('rejects a call with neither runId nor buildId', async () => {
            const result = await (getActorRunLog as HelperTool).call(stubToolCallContext({ lines: 10 }, stubClient));
            const { content } = result as TextToolResult;

            expectSoftFailInvalidInput(result);
            expect(content[0].text).toBe('Provide exactly one of runId or buildId.');
        });

        it('accepts either id alone and still caps lines at 50 via ajv validation', () => {
            const tool = getActorRunLog as HelperTool;
            expect(tool.ajvValidate({ runId: 'run-1' })).toBe(true);
            expect(tool.ajvValidate({ buildId: 'build-1' })).toBe(true);
            expect(tool.ajvValidate({ buildId: 'build-1', lines: 51 })).toBe(false);
        });

        it('rejects an empty buildId via ajv validation', () => {
            expect((getActorRunLog as HelperTool).ajvValidate({ buildId: '' })).toBe(false);
        });
    });
});
