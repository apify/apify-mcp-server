import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { describe, expect, it } from 'vitest';

import {
    isActorInputValidationError,
    isActorRunLimitError,
    isMemoryQuotaError,
    isPermissionApprovalError,
    remoteMcpFailureDetail,
} from '../../src/utils/apify_errors.js';

function apifyApiError(type: string, status = 402): ApifyApiError {
    return new ApifyApiError({ data: { error: { type, message: type } }, status } as AxiosResponse, 1);
}

describe('isActorRunLimitError', () => {
    it('matches by `type` field (direct run) or message substring (wrapped MCP error), not unrelated errors', () => {
        expect(isActorRunLimitError({ type: 'cannot-start-actor-runs', message: 'Cannot start new Actor runs.' })).toBe(
            true,
        );
        expect(isActorRunLimitError(new Error('Streamable HTTP error: ... "type": "cannot-start-actor-runs"'))).toBe(
            true,
        );
        expect(isActorRunLimitError(new Error('socket hang up'))).toBe(false);
        expect(isActorRunLimitError({ type: 'memory-limit-exceeded' })).toBe(false);
    });
});

describe('isMemoryQuotaError', () => {
    it('matches only the memory-limit ApifyApiError type', () => {
        expect(isMemoryQuotaError(apifyApiError('memory-limit-exceeded'))).toBe(true);
        expect(isMemoryQuotaError(apifyApiError('cannot-start-actor-runs'))).toBe(false);
        expect(isMemoryQuotaError(new Error('memory-limit-exceeded'))).toBe(false);
    });
});

describe('isPermissionApprovalError', () => {
    it('matches only the full-permission-not-approved ApifyApiError type', () => {
        expect(isPermissionApprovalError(apifyApiError('full-permission-actor-not-approved', 403))).toBe(true);
        expect(isPermissionApprovalError(apifyApiError('memory-limit-exceeded'))).toBe(false);
    });
});

describe('isActorInputValidationError', () => {
    it('matches only the invalid-input ApifyApiError type, not the sibling invalid-input-schema type', () => {
        expect(isActorInputValidationError(apifyApiError('invalid-input', 400))).toBe(true);
        expect(isActorInputValidationError(apifyApiError('invalid-input-schema', 400))).toBe(false);
        expect(isActorInputValidationError(new Error('Input is not valid'))).toBe(false);
    });
});

describe('remoteMcpFailureDetail', () => {
    it('returns the billing message for the wrapped concurrent-run limit', () => {
        const detail = remoteMcpFailureDetail(
            new Error('Streamable HTTP error: ... "type": "cannot-start-actor-runs"'),
        );
        expect(detail).toContain('concurrent Actor runs');
        expect(detail).toContain('console.apify.com/billing/subscription');
    });

    it.each([
        ['the connection closed', new McpError(ErrorCode.ConnectionClosed, 'Connection closed')],
        ['the request timed out', new McpError(ErrorCode.RequestTimeout, 'Request timed out')],
        ['a socket failed', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
        ['fetch failed', new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:443') })],
        ['the transport got a 5xx', new StreamableHTTPError(503, 'Error POSTing to endpoint: Service Unavailable')],
    ])('adds the availability hint when %s', (_label, error) => {
        expect(remoteMcpFailureDetail(error)).toBe(`${error.message}. The MCP server may be temporarily unavailable.`);
    });

    it.each([
        ['a JSON-RPC error', new McpError(ErrorCode.InvalidParams, 'Tool subtract not found')],
        ['a 4xx', new StreamableHTTPError(403, 'Error POSTing to endpoint: Forbidden')],
    ])('echoes %s the server answered with, without the availability hint', (_label, error) => {
        expect(remoteMcpFailureDetail(error)).toBe(`${error.message}.`);
    });
});
