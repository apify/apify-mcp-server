import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TELEMETRY_ENV } from '../../src/const.js';
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
            app_name: 'apify-mcp-server',
            app_version: '0.5.6',
            mcp_client_name: 'test-client',
            mcp_client_version: '1.0.0',
            mcp_protocol_version: '2024-11-05',
            mcp_capabilities: '{}',
            mcp_session_id: 'session-123',
            transport_type: 'stdio',
            tool_name: 'test-tool',
            reason: 'test reason',
        };

        trackToolCall(userId, TELEMETRY_ENV.DEV, properties);

        expect(mockTrack).toHaveBeenCalledWith({
            userId: 'test-user-123',
            event: 'MCP tool call',
            properties: {
                app_name: 'apify-mcp-server',
                app_version: '0.5.6',
                mcp_client_name: 'test-client',
                mcp_client_version: '1.0.0',
                mcp_protocol_version: '2024-11-05',
                mcp_capabilities: '{}',
                mcp_session_id: 'session-123',
                transport_type: 'stdio',
                tool_name: 'test-tool',
                reason: 'test reason',
            },
        });
    });
});
