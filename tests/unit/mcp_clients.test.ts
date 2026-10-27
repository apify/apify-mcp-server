import { describe, expect, it } from 'vitest';

import type { McpClientContext } from '../../src/mcp/client_context.js';
import {
    getRequestOriginForClient,
    isReportProblemBlockedForClient,
    isStoreUseCaseServable,
    resolveStoreSearchTracking,
    sanitizeUseCase,
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
    const meta = { 'com.apify/traceId': 'thread-1', 'com.apify/useCase': 'find a scraper' };

    it('takes the trace id from _meta for Apify AI, falling back to the session id', () => {
        expect(resolveStoreSearchTracking('APIFY_AI', meta, 'session-1')).toEqual({ traceId: 'thread-1' });
        expect(resolveStoreSearchTracking('APIFY_AI', { 'com.apify/traceId': ' ' }, 'session-1').traceId).toBe(
            'session-1',
        );
    });

    it('uses only the session id for other clients, and never a use case from _meta', () => {
        expect(resolveStoreSearchTracking('MCP', meta, 'session-1')).toEqual({ traceId: 'session-1' });
        expect(resolveStoreSearchTracking('APIFY_AI', meta, 'session-1')).not.toHaveProperty('useCase');
    });

    it('keeps a trace id of 256 UTF-16 units and omits a longer one', () => {
        const traceId = (length: number) =>
            resolveStoreSearchTracking('APIFY_AI', { 'com.apify/traceId': 'x'.repeat(length) }, undefined).traceId;
        expect(traceId(256)).toBe('x'.repeat(256));
        expect(traceId(257)).toBe(undefined);
    });

    it('omits an empty session id as the trace id', () => {
        expect(resolveStoreSearchTracking('MCP', undefined, '').traceId).toBe(undefined);
    });
});

describe('sanitizeUseCase()', () => {
    it('trims, and drops anything that is not text or is empty', () => {
        expect(sanitizeUseCase('  find a scraper  ')).toBe('find a scraper');
        expect(sanitizeUseCase('   ')).toBe(undefined);
        expect(sanitizeUseCase('')).toBe(undefined);
        expect(sanitizeUseCase(undefined)).toBe(undefined);
        expect(sanitizeUseCase(42)).toBe(undefined);
        expect(sanitizeUseCase({ text: 'x' })).toBe(undefined);
    });

    it('truncates to 1024 UTF-16 units without splitting a surrogate pair', () => {
        expect(sanitizeUseCase(`${'a'.repeat(1023)}😀`)).toBe('a'.repeat(1023));
        expect(sanitizeUseCase('a'.repeat(2000))).toBe('a'.repeat(1024));
    });

    it('redacts Apify API tokens before cutting', () => {
        expect(sanitizeUseCase(`${'a'.repeat(1011)} apify_api_${'x'.repeat(36)}`)).toBe(
            `${'a'.repeat(1011)} apify_api_**`,
        );
    });
});

describe('isStoreUseCaseServable()', () => {
    const servable = (clientName: string | undefined, clientParam?: string) =>
        isStoreUseCaseServable(clientContext(clientName), clientParam);

    it.each(['apify-ai', 'cursor', 'Visual Studio Code'])('serves %s', (name) => {
        expect(servable(name)).toBe(true);
    });

    it.each(['Claude Desktop', 'claude-code', 'Anthropic', 'local-agent-mode-apify'])('does not serve %s', (name) => {
        expect(servable(name)).toBe(false);
    });

    it('does not serve a client that declares no name, an empty name, or no initialize at all', () => {
        expect(servable('')).toBe(false);
        expect(servable('   ')).toBe(false);
        expect(servable(undefined)).toBe(false);
    });

    it('does not serve a connection opened with ?client=claude, whatever name it declares', () => {
        expect(servable('cursor', 'Claude-Desktop')).toBe(false);
        expect(servable('cursor', 'vscode')).toBe(true);
    });
});
