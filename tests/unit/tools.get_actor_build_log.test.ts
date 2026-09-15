import { describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { getActorBuild } from '../../src/tools/deploy/get_actor_build.js';
import { getActorBuildLog } from '../../src/tools/deploy/get_actor_build_log.js';
import { getActorBuildLogToolOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import {
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    stubToolCallContext,
    type TextToolResult,
} from './helpers/tool_context.js';

const getMock = vi.fn();
const buildMock = vi.fn(() => ({ log: () => ({ get: getMock }) }));

const stubClient = { build: buildMock } as unknown as InternalToolArgs['apifyClient'];

const numberedLog = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n');

const callTool = async (args: Record<string, unknown>) =>
    (await (getActorBuildLog as HelperTool).call(stubToolCallContext(args, stubClient))) as TextToolResult;

describe('get-actor-build-log', () => {
    it('has the expected tool name', () => {
        expect(getActorBuildLog.name).toBe(HELPER_TOOLS.ACTOR_BUILD_LOG);
    });

    it('returns exactly the requested number of trailing lines', async () => {
        getMock.mockResolvedValue(numberedLog(20));

        const { content } = await callTool({ buildId: 'build-1', lines: 3 });

        expect(buildMock).toHaveBeenCalledWith('build-1');
        expect(content[0].text.split('\n')).toEqual(['line 18', 'line 19', 'line 20']);
    });

    it('returns a single line when one line is requested', async () => {
        getMock.mockResolvedValue(numberedLog(20));

        const { content } = await callTool({ buildId: 'build-1', lines: 1 });

        expect(content[0].text).toBe('line 20');
    });

    it('returns exactly the default 10 lines when lines is omitted', async () => {
        getMock.mockResolvedValue(numberedLog(50));

        const { content } = await callTool({ buildId: 'build-1' });

        expect(content[0].text.split('\n')).toHaveLength(10);
    });

    it('returns the entire log when lines is 0', async () => {
        getMock.mockResolvedValue(numberedLog(50));

        const { content } = await callTool({ buildId: 'build-1', lines: 0 });
        const returned = content[0].text.split('\n');

        expect(returned).toHaveLength(50);
        expect(returned[0]).toBe('line 1');
        expect(returned[49]).toBe('line 50');
    });

    it('returns only content lines when the log ends with a newline', async () => {
        getMock.mockResolvedValue(`${numberedLog(20)}\n`);

        const { content } = await callTool({ buildId: 'build-1', lines: 3 });

        expect(content[0].text.split('\n')).toEqual(['line 18', 'line 19', 'line 20']);
    });

    it('returns the whole log when it is shorter than the requested number of lines', async () => {
        getMock.mockResolvedValue(numberedLog(3));

        const { content } = await callTool({ buildId: 'build-1', lines: 10 });

        expect(content[0].text).toBe('line 1\nline 2\nline 3');
    });

    it('mirrors the log text in structuredContent and declares an outputSchema', async () => {
        getMock.mockResolvedValue(numberedLog(20));

        const result = await callTool({ buildId: 'build-1', lines: 10 });

        expect(result.structuredContent).toEqual({ log: result.content[0].text });
        expect((getActorBuildLog as HelperTool).outputSchema).toBe(getActorBuildLogToolOutputSchema);
        expectSchemaConformingStructuredContent(result, getActorBuildLogToolOutputSchema);
    });

    it('returns conforming structuredContent for an empty log', async () => {
        getMock.mockResolvedValue('');

        const result = await callTool({ buildId: 'build-1', lines: 10 });

        expect(result.content[0].text).toBe('');
        expect(result.structuredContent).toEqual({ log: '' });
        expectSchemaConformingStructuredContent(result, getActorBuildLogToolOutputSchema);
    });

    it('returns a not-found error when the build does not exist', async () => {
        getMock.mockResolvedValue(undefined);

        const result = await (getActorBuildLog as HelperTool).call(
            stubToolCallContext({ buildId: 'missing-build', lines: 10 }, stubClient),
        );
        const { content, structuredContent } = result as TextToolResult & { structuredContent?: unknown };

        expectSoftFailInvalidInput(result);
        expect(content[0].text).toBe("Build with ID 'missing-build' not found.");
        expect(structuredContent).toBeUndefined();
    });

    it('returns the same not-found error text as get-actor-build for the same missing build', async () => {
        const client = {
            build: (_id: string) => ({
                get: async () => undefined,
                log: () => ({ get: getMock }),
            }),
        } as unknown as InternalToolArgs['apifyClient'];
        getMock.mockResolvedValue(undefined);

        const logResult = (await (getActorBuildLog as HelperTool).call(
            stubToolCallContext({ buildId: 'missing-build', lines: 10 }, client),
        )) as TextToolResult;
        const buildResult = (await (getActorBuild as HelperTool).call(
            stubToolCallContext({ buildId: 'missing-build' }, client),
        )) as TextToolResult;

        expect(logResult.isError).toBe(true);
        expect(buildResult.isError).toBe(true);
        expect(logResult.content[0].text).toBe(buildResult.content[0].text);
    });

    it('does not require lines in the input schema', () => {
        expect((getActorBuildLog as HelperTool).inputSchema.required).toEqual(['buildId']);
    });

    it('validates buildId and lines via ajv', () => {
        const tool = getActorBuildLog as HelperTool;
        expect(tool.ajvValidate({ buildId: 'build-1' })).toBe(true);
        expect(tool.ajvValidate({ buildId: 'build-1', lines: 0 })).toBe(true);
        expect(tool.ajvValidate({ buildId: 'build-1', lines: 50 })).toBe(true);
        expect(tool.ajvValidate({ buildId: 'build-1', lines: 51 })).toBe(false);
        expect(tool.ajvValidate({ buildId: 'build-1', lines: -1 })).toBe(false);
        expect(tool.ajvValidate({ buildId: 'build-1', lines: 1.5 })).toBe(false);
        expect(tool.ajvValidate({ buildId: '' })).toBe(false);
        expect(tool.ajvValidate({})).toBe(false);
    });
});
