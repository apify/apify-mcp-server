import { beforeEach, describe, expect, it, vi } from 'vitest';

import { trackToolCall } from '../../src/telemetry.js';

// Mock the Segment Analytics client
const mockTrack = vi.fn();
vi.mock('@segment/analytics-node', () => ({
    Analytics: vi.fn().mockImplementation(() => ({
        track: mockTrack,
    })),
}));

describe('telemetry', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should send correct payload structure to Segment with userId', () => {
        const userId = 'test-user-123';
        const properties = {
            app: 'mcp' as const,
            app_version: '0.5.6',
            mcp_client_name: 'test-client',
            mcp_client_version: '1.0.0',
            mcp_protocol_version: '2024-11-05',
            mcp_client_capabilities: {},
            mcp_session_id: 'session-123',
            transport_type: 'stdio',
            tool_name: 'test-tool',
            tool_status: 'SUCCEEDED' as const,
            tool_exec_time_ms: 100,
        };

        trackToolCall(userId, 'DEV', properties);

        expect(mockTrack).toHaveBeenCalledWith({
            userId: 'test-user-123',
            event: 'MCP Tool Call',
            properties: {
                app: 'mcp',
                app_version: '0.5.6',
                mcp_client_name: 'test-client',
                mcp_client_version: '1.0.0',
                mcp_protocol_version: '2024-11-05',
                mcp_client_capabilities: {},
                mcp_session_id: 'session-123',
                transport_type: 'stdio',
                tool_name: 'test-tool',
                tool_status: 'SUCCEEDED',
                tool_exec_time_ms: 100,
            },
        });
    });

    it('should use anonymousId when userId is null', () => {
        const properties = {
            app: 'mcp' as const,
            app_version: '0.5.6',
            mcp_client_name: 'test-client',
            mcp_client_version: '1.0.0',
            mcp_protocol_version: '2024-11-05',
            mcp_client_capabilities: {},
            mcp_session_id: 'session-123',
            transport_type: 'stdio',
            tool_name: 'test-tool',
            tool_status: 'SUCCEEDED' as const,
            tool_exec_time_ms: 100,
        };

        trackToolCall(null, 'DEV', properties);

        expect(mockTrack).toHaveBeenCalledTimes(1);
        const callArgs = mockTrack.mock.calls[0][0];

        // Should have anonymousId but not userId
        expect(callArgs).toHaveProperty('anonymousId');
        expect(callArgs.anonymousId).toBeDefined();
        expect(typeof callArgs.anonymousId).toBe('string');
        expect(callArgs.anonymousId.length).toBeGreaterThan(0);
        expect(callArgs).not.toHaveProperty('userId');
        expect(callArgs.event).toBe('MCP Tool Call');
        expect(callArgs.properties).toEqual(properties);
    });

    it('should preserve optional failure diagnostics in the payload', () => {
        const properties = {
            app: 'mcp' as const,
            app_version: '0.5.6',
            mcp_client_name: 'test-client',
            mcp_client_version: '1.0.0',
            mcp_protocol_version: '2024-11-05',
            mcp_client_capabilities: {},
            mcp_session_id: 'session-123',
            transport_type: 'stdio',
            tool_name: 'call-actor',
            tool_status: 'SOFT_FAIL' as const,
            tool_exec_time_ms: 100,
            failure_category: 'INVALID_INPUT' as const,
            actor_name: 'apify/rag-web-browser',
            validation_keyword: 'required',
            validation_missing_property: 'query',
        };

        trackToolCall('test-user-123', 'DEV', properties);

        expect(mockTrack).toHaveBeenCalledWith({
            userId: 'test-user-123',
            event: 'MCP Tool Call',
            properties,
        });
    });
});
