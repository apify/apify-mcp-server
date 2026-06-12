import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { describe, expect, it } from 'vitest';

import {
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

describe('remoteMcpFailureDetail', () => {
    it('returns the billing message for the wrapped concurrent-run limit', () => {
        const detail = remoteMcpFailureDetail(
            new Error('Streamable HTTP error: ... "type": "cannot-start-actor-runs"'),
        );
        expect(detail).toContain('concurrent Actor runs');
        expect(detail).toContain('console.apify.com/billing/subscription');
    });

    it('echoes the error with the generic availability hint otherwise', () => {
        expect(remoteMcpFailureDetail(new Error('socket hang up'))).toBe(
            'socket hang up. The MCP server may be temporarily unavailable.',
        );
    });
});
