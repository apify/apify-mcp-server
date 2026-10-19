import { describe, expect, it } from 'vitest';

import type { McpClientContext } from '../../src/mcp/client_context.js';
import {
    getRequestOriginForClient,
    isReportProblemBlockedForClient,
    resolveStoreSearchTracking,
} from '../../src/utils/mcp_clients.js';

function clientContext(clientName?: string): McpClientContext | undefined {
    if (clientName === undefined) return undefined;
    return {
        protocolVersion: '2025-06-18',
        clientInfo: { name: clientName, version: '1.0.0' },
        capabilities: {},
    };
}

describe('isReportProblemBlockedForClient', () => {
    it.each(['claude-ai', 'claude-code', 'Claude Desktop', 'Anthropic', 'anthropic-sdk'])(
        'blocks report-problem for the Anthropic client "%s"',
        (clientName) => {
            expect(isReportProblemBlockedForClient(clientContext(clientName))).toBe(true);
        },
    );

    it.each(['cursor', 'test-client', 'vscode', ''])(
        'serves report-problem to the non-Anthropic client "%s"',
        (clientName) => {
            expect(isReportProblemBlockedForClient(clientContext(clientName))).toBe(false);
        },
    );

    it('does not block when there is no initialize request data', () => {
        expect(isReportProblemBlockedForClient(undefined)).toBe(false);
    });
});

describe('getRequestOriginForClient()', () => {
    it('maps the Apify AI agent client to APIFY_AI', () => {
        expect(getRequestOriginForClient(clientContext('apify-ai'))).toBe('APIFY_AI');
    });

    it.each(['cursor', 'claude-ai', 'vscode', ''])('maps the unrelated client "%s" to MCP', (clientName) => {
        expect(getRequestOriginForClient(clientContext(clientName))).toBe('MCP');
    });

    it.each(['apify-ai-v2', 'Apify-AI', 'apify'])(
        'maps the near-miss client "%s" to MCP (exact match only)',
        (clientName) => {
            expect(getRequestOriginForClient(clientContext(clientName))).toBe('MCP');
        },
    );

    it('maps the retired Console AI chat name to MCP', () => {
        expect(getRequestOriginForClient(clientContext('apify-console-ai-chat'))).toBe('MCP');
    });

    it('maps a missing initialize request to MCP', () => {
        expect(getRequestOriginForClient(undefined)).toBe('MCP');
    });
});

describe('resolveStoreSearchTracking()', () => {
    const meta = { 'com.apify/traceId': 'thread-1', 'com.apify/useCase': '  find a scraper  ' };

    it('takes the trace id and use case from _meta for Apify AI, falling back to the session id', () => {
        expect(resolveStoreSearchTracking('APIFY_AI', meta, 'session-1')).toEqual({
            traceId: 'thread-1',
            useCase: 'find a scraper',
        });
        expect(resolveStoreSearchTracking('APIFY_AI', { 'com.apify/traceId': ' ' }, 'session-1').traceId).toBe(
            'session-1',
        );
    });

    it('uses only the session id for other clients', () => {
        expect(resolveStoreSearchTracking('MCP', meta, 'session-1')).toEqual({
            traceId: 'session-1',
            useCase: undefined,
        });
    });

    it('omits a trace id over 256 UTF-16 units', () => {
        expect(
            resolveStoreSearchTracking('APIFY_AI', { 'com.apify/traceId': 'x'.repeat(257) }, undefined).traceId,
        ).toBe(undefined);
    });

    it('omits an empty session id as the trace id', () => {
        expect(resolveStoreSearchTracking('MCP', undefined, '').traceId).toBe(undefined);
    });

    it('truncates the use case to 1024 UTF-16 units without splitting a surrogate pair', () => {
        const useCase = `${'a'.repeat(1023)}😀`;
        expect(resolveStoreSearchTracking('APIFY_AI', { 'com.apify/useCase': useCase }, undefined).useCase).toBe(
            'a'.repeat(1023),
        );
    });
});
