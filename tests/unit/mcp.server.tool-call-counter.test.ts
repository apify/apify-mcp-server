import { describe, expect, it } from 'vitest';

import { ActorsMcpServer } from '../../src/index.js';
import type { ToolCallCounterStore } from '../../src/types.js';

describe('ActorsMcpServer tool call counter', () => {
    describe('default in-memory store', () => {
        it('should increment counter correctly for multiple calls', async () => {
            const server = new ActorsMcpServer({ setupSigintHandler: false });
            // Default store is available if telemetry is enabled
            const store = server.getToolCallCountStore();
            expect(store).toBeDefined();

            const sessionId = 'test-session-1';

            // First call should return 1
            const firstCall = await store!.getAndIncrement(sessionId);
            expect(firstCall).toBe(1);

            // Second call should return 2
            const secondCall = await store!.getAndIncrement(sessionId);
            expect(secondCall).toBe(2);

            // Third call should return 3
            const thirdCall = await store!.getAndIncrement(sessionId);
            expect(thirdCall).toBe(3);
        });

        it('should have independent counters for different sessions', async () => {
            const server = new ActorsMcpServer({ setupSigintHandler: false });
            const store = server.getToolCallCountStore();
            expect(store).toBeDefined();

            const sessionId1 = 'session-1';
            const sessionId2 = 'session-2';

            // Increment session 1 twice
            const session1Call1 = await store!.getAndIncrement(sessionId1);
            expect(session1Call1).toBe(1);
            const session1Call2 = await store!.getAndIncrement(sessionId1);
            expect(session1Call2).toBe(2);

            // Session 2 should start at 1
            const session2Call1 = await store!.getAndIncrement(sessionId2);
            expect(session2Call1).toBe(1);

            // Session 1 should still be at 2
            const session1Call3 = await store!.getAndIncrement(sessionId1);
            expect(session1Call3).toBe(3);

            // Session 2 should be at 2
            const session2Call2 = await store!.getAndIncrement(sessionId2);
            expect(session2Call2).toBe(2);
        });
    });

    describe('custom store', () => {
        it('should use provided custom store instead of default', async () => {
            const customStore: ToolCallCounterStore = {
                getAndIncrement: async (sessionId: string) => {
                    // Custom implementation that returns a fixed value
                    // This is just for testing that custom store is used
                    return sessionId.length + 1;
                },
            };

            const server = new ActorsMcpServer({
                setupSigintHandler: false,
                telemetry: {
                    toolCallCountStore: customStore,
                },
            });

            const store = server.getToolCallCountStore();
            expect(store).toBeDefined();
            const result = await store!.getAndIncrement('test-session');

            // Should use custom store logic, not default
            expect(result).toBe('test-session'.length + 1);
        });
    });
});
