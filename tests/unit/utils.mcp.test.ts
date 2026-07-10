import { ApifyApiError } from 'apify-client';
import { describe, expect, it } from 'vitest';

import { FAILURE_CATEGORY, TOOL_STATUS } from '../../src/const.js';
import { wrapJsonText } from '../../src/utils/encode_text.js';
import {
    computeToolResponseBytes,
    getToolCallErrorUserText,
    injectMcpSessionId,
    respondErrorNoTelemetry,
    respondJson,
    respondOk,
    respondServerError,
    respondUserError,
} from '../../src/utils/mcp.js';

describe('injectMcpSessionId()', () => {
    it('returns a new params object with _meta.mcpSessionId when params is undefined', () => {
        const result = injectMcpSessionId(undefined, 'session-123');
        expect(result).toEqual({
            _meta: { mcpSessionId: 'session-123' },
        });
        expect(typeof result).toBe('object');
    });

    it('mutates and returns the same object when params exists without _meta', () => {
        const input = { foo: 'bar' };
        const result = injectMcpSessionId(input, 'session-456');
        expect(result === input).toBe(true);
        expect(result).toEqual({
            foo: 'bar',
            _meta: { mcpSessionId: 'session-456' },
        });
    });

    it('preserves existing _meta fields when setting mcpSessionId', () => {
        const input = {
            someParam: 'value',
            _meta: {
                apifyToken: 'token-abc',
                progressToken: 'progress-xyz',
            },
        };
        const result = injectMcpSessionId(input, 'session-789');
        expect(result === input).toBe(true);
        expect(result._meta).toEqual({
            apifyToken: 'token-abc',
            progressToken: 'progress-xyz',
            mcpSessionId: 'session-789',
        });
    });

    it('overwrites an existing mcpSessionId with the new value', () => {
        const input = {
            _meta: {
                mcpSessionId: 'old-session',
                apifyToken: 'token',
            },
        };
        const result = injectMcpSessionId(input, 'new-session');
        expect(result === input).toBe(true);
        expect(result._meta?.mcpSessionId).toBe('new-session');
        expect(result._meta?.apifyToken).toBe('token');
    });
});

describe('respondOk()', () => {
    it('returns a success response with the raw text and no isError/telemetry', () => {
        const result = respondOk('all good');
        expect(result).toEqual({ content: [{ type: 'text', text: 'all good' }], isError: false });
        expect('toolTelemetry' in result).toBe(false);
        expect('structuredContent' in result).toBe(false);
        expect('_meta' in result).toBe(false);
    });

    it('keeps bare JSON bare in content[0] (no fence) — the raw-JSON mirror channel', () => {
        const structuredContent = { runId: 'r1', status: 'RUNNING' };
        const result = respondOk([JSON.stringify(structuredContent), 'summary'], { structuredContent });
        expect(result.content[0].text).toBe('{"runId":"r1","status":"RUNNING"}');
        expect(result.content[0].text.startsWith('```')).toBe(false);
        expect(result.structuredContent).toEqual(structuredContent);
    });

    it('maps meta to _meta and omits it when undefined', () => {
        expect(respondOk('x', { meta: { 'openai/foo': 1 } })._meta).toEqual({ 'openai/foo': 1 });
        expect('_meta' in respondOk('x', { meta: undefined })).toBe(false);
    });
});

describe('respondJson()', () => {
    it('wraps the value in a ```json fence via wrapJsonText', () => {
        const value = { a: 1, b: [2, 3] };
        const result = respondJson(value);
        expect(result.content).toEqual([{ type: 'text', text: wrapJsonText(value) }]);
        expect(result.content[0].text.startsWith('```json\n')).toBe(true);
        expect(result.isError).toBe(false);
        expect('toolTelemetry' in result).toBe(false);
    });

    it('carries structuredContent and meta when provided', () => {
        const result = respondJson({ a: 1 }, { structuredContent: { a: 1 }, meta: { k: 'v' } });
        expect(result.structuredContent).toEqual({ a: 1 });
        expect(result._meta).toEqual({ k: 'v' });
    });
});

describe('respondErrorNoTelemetry()', () => {
    it('returns an isError response with no toolTelemetry (framework paths)', () => {
        const result = respondErrorNoTelemetry('failed');
        expect(result).toEqual({ content: [{ type: 'text', text: 'failed' }], isError: true });
        expect('toolTelemetry' in result).toBe(false);
    });

    it('carries structuredContent when provided, still no telemetry', () => {
        const result = respondErrorNoTelemetry(['{"x":1}', 'note'], { structuredContent: { x: 1 } });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toEqual({ x: 1 });
        expect('toolTelemetry' in result).toBe(false);
    });
});

describe('respondUserError()', () => {
    it('defaults to SOFT_FAIL + INVALID_INPUT with only those telemetry fields', () => {
        const result = respondUserError('bad input');
        expect(result.isError).toBe(true);
        expect(result.content).toEqual([{ type: 'text', text: 'bad input' }]);
        expect(result.toolTelemetry).toEqual({
            toolStatus: TOOL_STATUS.SOFT_FAIL,
            failureCategory: FAILURE_CATEGORY.INVALID_INPUT,
        });
    });

    it('accepts an explicit non-internal category (PERMISSION_APPROVAL_REQUIRED)', () => {
        const result = respondUserError(['line1', 'line2'], {
            category: FAILURE_CATEGORY.PERMISSION_APPROVAL_REQUIRED,
            httpStatus: 403,
            detail: 'full-permission-actor-not-approved',
            actorId: 'actor-1',
        });
        expect(result.content).toHaveLength(2);
        expect(result.toolTelemetry).toEqual({
            toolStatus: TOOL_STATUS.SOFT_FAIL,
            failureCategory: FAILURE_CATEGORY.PERMISSION_APPROVAL_REQUIRED,
            failureHttpStatus: 403,
            failureDetail: 'full-permission-actor-not-approved',
            actorId: 'actor-1',
        });
    });

    it('omits each optional telemetry field when undefined', () => {
        const result = respondUserError('x', { httpStatus: 404 });
        expect(result.toolTelemetry).toEqual({
            toolStatus: TOOL_STATUS.SOFT_FAIL,
            failureCategory: FAILURE_CATEGORY.INVALID_INPUT,
            failureHttpStatus: 404,
        });
        expect('failureDetail' in (result.toolTelemetry ?? {})).toBe(false);
        expect('actorId' in (result.toolTelemetry ?? {})).toBe(false);
        expect('ajvErrorDetails' in (result.toolTelemetry ?? {})).toBe(false);
    });

    it('carries structuredContent when provided', () => {
        const result = respondUserError('x', { structuredContent: { foo: 1 } });
        expect(result.structuredContent).toEqual({ foo: 1 });
    });
});

describe('respondServerError()', () => {
    it('derives FAILED + INTERNAL_ERROR when given no error', () => {
        const result = respondServerError('server broke');
        expect(result.isError).toBe(true);
        expect(result.content).toEqual([{ type: 'text', text: 'server broke' }]);
        expect(result.toolTelemetry).toMatchObject({
            toolStatus: TOOL_STATUS.FAILED,
            failureCategory: FAILURE_CATEGORY.INTERNAL_ERROR,
        });
    });

    it('derives SOFT_FAIL + INVALID_INPUT for a 404 error', () => {
        const error = Object.assign(new Error('Not found'), { statusCode: 404 });
        expect(respondServerError('x', { error }).toolTelemetry).toMatchObject({
            toolStatus: TOOL_STATUS.SOFT_FAIL,
            failureCategory: FAILURE_CATEGORY.INVALID_INPUT,
            failureHttpStatus: 404,
        });
    });

    it('derives SOFT_FAIL + INVALID_INPUT for a run-limit error wrapped as 5xx', () => {
        const error = Object.assign(new Error('Streamable HTTP error: cannot-start-actor-runs'), { statusCode: 500 });
        expect(respondServerError('x', { error }).toolTelemetry).toMatchObject({
            toolStatus: TOOL_STATUS.SOFT_FAIL,
            failureCategory: FAILURE_CATEGORY.INVALID_INPUT,
        });
    });

    it('derives FAILED + INTERNAL_ERROR for a 5xx error', () => {
        const error = Object.assign(new Error('Internal'), { statusCode: 500 });
        expect(respondServerError('x', { error }).toolTelemetry).toMatchObject({
            toolStatus: TOOL_STATUS.FAILED,
            failureCategory: FAILURE_CATEGORY.INTERNAL_ERROR,
            failureHttpStatus: 500,
        });
    });

    it('adds detail and actorId to telemetry when provided, omits them otherwise', () => {
        const error = Object.assign(new Error('boom'), { statusCode: 500 });
        const withOpts = respondServerError('x', { error, detail: 'memory-limit-exceeded', actorId: 'a1' });
        expect(withOpts.toolTelemetry).toMatchObject({ failureDetail: 'memory-limit-exceeded', actorId: 'a1' });

        const withoutOpts = respondServerError('x', { error });
        expect('failureDetail' in (withoutOpts.toolTelemetry ?? {})).toBe(false);
        expect('actorId' in (withoutOpts.toolTelemetry ?? {})).toBe(false);
    });

    it('reproduces the generic buildCallActorErrorResponse telemetry shape byte-for-byte', () => {
        // The generic call-actor error branch is `respondServerError(texts, { error, detail, actorId })`.
        const error = new ApifyApiError({ data: { error: { type: 'x', message: 'boom' } }, status: 500 } as never, 1);
        const result = respondServerError(['Failed to call Actor', 'verify'], {
            error,
            detail: 'boom',
            actorId: 'actor-1',
        });
        expect(result.toolTelemetry).toEqual({
            toolStatus: TOOL_STATUS.FAILED,
            failureCategory: FAILURE_CATEGORY.INTERNAL_ERROR,
            failureHttpStatus: 500,
            failureDetail: 'boom',
            actorId: 'actor-1',
        });
    });
});

describe('getToolCallErrorUserText()', () => {
    it('returns the concurrent-run-limit hint when a direct Actor tool hits the limit', () => {
        const error = Object.assign(new Error('Cannot start new Actor runs.'), { type: 'cannot-start-actor-runs' });
        const text = getToolCallErrorUserText('apify/instagram-scraper', error);
        expect(text).toContain('account limit for concurrent Actor runs');
        expect(text).toContain('console.apify.com/billing/subscription');
        expect(text).not.toContain('Verify the tool name');
    });
});

describe('computeToolResponseBytes()', () => {
    it('returns zero for null/undefined/non-object input', () => {
        expect(computeToolResponseBytes(null)).toEqual({ contentBytes: 0, structuredContentBytes: 0, fileBytes: 0 });
        expect(computeToolResponseBytes(undefined)).toEqual({
            contentBytes: 0,
            structuredContentBytes: 0,
            fileBytes: 0,
        });
        expect(computeToolResponseBytes('text')).toEqual({ contentBytes: 0, structuredContentBytes: 0, fileBytes: 0 });
        expect(computeToolResponseBytes(42)).toEqual({ contentBytes: 0, structuredContentBytes: 0, fileBytes: 0 });
    });

    it('returns zero for empty result object', () => {
        expect(computeToolResponseBytes({})).toEqual({ contentBytes: 0, structuredContentBytes: 0, fileBytes: 0 });
    });

    it('sums UTF-8 byte length of every text item in content[]', () => {
        const result = {
            content: [
                { type: 'text', text: 'hello' },
                { type: 'text', text: 'world' },
            ],
        };
        // "hello" = 5 bytes, "world" = 5 bytes -> 10
        expect(computeToolResponseBytes(result)).toEqual({ contentBytes: 10, structuredContentBytes: 0, fileBytes: 0 });
    });

    it('counts multi-byte UTF-8 characters correctly', () => {
        const result = {
            content: [{ type: 'text', text: 'café' }], // c=1 a=1 f=1 é=2 → 5 bytes
        };
        expect(computeToolResponseBytes(result)).toEqual({ contentBytes: 5, structuredContentBytes: 0, fileBytes: 0 });
    });

    it('reports content and structuredContent bytes separately', () => {
        const result = {
            content: [{ type: 'text', text: 'ok' }],
            structuredContent: { url: 'https://x' },
        };
        expect(computeToolResponseBytes(result)).toEqual({
            contentBytes: Buffer.byteLength('ok', 'utf8'),
            structuredContentBytes: Buffer.byteLength(JSON.stringify({ url: 'https://x' }), 'utf8'),
            fileBytes: 0,
        });
    });

    it('counts image/audio base64 data as file bytes, not content bytes', () => {
        const result = {
            content: [
                { type: 'image', data: 'base64img' },
                { type: 'text', text: 'hi' },
            ],
        };
        // "base64img" = 9 file bytes; "hi" = 2 content bytes — kept in separate buckets.
        expect(computeToolResponseBytes(result)).toEqual({ contentBytes: 2, structuredContentBytes: 0, fileBytes: 9 });
    });

    it('counts embedded resource blob and text as file bytes', () => {
        const result = {
            content: [
                { type: 'resource', resource: { uri: 'https://x', blob: 'AAAA', mimeType: 'application/pdf' } },
                { type: 'resource', resource: { uri: 'https://y', text: 'hello' } },
            ],
        };
        // "AAAA" = 4 + "hello" = 5 -> 9 file bytes (uri/mimeType are metadata, not payload)
        expect(computeToolResponseBytes(result)).toEqual({ contentBytes: 0, structuredContentBytes: 0, fileBytes: 9 });
    });

    it('handles structuredContent without content[]', () => {
        const result = { structuredContent: { a: 1 } };
        expect(computeToolResponseBytes(result)).toEqual({
            contentBytes: 0,
            structuredContentBytes: Buffer.byteLength(JSON.stringify({ a: 1 }), 'utf8'),
            fileBytes: 0,
        });
    });

    it('reports zero structuredContent bytes when not JSON-serialisable', () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        const result = { structuredContent: circular };
        expect(computeToolResponseBytes(result)).toEqual({ contentBytes: 0, structuredContentBytes: 0, fileBytes: 0 });
    });
});
