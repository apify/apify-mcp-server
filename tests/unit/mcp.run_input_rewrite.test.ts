import { describe, expect, it, vi } from 'vitest';

import { REQUEST_ORIGIN } from '../../src/apify_client.js';
import { RAG_WEB_BROWSER } from '../../src/const.js';
import { ActorLoadError } from '../../src/errors.js';
import { loadReplacedDefaultTool } from '../../src/mcp/run_input_rewrite.js';
import { actorNameToToolName } from '../../src/tools/actor_tool_naming.js';
import type { ToolEntry } from '../../src/types.js';
import { resolveToolNamesFromInput } from '../../src/utils/tools_loader.js';

vi.mock('../../src/tools/actors/actor_tools_factory.js', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('../../src/tools/actors/actor_tools_factory.js');
    return { ...actual, getActorsAsTools: vi.fn() };
});

const { getActorsAsTools } = await import('../../src/tools/actors/actor_tools_factory.js');

describe('loadReplacedDefaultTool()', () => {
    it('serves the tool of an Actor that loaded without another of its tools', async () => {
        const name = actorNameToToolName(RAG_WEB_BROWSER);
        const tool = { name } as ToolEntry;
        const error = ActorLoadError.inputSchemaNotLoaded(RAG_WEB_BROWSER, new Error('invalid'), 'search');
        vi.mocked(getActorsAsTools).mockResolvedValue({ tools: [tool], errors: [error] });
        // The session serves every default tool.
        const tools = new Map([...resolveToolNamesFromInput({})].map((toolName) => [toolName, {} as ToolEntry]));

        await expect(
            loadReplacedDefaultTool({
                name,
                tools,
                apifyToken: 'test-token',
                requestOrigin: REQUEST_ORIGIN.MCP,
                mcpSessionId: 's1',
            }),
        ).resolves.toBe(tool);
    });
});
