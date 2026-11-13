import { afterAll, describe, expect, it } from 'vitest';

import { HELPER_TOOLS, MAX_INLINE_BYTES } from '../../src/const.js';
import { getActorBuild } from '../../src/tools/builds/get_actor_build.js';
import { getActorBuildLog } from '../../src/tools/builds/get_actor_build_log.js';
import { getActorBuildLogToolOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool } from '../../src/types.js';
import { numberedLog, startLogServer } from './helpers/log_server.js';
import {
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    stubToolCallContext,
    type TextToolResult,
} from './helpers/tool_context.js';

const logServer = await startLogServer();

afterAll(async () => logServer.close());

/** Calls the tool on a build whose log is `log`. */
const callTool = async (log: string, args: Record<string, unknown> = {}) =>
    (await (getActorBuildLog as HelperTool).call(
        stubToolCallContext({ buildId: logServer.serveLog(log), ...args }, logServer.client),
    )) as TextToolResult;

describe('get-actor-build-log', () => {
    it('has the expected tool name', () => {
        expect(getActorBuildLog.name).toBe(HELPER_TOOLS.ACTOR_BUILD_LOG);
    });

    it('returns exactly the requested number of trailing lines', async () => {
        const { content } = await callTool(numberedLog(20), { lines: 3 });

        expect(content[0].text.split('\n')).toEqual(['line 18', 'line 19', 'line 20']);
    });

    it('returns a single line when one line is requested', async () => {
        const { content } = await callTool(numberedLog(20), { lines: 1 });

        expect(content[0].text).toBe('line 20');
    });

    it('returns exactly the default 10 lines when lines is omitted', async () => {
        const { content } = await callTool(numberedLog(50));

        expect(content[0].text.split('\n')).toHaveLength(10);
    });

    it('returns the entire log when lines is 0', async () => {
        const { content } = await callTool(numberedLog(50), { lines: 0 });
        const returned = content[0].text.split('\n');

        expect(content).toHaveLength(1);
        expect(returned).toHaveLength(50);
        expect(returned[0]).toBe('line 1');
        expect(returned[49]).toBe('line 50');
    });

    it('returns the full lines of the last MAX_INLINE_BYTES and says the start is cut when lines is 0 and the log is longer', async () => {
        // 'line 1' … 'line N' with N = MAX_INLINE_BYTES / 10 run past MAX_INLINE_BYTES.
        const longLog = numberedLog(MAX_INLINE_BYTES / 10);

        const result = await callTool(longLog, { lines: 0 });
        const returned = result.content[0].text.split('\n');

        expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(MAX_INLINE_BYTES);
        expect(returned).toEqual(longLog.split('\n').slice(-returned.length));
        expect(result.content[1].text).toContain(`${MAX_INLINE_BYTES} bytes`);
        expect(result.structuredContent).toEqual({ log: result.content[0].text });
    });

    it('returns only content lines when the log ends with a newline', async () => {
        const { content } = await callTool(`${numberedLog(20)}\n`, { lines: 3 });

        expect(content[0].text.split('\n')).toEqual(['line 18', 'line 19', 'line 20']);
    });

    it('returns the whole log when it is shorter than the requested number of lines', async () => {
        const { content } = await callTool(numberedLog(3), { lines: 10 });

        expect(content[0].text).toBe('line 1\nline 2\nline 3');
    });

    it('mirrors the log text in structuredContent and declares an outputSchema', async () => {
        const result = await callTool(numberedLog(20), { lines: 10 });

        expect(result.structuredContent).toEqual({ log: result.content[0].text });
        expect((getActorBuildLog as HelperTool).outputSchema).toBe(getActorBuildLogToolOutputSchema);
        expectSchemaConformingStructuredContent(result, getActorBuildLogToolOutputSchema);
    });

    it('returns conforming structuredContent for an empty log', async () => {
        const result = await callTool('', { lines: 10 });

        expect(result.content[0].text).toBe('');
        expect(result.structuredContent).toEqual({ log: '' });
        expectSchemaConformingStructuredContent(result, getActorBuildLogToolOutputSchema);
    });

    it('returns a not-found error when the build does not exist', async () => {
        const result = await (getActorBuildLog as HelperTool).call(
            stubToolCallContext({ buildId: 'missing-build', lines: 10 }, logServer.client),
        );
        const { content, structuredContent } = result as TextToolResult & { structuredContent?: unknown };

        expectSoftFailInvalidInput(result);
        expect(content[0].text).toBe("Build with ID 'missing-build' not found.");
        expect(structuredContent).toBeUndefined();
    });

    it('returns the same not-found error text as get-actor-build for the same missing build', async () => {
        const logResult = (await (getActorBuildLog as HelperTool).call(
            stubToolCallContext({ buildId: 'missing-build', lines: 10 }, logServer.client),
        )) as TextToolResult;
        const buildResult = (await (getActorBuild as HelperTool).call(
            stubToolCallContext({ buildId: 'missing-build' }, logServer.client),
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
