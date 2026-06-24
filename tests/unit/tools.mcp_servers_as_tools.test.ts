import { beforeEach, describe, expect, it, vi } from 'vitest';

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
        actor: {},
    } as unknown as ActorInfo;
}

describe('getMCPServersAsTools', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('skips only the Actor whose webServerMcpPath escapes its standby origin, not the whole batch', async () => {
        const goodTool = { tool: { name: 'good-tool' } } as unknown as ToolEntry;
        getActorMCPServerURL.mockImplementation(async (realActorId: string) => {
            if (realActorId === 'evil') throw new Error('resolves outside its standby origin');
            return `https://${realActorId}.apify.actor/mcp`;
        });
        connectMCPClient.mockResolvedValue({ close: vi.fn() });
        getMCPServerTools.mockResolvedValue([goodTool]);

        const tools = await getMCPServersAsTools(
            [makeActorInfo('evil', '//attacker.com/mcp'), makeActorInfo('good', '/mcp')],
            'token-123',
        );

        expect(tools).toEqual([goodTool]);
        expect(getActorMCPServerURL).toHaveBeenCalledTimes(2);
        expect(connectMCPClient).toHaveBeenCalledTimes(1);
    });
});
