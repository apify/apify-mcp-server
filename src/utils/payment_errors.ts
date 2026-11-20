import type { ApifyApiError } from 'apify-client';

import { HTTP_PAYMENT_REQUIRED } from '../const.js';
import { isActorRunLimitError } from './apify_errors.js';
import { getHttpStatusCode } from './logging.js';
import { respondErrorNoTelemetry, type ToolResponse } from './mcp.js';

/**
 * True for a 402 Payment Required from the Apify API, e.g. a token account out of credits. The concurrent-run limit
 * also surfaces as 402 but is an account quota, excluded so callers fall through to the run-limit handling.
 */
export function isPaymentRequiredError(error: unknown): boolean {
    return getHttpStatusCode(error) === HTTP_PAYMENT_REQUIRED && !isActorRunLimitError(error);
}

export function buildPaymentRequiredResponse(errorOrMessage: unknown): ToolResponse {
    const message = errorOrMessage instanceof Error ? errorOrMessage.message : String(errorOrMessage);
    return respondErrorNoTelemetry([message]);
}

/** Text lines for a permission-approval response: the error message plus an optional approval URL. */
export function buildPermissionApprovalTexts(error: ApifyApiError): string[] {
    const approvalUrl = typeof error.data?.approvalUrl === 'string' ? error.data.approvalUrl : undefined;
    return [error.message, ...(approvalUrl ? [`Approve here: ${approvalUrl}`] : [])];
}

/** Exported for the shared tool-call error mapper (src/mcp/tool_call_error_mapper.ts) — no logging, no telemetry. */
export function buildPermissionApprovalResponse(error: ApifyApiError): ToolResponse {
    return respondErrorNoTelemetry(buildPermissionApprovalTexts(error));
}
