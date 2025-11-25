import { describe, expect, it } from 'vitest';

import { ActorsMcpServer } from '../../src/index.js';
import type { ToolCallCounterStore } from '../../src/types.js';

describe('ActorsMcpServer tool call counter', () => {
    describe('default in-memory store', () => {
        it('should increment counter correctly for multiple calls', async () => {
            const server = new ActorsMcpServer({ setupSigintHandler: false });
            // Default store is available if telemetry is enabled
            const toolCallCount = server.getToolCallCountStore();
            expect(toolCallCount).toBeDefined();

            if (!toolCallCount) {
                // TypeScript needs this for type narrowing
                expect.fail('toolCallCount should be defined');
            }

            const sessionId = 'test-session-1';

            // First call should return 1
            const firstCall = await toolCallCount.getAndIncrement(sessionId);
            expect(firstCall).toBe(1);

            // Second call should return 2
            const secondCall = await toolCallCount.getAndIncrement(sessionId);
            expect(secondCall).toBe(2);

            // Third call should return 3
            const thirdCall = await toolCallCount.getAndIncrement(sessionId);
            expect(thirdCall).toBe(3);
        });

        it('should have independent counters for different sessions', async () => {
            const server = new ActorsMcpServer({ setupSigintHandler: false });
            const toolCallCount = server.getToolCallCountStore();
            expect(toolCallCount).toBeDefined();

            if (!toolCallCount) {
                // TypeScript needs this for type narrowing
                expect.fail('toolCallCount should be defined');
            }

            const sessionId1 = 'session-1';
            const sessionId2 = 'session-2';

            // Increment session 1 twice
            const session1Call1 = await toolCallCount.getAndIncrement(sessionId1);
            expect(session1Call1).toBe(1);
            const session1Call2 = await toolCallCount.getAndIncrement(sessionId1);
            expect(session1Call2).toBe(2);

            // Session 2 should start at 1
            const session2Call1 = await toolCallCount.getAndIncrement(sessionId2);
            expect(session2Call1).toBe(1);

            // Session 1 should still be at 2
            const session1Call3 = await toolCallCount.getAndIncrement(sessionId1);
            expect(session1Call3).toBe(3);

            // Session 2 should be at 2
            const session2Call2 = await toolCallCount.getAndIncrement(sessionId2);
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
                    enabled: true,
                    toolCallCountStore: customStore,
                },
            });

            const toolCallCount = server.getToolCallCountStore();
            expect(toolCallCount).toBeDefined();

            if (!toolCallCount) {
                // TypeScript needs this for type narrowing
                expect.fail('toolCallCount should be defined');
            }

            const result = await toolCallCount.getAndIncrement('test-session');

            // Should use custom store logic, not default
            expect(result).toBe('test-session'.length + 1);
        });
    });
});
