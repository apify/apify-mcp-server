import type { InitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

import { isAnthropicClient } from '../../src/utils/mcp_clients.js';

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

describe('isAnthropicClient', () => {
    it.each(['claude-ai', 'claude-code', 'Claude Desktop', 'Anthropic', 'anthropic-sdk'])(
        'treats "%s" as an Anthropic client',
        (clientName) => {
            expect(isAnthropicClient(initRequest(clientName))).toBe(true);
        },
    );

    it.each(['cursor', 'test-client', 'vscode', ''])('treats "%s" as a non-Anthropic client', (clientName) => {
        expect(isAnthropicClient(initRequest(clientName))).toBe(false);
    });

    it('returns false when there is no initialize request data', () => {
        expect(isAnthropicClient(undefined)).toBe(false);
    });
});
