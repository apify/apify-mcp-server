import { describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { getActorRunLog } from '../../src/tools/runs/get_actor_run_log.js';
import { getActorRunLogToolOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import {
    expectSchemaConformingStructuredContent,
    stubToolCallContext,
    type TextToolResult,
} from './helpers/tool_context.js';

const getMock = vi.fn();
const logMock = vi.fn(() => ({ get: getMock }));
const runMock = vi.fn(() => ({ log: logMock }));

const stubClient = { run: runMock } as unknown as InternalToolArgs['apifyClient'];

const LOG_LINES = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
const LOG_TEXT = LOG_LINES.join('\n');

describe('get-actor-run-log', () => {
    it('has the expected tool name', () => {
        expect(getActorRunLog.name).toBe(HELPER_TOOLS.ACTOR_RUNS_LOG);
    });

    it('declares an outputSchema', () => {
        expect((getActorRunLog as HelperTool).outputSchema).toMatchObject({ type: 'object' });
    });

    it('returns the last N lines matching the tool slicing', async () => {
        getMock.mockResolvedValue(LOG_TEXT);

        const result = await (getActorRunLog as HelperTool).call(
            stubToolCallContext({ runId: 'run-1', lines: 5 }, stubClient),
        );
        const { content } = result as TextToolResult;

        const expected = LOG_LINES.slice(-5).join('\n');
        expect(content[0].text).toBe(expected);
        expect(runMock).toHaveBeenCalledWith('run-1');
    });

    it('returns the entire log when lines is 0', async () => {
        getMock.mockResolvedValue(LOG_TEXT);

        const result = await (getActorRunLog as HelperTool).call(
            stubToolCallContext({ runId: 'run-1', lines: 0 }, stubClient),
        );
        const { content } = result as TextToolResult;

        expect(content[0].text).toBe(LOG_TEXT);
    });

    it('mirrors the text content in structuredContent.log', async () => {
        getMock.mockResolvedValue(LOG_TEXT);

        const result = await (getActorRunLog as HelperTool).call(
            stubToolCallContext({ runId: 'run-1', lines: 5 }, stubClient),
        );
        const { content, structuredContent } = result as TextToolResult;

        expect((structuredContent as { log: string }).log).toBe(content[0].text);
    });

    it('emits structuredContent conforming to the outputSchema', async () => {
        getMock.mockResolvedValue(LOG_TEXT);

        const result = await (getActorRunLog as HelperTool).call(
            stubToolCallContext({ runId: 'run-1', lines: 5 }, stubClient),
        );

        expectSchemaConformingStructuredContent(result, getActorRunLogToolOutputSchema);
    });
});
