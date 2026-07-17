import type { InitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

import { isReportProblemBlockedForClient } from '../../src/utils/mcp_clients.js';

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
