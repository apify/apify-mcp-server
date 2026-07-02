import { describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { addActor } from '../../src/tools/actors/add_actor.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import type { TextToolResult } from './helpers/tool_context.js';

// add-actor constructs its own ApifyClient from the token; a stub constructor is enough
// to keep the test network-free.
vi.mock('../../src/apify_client.js', () => ({
    ApifyClient: vi.fn().mockImplementation(function () {
        return {};
    }),
}));

function buildContext(
    overrides: {
        actor?: string;
        alreadyLoaded?: string[];
        tools?: { name: string }[];
        errors?: { message: string }[];
        sendNotification?: ReturnType<typeof vi.fn>;
    } = {},
): InternalToolArgs {
    const {
        actor = 'apify/rag-web-browser',
        alreadyLoaded = [],
        tools = [{ name: 'apify/rag-web-browser' }],
        errors = [],
        sendNotification = vi.fn().mockResolvedValue(undefined),
    } = overrides;
    return {
        args: { actor },
        apifyToken: 'test-token',
        apifyClient: null,
        extra: { sendNotification },
        mcpServer: {},
        apifyMcpServer: {
            listAllToolNames: () => alreadyLoaded,
            loadActorsAsTools: vi.fn().mockResolvedValue({ tools, errors }),
        },
    } as unknown as InternalToolArgs;
}

describe('add-actor tool', () => {
    it('has the expected tool name', () => {
        expect(addActor.name).toBe(HELPER_TOOLS.ACTOR_ADD);
    });

    it('sends list_changed and nudges the client to refresh via tools/list (#851)', async () => {
        const sendNotification = vi.fn().mockResolvedValue(undefined);
        const result = (await (addActor as HelperTool).call(
            buildContext({ tools: [{ name: 'apify/rag-web-browser' }], sendNotification }),
        )) as TextToolResult;

        expect(sendNotification).toHaveBeenCalledWith({ method: 'notifications/tools/list_changed' });

        const { text } = result.content[0];
        expect(text).toContain('Actor apify/rag-web-browser has been added');
        expect(text).toContain('apify/rag-web-browser');
        expect(text).toMatch(/tools\/list/);
        expect(result.isError).toBeFalsy();
    });

    it('does not nudge when the actor is already available', async () => {
        const result = (await (addActor as HelperTool).call(
            buildContext({ actor: 'apify/already-there', alreadyLoaded: ['apify/already-there'] }),
        )) as TextToolResult;

        expect(result.content[0].text).toContain('already available');
        expect(result.content[0].text).not.toMatch(/tools\/list/);
    });

    it('forwards a load error without a nudge', async () => {
        const result = (await (addActor as HelperTool).call(
            buildContext({ errors: [{ message: 'Actor xyz was not found.' }], tools: [] }),
        )) as TextToolResult;

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toBe('Actor xyz was not found.');
        expect(result.content[0].text).not.toMatch(/tools\/list/);
    });
});
