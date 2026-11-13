import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ACTOR_LOAD_ERROR_KIND, SchemaTooLargeError } from '../../src/errors.js';
import { MAX_UNTRUSTED_ENUM_VALUES } from '../../src/tools/actor_input_schema.js';
import type { ActorInfo, ToolEntry } from '../../src/types.js';

const getActorMCPServerURL = vi.fn();
const connectMCPClient = vi.fn();
const getMCPServerTools = vi.fn();

vi.mock('../../src/mcp/actors.js', () => ({
    getActorMCPServerURL: (...args: unknown[]) => getActorMCPServerURL(...args),
    getActorMCPServerPath: vi.fn(),
}));
vi.mock('../../src/mcp/client.js', () => ({
    connectMCPClient: (...args: unknown[]) => connectMCPClient(...args),
}));
vi.mock('../../src/mcp/proxy.js', () => ({
    getMCPServerTools: (...args: unknown[]) => getMCPServerTools(...args),
}));

const { getMCPServersAsTools } = await import('../../src/tools/actors/actor_tools_factory.js');

function makeActorInfo(id: string, webServerMcpPath: string): ActorInfo {
    return {
        webServerMcpPath,
        definition: { id, actorFullName: `user/${id}` },
        actor: { id, standbyUrl: `https://${id}.apify.actor` },
    } as unknown as ActorInfo;
}

describe('getMCPServersAsTools', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('skips only the Actor whose webServerMcpPath escapes its standby origin, not the whole batch', async () => {
        const goodTool = { tool: { name: 'good-tool' } } as unknown as ToolEntry;
        getActorMCPServerURL.mockImplementation(async (actor: { id: string }) => {
            if (actor.id === 'evil') throw new Error('resolves outside its standby origin');
            return `https://${actor.id}.apify.actor/mcp`;
        });
        connectMCPClient.mockResolvedValue({ close: vi.fn() });
        getMCPServerTools.mockResolvedValue([goodTool]);

        const tools = await getMCPServersAsTools(
            [makeActorInfo('evil', '//attacker.com/mcp'), makeActorInfo('good', '/mcp')],
            { token: 'token-123' },
        );

        expect(tools).toEqual([goodTool]);
        expect(getActorMCPServerURL).toHaveBeenCalledTimes(2);
        expect(connectMCPClient).toHaveBeenCalledTimes(1);
    });

    it('passes the Actor full name to getMCPServerTools', async () => {
        getActorMCPServerURL.mockImplementation(async (actor: { id: string }) => `https://${actor.id}.apify.actor/mcp`);
        connectMCPClient.mockResolvedValue({ close: vi.fn() });
        getMCPServerTools.mockResolvedValue([]);

        await getMCPServersAsTools([makeActorInfo('good', '/mcp')], { token: 'token-123' });

        expect(getMCPServerTools).toHaveBeenCalledWith(
            'good',
            expect.anything(),
            'https://good.apify.actor/mcp',
            'user/good',
            expect.any(Function),
        );
    });

    it('reports a tool the MCP server loaded without, naming the tool, the Actor and the reason', async () => {
        const goodTool = { tool: { name: 'good-tool' } } as unknown as ToolEntry;
        getActorMCPServerURL.mockImplementation(async (actor: { id: string }) => `https://${actor.id}.apify.actor/mcp`);
        connectMCPClient.mockResolvedValue({ close: vi.fn() });
        getMCPServerTools.mockImplementation(async (...args: unknown[]) => {
            const onToolSkipped = args[4] as (toolName: string, compileError: unknown) => void;
            onToolSkipped('search-by-country', new SchemaTooLargeError(MAX_UNTRUSTED_ENUM_VALUES, 'enum values'));
            return [goodTool];
        });
        const onLoadError = vi.fn();

        const tools = await getMCPServersAsTools(
            [makeActorInfo('good', '/mcp')],
            { token: 'token-123' },
            undefined,
            onLoadError,
        );

        expect(tools).toEqual([goodTool]);
        expect(onLoadError).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                kind: ACTOR_LOAD_ERROR_KIND.INPUT_SCHEMA_NOT_LOADED,
                message:
                    'Tool "search-by-country" of Actor "user/good" was not loaded because its input schema is too large.',
            }),
        );
    });
});
