import { FAILURE_CATEGORY, TOOL_STATUS } from '../const.js';
import type { CallDiagnostics, ToolStatus } from '../types.js';
import { isPermissionApprovalError } from '../utils/apify_errors.js';
import { getHttpStatusCode } from '../utils/logging.js';
import type { ToolResponse } from '../utils/mcp.js';
import { getToolCallErrorUserText } from '../utils/mcp.js';
import {
    buildPaymentRequiredResponse,
    buildPermissionApprovalResponse,
    isX402PaymentRequiredError,
} from '../utils/payment_errors.js';
import { classifyFailureCategory, getToolStatusFromError } from '../utils/tool_status.js';
import { buildActorFields } from '../utils/tools.js';

/** Inputs the mapper can't derive itself — they differ per caller. */
export type ToolCallErrorParams = {
    toolName: string;
    actorName?: string;
    actorId?: string;
    isAborted: boolean;
};

/** Discriminants of `ToolCallErrorResult` — reference these, never string literals. */
export const TOOL_CALL_ERROR_KIND = {
    PAYMENT: 'payment',
    APPROVAL: 'approval',
    EXECUTION: 'execution',
} as const;
export type TOOL_CALL_ERROR_KIND = (typeof TOOL_CALL_ERROR_KIND)[keyof typeof TOOL_CALL_ERROR_KIND];

/** Shared shape for the two branches that carry a ready-to-return `response` (402 and approval). */
type ResponseErrorResult = {
    toolStatus: ToolStatus;
    callDiagnostics: CallDiagnostics;
    response: ToolResponse;
};

/**
 * The three-way classification shared by both `server.ts` tool-call catches. `payment`/`approval`
 * carry a ready-to-return `response`; `execution` carries the user-facing `userText`. The catch
 * blocks own everything else (logging, store writes, cancel guards, wire-field wrapping).
 */
export type ToolCallErrorResult =
    | ({ kind: typeof TOOL_CALL_ERROR_KIND.PAYMENT } & ResponseErrorResult)
    | ({ kind: typeof TOOL_CALL_ERROR_KIND.APPROVAL } & ResponseErrorResult)
    | {
          kind: typeof TOOL_CALL_ERROR_KIND.EXECUTION;
          toolStatus: ToolStatus;
          callDiagnostics: CallDiagnostics;
          userText: string;
      };

/**
 * Classifies a tool-call error into a 402 payment / permission-approval / generic execution result.
 * Pure: never throws, logs, or touches the task store. An HTTP-range-coded error — including an
 * `McpError` with code 402 — classifies as PAYMENT, since `getHttpStatusCode` falls through to `.code`.
 */
export function buildToolCallErrorResult(error: unknown, params: ToolCallErrorParams): ToolCallErrorResult {
    const { toolName, actorName, actorId, isAborted } = params;
    const httpStatus = getHttpStatusCode(error);

    if (isX402PaymentRequiredError(error)) {
        return {
            kind: TOOL_CALL_ERROR_KIND.PAYMENT,
            toolStatus: TOOL_STATUS.SOFT_FAIL,
            callDiagnostics: {
                failure_category: FAILURE_CATEGORY.INVALID_INPUT,
                failure_http_status: 402,
                ...buildActorFields(actorName, actorId),
            },
            response: buildPaymentRequiredResponse(error),
        };
    }

    if (isPermissionApprovalError(error)) {
        return {
            kind: TOOL_CALL_ERROR_KIND.APPROVAL,
            toolStatus: TOOL_STATUS.SOFT_FAIL,
            callDiagnostics: {
                failure_category: FAILURE_CATEGORY.PERMISSION_APPROVAL_REQUIRED,
                failure_http_status: error.statusCode,
                ...buildActorFields(actorName, actorId),
            },
            response: buildPermissionApprovalResponse(error),
        };
    }

    const failureDetail = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
    return {
        kind: TOOL_CALL_ERROR_KIND.EXECUTION,
        toolStatus: getToolStatusFromError(error, isAborted),
        callDiagnostics: {
            failure_category: classifyFailureCategory(error),
            ...(httpStatus !== undefined ? { failure_http_status: httpStatus } : {}),
            failure_detail: failureDetail,
            ...buildActorFields(actorName, actorId),
        },
        userText: getToolCallErrorUserText(toolName, error),
    };
}
