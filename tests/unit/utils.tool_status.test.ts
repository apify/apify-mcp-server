import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

import { FAILURE_CATEGORY, TOOL_STATUS } from '../../src/const.js';
import {
    classifyFailureCategory,
    extractAjvErrorDetails,
    extractToolTelemetry,
    getToolStatusFromError,
} from '../../src/utils/tool_status.js';

describe('getToolStatusFromError', () => {
    it('returns aborted when isAborted is true', () => {
        const status = getToolStatusFromError(new Error('any'), true);
        expect(status).toBe(TOOL_STATUS.ABORTED);
    });

    it('classifies HTTP 4xx errors as soft_fail', () => {
        const error = Object.assign(new Error('Bad Request'), { statusCode: 400 });
        const status = getToolStatusFromError(error, false);
        expect(status).toBe(TOOL_STATUS.SOFT_FAIL);
    });

    it('classifies HTTP 5xx errors as failed', () => {
        const error = Object.assign(new Error('Internal Error'), { statusCode: 500 });
        const status = getToolStatusFromError(error, false);
        expect(status).toBe(TOOL_STATUS.FAILED);
    });

    it('classifies McpError InvalidParams as soft_fail', () => {
        const error = new McpError(ErrorCode.InvalidParams, 'invalid', undefined);
        const status = getToolStatusFromError(error, false);
        expect(status).toBe(TOOL_STATUS.SOFT_FAIL);
    });

    it('classifies unknown errors without status code as failed', () => {
        const status = getToolStatusFromError(new Error('unknown'), false);
        expect(status).toBe(TOOL_STATUS.FAILED);
    });
});

describe('classifyFailureCategory', () => {
    it('classifies invalid params as INVALID_INPUT', () => {
        const category = classifyFailureCategory(new McpError(ErrorCode.InvalidParams, 'invalid', undefined));
        expect(category).toBe(FAILURE_CATEGORY.INVALID_INPUT);
    });

    it('classifies 401 as AUTH', () => {
        const category = classifyFailureCategory(Object.assign(new Error('Unauthorized'), { statusCode: 401 }));
        expect(category).toBe(FAILURE_CATEGORY.AUTH);
    });

    it('classifies 403 as AUTH', () => {
        const category = classifyFailureCategory(Object.assign(new Error('Forbidden'), { statusCode: 403 }));
        expect(category).toBe(FAILURE_CATEGORY.AUTH);
    });

    it('classifies 404 as INVALID_INPUT', () => {
        const category = classifyFailureCategory(Object.assign(new Error('Not found'), { statusCode: 404 }));
        expect(category).toBe(FAILURE_CATEGORY.INVALID_INPUT);
    });

    it('classifies generic 4xx as INVALID_INPUT', () => {
        const category = classifyFailureCategory(Object.assign(new Error('Bad request'), { statusCode: 402 }));
        expect(category).toBe(FAILURE_CATEGORY.INVALID_INPUT);
    });

    it('classifies 5xx as INTERNAL_ERROR', () => {
        const category = classifyFailureCategory(Object.assign(new Error('Internal'), { statusCode: 500 }));
        expect(category).toBe(FAILURE_CATEGORY.INTERNAL_ERROR);
    });

    it('classifies unexpected errors as INTERNAL_ERROR', () => {
        const category = classifyFailureCategory(new Error('connect ECONNREFUSED 127.0.0.1'));
        expect(category).toBe(FAILURE_CATEGORY.INTERNAL_ERROR);
    });
});

describe('extractAjvErrorDetails', () => {
    it('extracts required-property diagnostics', () => {
        const diagnostics = extractAjvErrorDetails([
            {
                keyword: 'required',
                instancePath: '',
                schemaPath: '#/required',
                params: { missingProperty: 'query' },
                message: 'must have required property',
            },
        ]);

        expect(diagnostics).toEqual({
            validation_keyword: 'required',
            validation_path: undefined,
            validation_missing_property: 'query',
            validation_error_count: 1,
        });
    });

    it('extracts additional-property diagnostics', () => {
        const diagnostics = extractAjvErrorDetails([
            {
                keyword: 'additionalProperties',
                instancePath: '/output',
                schemaPath: '#/additionalProperties',
                params: { additionalProperty: 'docSource' },
                message: 'must NOT have additional properties',
            },
        ]);

        expect(diagnostics.validation_additional_property).toBe('docSource');
        expect(diagnostics.validation_path).toBe('/output');
        expect(diagnostics.validation_error_count).toBe(1);
    });

    it('reports error count for multiple validation errors', () => {
        const diagnostics = extractAjvErrorDetails([
            { keyword: 'required', instancePath: '', schemaPath: '#/required', params: { missingProperty: 'query' }, message: '' },
            { keyword: 'required', instancePath: '', schemaPath: '#/required', params: { missingProperty: 'url' }, message: '' },
            { keyword: 'type', instancePath: '/limit', schemaPath: '#/type', params: { type: 'number' }, message: '' },
        ]);

        // First error is the canonical summary
        expect(diagnostics.validation_keyword).toBe('required');
        expect(diagnostics.validation_missing_property).toBe('query');
        // Count reflects all errors
        expect(diagnostics.validation_error_count).toBe(3);
    });

    it('returns empty for null/undefined errors', () => {
        expect(extractAjvErrorDetails(null)).toEqual({});
        expect(extractAjvErrorDetails(undefined)).toEqual({});
        expect(extractAjvErrorDetails([])).toEqual({});
    });
});

describe('extractToolTelemetry', () => {
    it('reads toolTelemetry, strips it, and maps to callDiagnostics', () => {
        const res: Record<string, unknown> = {
            content: 'ok',
            toolTelemetry: {
                toolStatus: TOOL_STATUS.SOFT_FAIL,
                failureCategory: FAILURE_CATEGORY.INVALID_INPUT,
                failureHttpStatus: 404,
            },
        };

        const { toolStatus, callDiagnostics } = extractToolTelemetry(res, 'apify/web-scraper', 'abc123');

        expect(toolStatus).toBe(TOOL_STATUS.SOFT_FAIL);
        expect(callDiagnostics).toMatchObject(
            { failure_category: FAILURE_CATEGORY.INVALID_INPUT, failure_http_status: 404, actor_name: 'apify/web-scraper', actor_id: 'abc123' },
        );
        expect(res.toolTelemetry).toBeUndefined();
        expect(res.content).toBe('ok');
    });

    it('defaults to SOFT_FAIL when isError without toolTelemetry', () => {
        const { toolStatus, callDiagnostics } = extractToolTelemetry({ isError: true }, undefined, undefined);
        expect(toolStatus).toBe(TOOL_STATUS.SOFT_FAIL);
        expect(callDiagnostics.failure_category).toBe(FAILURE_CATEGORY.INTERNAL_ERROR);
    });

    it('returns SUCCEEDED when no error signals', () => {
        const { toolStatus, callDiagnostics } = extractToolTelemetry({ content: 'ok' }, undefined, undefined);
        expect(toolStatus).toBe(TOOL_STATUS.SUCCEEDED);
        expect(callDiagnostics).toEqual({});
    });
});
