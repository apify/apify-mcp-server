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

    it('should send correct payload structure to Segment', () => {
        const userId = 'test-user-123';
        const properties = {
            app: 'mcp' as const,
            app_version: '0.5.6',
            mcp_client_name: 'test-client',
            mcp_client_version: '1.0.0',
            mcp_protocol_version: '2024-11-05',
            mcp_client_capabilities: '{}',
            mcp_session_id: 'session-123',
            transport_type: 'stdio',
            tool_name: 'test-tool',
            tool_status: 'succeeded' as const,
            tool_exec_time_ms: 100,
            tool_call_number: 1,
        };

        trackToolCall(userId, properties);

        expect(mockTrack).toHaveBeenCalledWith({
            userId: 'test-user-123',
            event: 'MCP Tool Call',
            properties: {
                app: 'mcp',
                app_version: '0.5.6',
                mcp_client_name: 'test-client',
                mcp_client_version: '1.0.0',
                mcp_protocol_version: '2024-11-05',
                mcp_client_capabilities: '{}',
                mcp_session_id: 'session-123',
                transport_type: 'stdio',
                tool_name: 'test-tool',
                tool_status: 'succeeded',
                tool_exec_time_ms: 100,
                tool_call_number: 1,
            },
        });
    });
});
