import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ActorsModule from '../../src/mcp/actors.js';
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

    it('skips only the Actor whose standby URL is not on the platform standby domain', async () => {
        const actual = await vi.importActual<typeof ActorsModule>('../../src/mcp/actors.js');
        getActorMCPServerURL.mockImplementation(actual.getActorMCPServerURL);
        const goodTool = { tool: { name: 'good-tool' } } as unknown as ToolEntry;
        connectMCPClient.mockResolvedValue({ close: vi.fn() });
        getMCPServerTools.mockResolvedValue([goodTool]);
        const outside = makeActorInfo('outside', '/mcp');
        outside.actor.standbyUrl = 'https://outside.example.com';

        const tools = await getMCPServersAsTools([outside, makeActorInfo('good', '/mcp')], { token: 'token-123' });

        expect(tools).toEqual([goodTool]);
        expect(connectMCPClient).toHaveBeenCalledTimes(1);
        expect(connectMCPClient.mock.calls[0][0]).toBe('https://good.apify.actor/mcp');
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
        );
    });
});
