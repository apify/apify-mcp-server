import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildReportedProblemProperties, trackReportedProblem, trackToolCall } from '../../src/telemetry.js';
import type { ReportedProblemTelemetryProperties, ToolCallTelemetryProperties } from '../../src/types.js';

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

function mockToolCallProperties(overrides: Partial<ToolCallTelemetryProperties> = {}): ToolCallTelemetryProperties {
    return {
        app: 'mcp',
        app_version: '0.5.6',
        mcp_client_name: 'test-client',
        mcp_client_version: '1.0.0',
        mcp_protocol_version: '2024-11-05',
        mcp_client_capabilities: {},
        mcp_session_id: 'session-123',
        transport_type: 'stdio',
        mcp_url_client: 'cursor',
        tool_name: 'call-actor',
        tool_status: 'SOFT_FAIL',
        tool_exec_time_ms: 100,
        ...overrides,
    };
}

function mockReportedProblemProperties(
    overrides: Partial<ReportedProblemTelemetryProperties> = {},
): ReportedProblemTelemetryProperties {
    return {
        app: 'mcp',
        app_version: '0.5.6',
        mcp_client_name: 'test-client',
        mcp_client_version: '1.0.0',
        mcp_protocol_version: '2024-11-05',
        mcp_session_id: 'session-123',
        transport_type: 'stdio',
        mcp_url_client: 'cursor',
        message: 'stuck on call-actor',
        sentiment: 'negative',
        category: 'bug',
        ...overrides,
    };
}

describe('telemetry', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('sends correct payload structure to Segment with userId', () => {
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
            mcp_url_client: 'cursor',
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
                mcp_url_client: 'cursor',
                tool_name: 'test-tool',
                tool_status: 'SUCCEEDED',
                tool_exec_time_ms: 100,
            },
        });
    });

    it('uses the session id as anonymousId when userId is null', () => {
        const properties = {
            app: 'mcp' as const,
            app_version: '0.5.6',
            mcp_client_name: 'test-client',
            mcp_client_version: '1.0.0',
            mcp_protocol_version: '2024-11-05',
            mcp_client_capabilities: {},
            mcp_session_id: 'session-123',
            transport_type: 'stdio',
            mcp_url_client: 'cursor',
            tool_name: 'test-tool',
            tool_status: 'SUCCEEDED' as const,
            tool_exec_time_ms: 100,
        };

        trackToolCall(null, 'DEV', properties);

        expect(mockTrack).toHaveBeenCalledTimes(1);
        const callArgs = mockTrack.mock.calls[0][0];

        // anonymousId is the session id (so a session's unauthenticated events share one identity), not userId.
        expect(callArgs.anonymousId).toBe('session-123');
        expect(callArgs).not.toHaveProperty('userId');
        expect(callArgs.event).toBe('MCP Tool Call');
        expect(callArgs.properties).toEqual(properties);
    });

    it('falls back to a random anonymousId when no session id is present', () => {
        const properties = {
            app: 'mcp' as const,
            app_version: '0.5.6',
            mcp_client_name: 'test-client',
            mcp_client_version: '1.0.0',
            mcp_protocol_version: '2024-11-05',
            mcp_client_capabilities: {},
            mcp_session_id: '',
            transport_type: 'stdio',
            mcp_url_client: 'cursor',
            tool_name: 'test-tool',
            tool_status: 'SUCCEEDED' as const,
            tool_exec_time_ms: 100,
        };

        trackToolCall(null, 'DEV', properties);

        const callArgs = mockTrack.mock.calls[0][0];
        expect(typeof callArgs.anonymousId).toBe('string');
        expect(callArgs.anonymousId.length).toBeGreaterThan(0);
        expect(callArgs.anonymousId).not.toBe('');
    });

    it('preserves optional failure diagnostics in the payload', () => {
        const properties = {
            app: 'mcp' as const,
            app_version: '0.5.6',
            mcp_client_name: 'test-client',
            mcp_client_version: '1.0.0',
            mcp_protocol_version: '2024-11-05',
            mcp_client_capabilities: {},
            mcp_session_id: 'session-123',
            transport_type: 'stdio',
            mcp_url_client: 'cursor',
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

describe('access tokens are masked in telemetry', () => {
    const API_TOKEN = `apify_api_${'a1B2'.repeat(9)}`;

    beforeEach(() => {
        vi.clearAllMocks();
    });

    // A bare token has the shape of an Actor name, so it passes every name check on the way here.
    it('masks a token in any property of the tool call event', () => {
        const properties = mockToolCallProperties({
            actor_name: API_TOKEN,
            failure_detail: `Request with token ${API_TOKEN} failed`,
        });

        trackToolCall('test-user-123', 'DEV', properties);

        expect(mockTrack.mock.calls[0][0].properties).toEqual({
            ...properties,
            actor_name: 'apify_api_***',
            failure_detail: 'Request with token apify_api_*** failed',
        });
    });

    it('masks a token in the reported problem event', () => {
        const properties = mockReportedProblemProperties({ message: `My token ${API_TOKEN} does not work` });

        trackReportedProblem('test-user-123', 'DEV', properties);

        expect(mockTrack.mock.calls[0][0].properties).toEqual({
            ...properties,
            message: 'My token apify_api_*** does not work',
        });
    });
});

describe('buildReportedProblemProperties', () => {
    const context = {
        app: 'mcp',
        app_version: '0.5.6',
        mcp_client_name: 'test-client',
        mcp_client_version: '1.0.0',
        mcp_protocol_version: '2024-11-05',
        mcp_client_capabilities: {},
        mcp_session_id: 'session-123',
        transport_type: 'stdio',
        mcp_url_client: 'cursor',
        tool_name: 'send-feedback',
        tool_status: 'SUCCEEDED',
        tool_exec_time_ms: 5,
    } as ToolCallTelemetryProperties;

    it('maps the feedback args to snake_case properties and carries the session context', () => {
        const properties = buildReportedProblemProperties(context, {
            message: 'stuck on call-actor',
            sentiment: 'negative',
            category: 'bug',
            source: 'model',
            actorId: 'apify/rag-web-browser',
            actorRunId: 'run-1',
            relatedTools: ['call-actor'],
        });

        expect(properties).toEqual({
            app: 'mcp',
            app_version: '0.5.6',
            mcp_client_name: 'test-client',
            mcp_client_version: '1.0.0',
            mcp_protocol_version: '2024-11-05',
            mcp_session_id: 'session-123',
            transport_type: 'stdio',
            mcp_url_client: 'cursor',
            message: 'stuck on call-actor',
            sentiment: 'negative',
            category: 'bug',
            source: 'model',
            actor_id: 'apify/rag-web-browser',
            actor_run_id: 'run-1',
            related_tools: ['call-actor'],
        });
    });

    it('omits optional fields that were not provided and does not leak tool-call fields', () => {
        const properties = buildReportedProblemProperties(context, {
            message: 'just a note',
            sentiment: 'neutral',
            category: 'improvement',
        });

        expect(properties).toEqual({
            app: 'mcp',
            app_version: '0.5.6',
            mcp_client_name: 'test-client',
            mcp_client_version: '1.0.0',
            mcp_protocol_version: '2024-11-05',
            mcp_session_id: 'session-123',
            transport_type: 'stdio',
            mcp_url_client: 'cursor',
            message: 'just a note',
            sentiment: 'neutral',
            category: 'improvement',
        });
        expect(properties).not.toHaveProperty('tool_name');
        expect(properties).not.toHaveProperty('actor_id');
        expect(properties).not.toHaveProperty('source');
    });
});

describe('trackReportedProblem', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('sends the MCP Reported Problem event with the Apify userId', () => {
        const properties = {
            app: 'mcp' as const,
            app_version: '0.5.6',
            mcp_client_name: 'test-client',
            mcp_client_version: '1.0.0',
            mcp_protocol_version: '2024-11-05',
            mcp_session_id: 'session-123',
            transport_type: 'stdio',
            mcp_url_client: 'cursor',
            message: 'stuck on call-actor',
            sentiment: 'negative' as const,
            category: 'bug' as const,
        };

        trackReportedProblem('test-user-123', 'DEV', properties);

        expect(mockTrack).toHaveBeenCalledWith({
            userId: 'test-user-123',
            event: 'MCP Reported Problem',
            properties,
        });
    });

    it('falls back to the session id as anonymousId when userId is null', () => {
        const properties = {
            app: 'mcp' as const,
            app_version: '0.5.6',
            mcp_client_name: 'test-client',
            mcp_client_version: '1.0.0',
            mcp_protocol_version: '2024-11-05',
            mcp_session_id: 'session-123',
            transport_type: 'stdio',
            mcp_url_client: 'cursor',
            message: 'stuck on call-actor',
            sentiment: 'negative' as const,
            category: 'bug' as const,
        };

        trackReportedProblem(null, 'DEV', properties);

        const callArgs = mockTrack.mock.calls[0][0];
        expect(callArgs.anonymousId).toBe('session-123');
        expect(callArgs).not.toHaveProperty('userId');
        expect(callArgs.event).toBe('MCP Reported Problem');
    });
});
