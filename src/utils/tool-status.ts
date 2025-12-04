import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { TOOL_STATUS } from '../const.js';
import type { ToolStatus } from '../types.js';
import { getHttpStatusCode } from './logging.js';

/**
 * Central helper to classify an error into a ToolStatus value.
 *
 * - TOOL_STATUS.ABORTED   → Request was explicitly aborted by the client.
 * - TOOL_STATUS.SOFT_FAIL → User/client errors (HTTP 4xx, InvalidParams, validation issues).
 * - TOOL_STATUS.FAILED    → Server errors (HTTP 5xx, unknown, or unexpected exceptions).
 */
export function getToolStatusFromError(error: unknown, isAborted: boolean): ToolStatus {
    if (isAborted) {
        return TOOL_STATUS.ABORTED;
    }

    const statusCode = getHttpStatusCode(error);

    // HTTP client errors (4xx) are treated as user errors
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
        return TOOL_STATUS.SOFT_FAIL;
    }

    // MCP InvalidParams errors are also user errors
    if (error instanceof McpError && error.code === ErrorCode.InvalidParams) {
        return TOOL_STATUS.SOFT_FAIL;
    }

    // Everything else is considered a server / unexpected failure
    return TOOL_STATUS.FAILED;
}
