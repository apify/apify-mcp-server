import type { InitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

import { getRequestOriginForClient, isReportProblemBlockedForClient } from '../../src/utils/mcp_clients.js';

function initRequest(clientName?: string): InitializeRequest | undefined {
    if (clientName === undefined) return undefined;
    return {
        method: 'initialize',
        params: {
            protocolVersion: '2025-06-18',
            clientInfo: { name: clientName, version: '1.0.0' },
            capabilities: {},
        },
    } as InitializeRequest;
}

describe('isReportProblemBlockedForClient', () => {
    it.each(['claude-ai', 'claude-code', 'Claude Desktop', 'Anthropic', 'anthropic-sdk'])(
        'blocks report-problem for the Anthropic client "%s"',
        (clientName) => {
            expect(isReportProblemBlockedForClient(initRequest(clientName))).toBe(true);
        },
    );

    it.each(['cursor', 'test-client', 'vscode', ''])(
        'serves report-problem to the non-Anthropic client "%s"',
        (clientName) => {
            expect(isReportProblemBlockedForClient(initRequest(clientName))).toBe(false);
        },
    );

    it('does not block when there is no initialize request data', () => {
        expect(isReportProblemBlockedForClient(undefined)).toBe(false);
    });
});

describe('getRequestOriginForClient()', () => {
    it('maps the Apify Console AI chat client to APIFY_AI', () => {
        expect(getRequestOriginForClient(initRequest('apify-console-ai-chat'))).toBe('APIFY_AI');
    });

    it.each(['cursor', 'claude-ai', 'vscode', ''])('maps the unrelated client "%s" to MCP', (clientName) => {
        expect(getRequestOriginForClient(initRequest(clientName))).toBe('MCP');
    });

    it.each(['apify-console-ai-chat-v2', 'Apify-Console-AI-Chat'])(
        'maps the near-miss client "%s" to MCP (exact match only)',
        (clientName) => {
            expect(getRequestOriginForClient(initRequest(clientName))).toBe('MCP');
        },
    );

    it('maps a missing initialize request to MCP', () => {
        expect(getRequestOriginForClient(undefined)).toBe('MCP');
    });
});
