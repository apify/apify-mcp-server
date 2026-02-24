import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

import { TOOL_STATUS } from '../../src/const.js';
import { getToolStatusFromError } from '../../src/utils/tool-status.js';

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
