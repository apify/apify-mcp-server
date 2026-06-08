import { beforeEach, describe, expect, it, vi } from 'vitest';

import { STORAGE_TYPE } from '../../src/const.js';
import { buildStorageAccessProperties, trackStorageAccess, trackToolCall } from '../../src/telemetry.js';
import type { ToolCallTelemetryProperties } from '../../src/types.js';

// Mock the Segment Analytics client
const mockTrack = vi.fn();
vi.mock('@segment/analytics-node', () => ({
    // Vitest 4 constructs mocked classes via `Reflect.construct`, which requires a
    // constructable implementation. An arrow function has no [[Construct]], so it must
    // be a regular function that returns the mock instance.
    Analytics: vi.fn().mockImplementation(function () {
        return {
            track: mockTrack,
        };
    }),
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

describe('trackStorageAccess()', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('sends the dedicated "MCP Storage Access" event', () => {
        const properties = {
            app: 'mcp' as const,
            app_version: '0.5.6',
            mcp_client_name: 'test-client',
            mcp_client_version: '1.0.0',
            mcp_protocol_version: '2024-11-05',
            mcp_client_capabilities: {},
            mcp_session_id: 'session-123',
            transport_type: 'stdio',
            tool_name: 'get-dataset-items',
            tool_status: 'SUCCEEDED' as const,
            tool_exec_time_ms: 100,
            storage_type: STORAGE_TYPE.DATASET,
        };

        trackStorageAccess('test-user-123', 'DEV', properties);

        expect(mockTrack).toHaveBeenCalledWith({
            userId: 'test-user-123',
            event: 'MCP Storage Access',
            properties,
        });
    });
});

describe('buildStorageAccessProperties()', () => {
    const toolCall: ToolCallTelemetryProperties = {
        app: 'mcp',
        app_version: '0.5.6',
        mcp_client_name: 'test-client',
        mcp_client_version: '1.0.0',
        mcp_protocol_version: '2024-11-05',
        mcp_client_capabilities: {},
        mcp_session_id: 'session-123',
        transport_type: 'stdio',
        tool_name: 'get-key-value-store-record',
        tool_status: 'SOFT_FAIL',
        tool_exec_time_ms: 42,
        tool_response_content_bytes: 10,
        failure_category: 'INVALID_INPUT',
        failure_detail: "Record 'x' not found.",
    };

    it('keeps the envelope plus status / error fields and adds storage_type', () => {
        const result = buildStorageAccessProperties(toolCall, STORAGE_TYPE.KEY_VALUE_STORE);

        expect(result).toEqual({
            app: 'mcp',
            app_version: '0.5.6',
            mcp_client_name: 'test-client',
            mcp_client_version: '1.0.0',
            mcp_protocol_version: '2024-11-05',
            mcp_client_capabilities: {},
            mcp_session_id: 'session-123',
            transport_type: 'stdio',
            tool_name: 'get-key-value-store-record',
            tool_status: 'SOFT_FAIL',
            tool_exec_time_ms: 42,
            tool_response_content_bytes: 10,
            failure_category: 'INVALID_INPUT',
            failure_detail: "Record 'x' not found.",
            storage_type: STORAGE_TYPE.KEY_VALUE_STORE,
        });
    });

    it('drops actor and validation fields that carry no meaning for storage tools', () => {
        const result = buildStorageAccessProperties(
            { ...toolCall, actor_name: 'apify/x', actor_id: 'abc', validation_keyword: 'required' },
            STORAGE_TYPE.DATASET,
        );

        expect(result).not.toHaveProperty('actor_name');
        expect(result).not.toHaveProperty('actor_id');
        expect(result).not.toHaveProperty('validation_keyword');
    });

    it('omits absent optional fields rather than setting them undefined', () => {
        const minimal: ToolCallTelemetryProperties = {
            app: 'mcp',
            app_version: '0.5.6',
            mcp_client_name: 'test-client',
            mcp_client_version: '1.0.0',
            mcp_protocol_version: '2024-11-05',
            mcp_client_capabilities: null,
            mcp_session_id: 'session-123',
            transport_type: 'stdio',
            tool_name: 'get-dataset',
            tool_status: 'SUCCEEDED',
            tool_exec_time_ms: 5,
        };

        const result = buildStorageAccessProperties(minimal, STORAGE_TYPE.DATASET);

        expect(result).not.toHaveProperty('failure_category');
        expect(result).not.toHaveProperty('tool_response_content_bytes');
        expect(Object.keys(result)).not.toContain('failure_detail');
    });
});
