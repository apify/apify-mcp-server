import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

import { FAILURE_CATEGORY, TOOL_STATUS } from '../../src/const.js';
import { classifyFailureCategory, extractValidationDiagnostics, getToolStatusFromError } from '../../src/utils/tool_status.js';

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

    it('classifies 404 as INVALID_INPUT', () => {
        const category = classifyFailureCategory(Object.assign(new Error('Not found'), { statusCode: 404 }));
        expect(category).toBe(FAILURE_CATEGORY.INVALID_INPUT);
    });

    it('classifies generic 4xx as INVALID_INPUT', () => {
        const category = classifyFailureCategory(Object.assign(new Error('Bad request'), { statusCode: 402 }));
        expect(category).toBe(FAILURE_CATEGORY.INVALID_INPUT);
    });

    it('classifies unexpected errors as INTERNAL_ERROR', () => {
        const category = classifyFailureCategory(new Error('connect ECONNREFUSED 127.0.0.1'));
        expect(category).toBe(FAILURE_CATEGORY.INTERNAL_ERROR);
    });
});

describe('extractValidationDiagnostics', () => {
    it('extracts required-property diagnostics', () => {
        const diagnostics = extractValidationDiagnostics([
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
        });
    });

    it('extracts additional-property diagnostics', () => {
        const diagnostics = extractValidationDiagnostics([
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
    });
});
