import { Server } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';

import { listStatelessHandlerMethods, STATELESS_PROTOCOL_VERSION, withStatelessServer } from './helpers/mcp_server.js';

const STREAM_END_TIMEOUT_MILLIS = 1_000;

/**
 * Reads the body to its end, or cancels the read and returns `undefined` if the stream is still open
 * after `timeoutMillis`.
 */
async function readBodyToEnd(response: Response, timeoutMillis: number): Promise<string | undefined> {
    const reader = response.body!.getReader();
    let isTimedOut = false;
    const timer = setTimeout(() => {
        isTimedOut = true;
        void reader.cancel();
    }, timeoutMillis);
    const decoder = new TextDecoder();
    let body = '';
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        body += decoder.decode(chunk.value, { stream: true });
    }
    clearTimeout(timer);
    return isTimedOut ? undefined : body;
}

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

    // Unlike `tasks/*`, registering nothing does not make the method answer method-not-found: the
    // SDK's serving entry answers `subscriptions/listen` itself. No declared capability is
    // subscribable, so it acknowledges an empty filter, sends a completion result and closes the
    // stream (pinned below).
    it('registers no subscriptions/listen handler', async () => {
        await withStatelessServer(async ({ buildServer }) => {
            expect(listStatelessHandlerMethods(buildServer())).not.toContain('subscriptions/listen');
        });
    });

    it('acknowledges subscriptions/listen with an empty filter, completes it and closes the stream', async () => {
        await withStatelessServer(async ({ fetch }) => {
            const { requestId, response } = await fetch('subscriptions/listen', {
                notifications: {
                    tools: { listChanged: true },
                    resources: { listChanged: true },
                    prompts: { listChanged: true },
                },
            });
            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toContain('text/event-stream');

            const body = await readBodyToEnd(response, STREAM_END_TIMEOUT_MILLIS);
            expect(body, 'stream still open at the deadline').toBeDefined();
            const [acknowledgement, completion] = body!
                .split('\n')
                .filter((line) => line.startsWith('data: '))
                .map((line) => JSON.parse(line.slice('data: '.length)));
            expect(acknowledgement).toMatchObject({ method: 'notifications/subscriptions/acknowledged' });
            expect(acknowledgement).toHaveProperty('params.notifications', {});
            expect(completion).toMatchObject({ id: requestId, result: { resultType: 'complete' } });
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
