import { Server } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';

import { listStatelessHandlerMethods, STATELESS_PROTOCOL_VERSION, withStatelessServer } from './helpers/mcp_server.js';

/**
 * Pins what the stateless (2026-07-28) adapter registers and advertises. The v2 SDK is a pinned beta,
 * so this suite doubles as the canary for a bump that moves request classification, the envelope
 * keys, or the capability gates.
 */
describe('createStatelessServer()', () => {
    const SERVED_CAPABILITIES = { tools: {}, resources: {}, prompts: {} };
    const SERVED_METHODS = [
        'tools/list',
        'tools/call',
        'resources/list',
        'resources/templates/list',
        'resources/read',
        'prompts/list',
        'prompts/get',
    ];

    it('registers exactly the methods it serves and nothing beyond the SDK own handlers', async () => {
        await withStatelessServer(async ({ buildServer }) => {
            // Diffing against a bare `Server` built with the same capabilities separates our
            // registrations from the SDK's own (`server/discover`, `logging/setLevel`, …), so this
            // asserts both "all seven are wired" and "we added nothing else".
            const sdkOwnMethods = listStatelessHandlerMethods(
                new Server({ name: 'baseline', version: '0.0.0' }, { capabilities: SERVED_CAPABILITIES }),
            );
            const ourMethods = listStatelessHandlerMethods(buildServer()).filter(
                (method) => !sdkOwnMethods.includes(method),
            );
            expect(ourMethods.sort()).toEqual([...SERVED_METHODS].sort());
        });
    });

    it('registers no task handler, leaving tasks/* to the SDK', async () => {
        await withStatelessServer(async ({ buildServer }) => {
            const methods = listStatelessHandlerMethods(buildServer());
            expect(methods.filter((method) => method.startsWith('tasks/'))).toEqual([]);
        });
    });

    // Handler absence is all this can assert. Unlike `tasks/*`, registering nothing does not make
    // the method answer method-not-found: the SDK's serving entry answers `subscriptions/listen`
    // upstream of our handlers, with a stream that honors none of our declared capabilities.
    // Refusing it outright is a follow-up (see the capability block in `stateless_server.ts`).
    it('registers no subscriptions/listen handler', async () => {
        await withStatelessServer(async ({ buildServer }) => {
            expect(listStatelessHandlerMethods(buildServer())).not.toContain('subscriptions/listen');
        });
    });

    it('advertises tools, resources and prompts only — no tasks, logging or tools.listChanged', async () => {
        await withStatelessServer(async ({ buildServer }) => {
            expect(buildServer().getCapabilities()).toEqual(SERVED_CAPABILITIES);
        });
    });

    describe('tasks/*', () => {
        // Tasks are out of scope on this revision: registering nothing is what makes the SDK answer
        // method-not-found by itself.
        for (const method of ['tasks/list', 'tasks/get', 'tasks/cancel']) {
            it(`answers ${method} with method not found`, async () => {
                await withStatelessServer(async ({ call }) => {
                    const response = await call(method, { taskId: 'whatever' });
                    expect(response.error?.code).toBe(-32601);
                    expect(response.error?.message).toBe('Method not found');
                });
            });
        }
    });

    it('answers server/discover from the SDK, which owns that method', async () => {
        await withStatelessServer(async ({ call }) => {
            const response = await call('server/discover');
            expect(response.result).toMatchObject({
                supportedVersions: [STATELESS_PROTOCOL_VERSION],
                capabilities: SERVED_CAPABILITIES,
            });
        });
    });
});
