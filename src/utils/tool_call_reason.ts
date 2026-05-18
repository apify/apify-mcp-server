/**
 * MCP tool call `reason` middleware.
 *
 * Injects a `reason` property into every tool's public input schema (tools/list)
 * and extracts it from incoming arguments at call time so it can be forwarded to
 * telemetry. The field is stripped from arguments before AJV validation and tool
 * execution so downstream code (Actor input, payment processing, proxied MCP
 * calls) never observes it.
 */

import type { ToolInputSchema } from '../types.js';

/** Name of the property injected into every tool's input schema. */
export const TOOL_CALL_REASON_PROPERTY = 'reason';

/**
 * Description shown to the LLM in tools/list. It must be explicit about scope so
 * the model writes a short, use-case-only sentence and never leaks unrelated
 * conversation content, identifiers, secrets, or personal data.
 */
export const TOOL_CALL_REASON_DESCRIPTION = [
    'One or two short sentences describing why this tool is being called for this request.',
    'Scope: explain only the immediate use case of this tool call (what you intend to accomplish with it).',
    'MUST NOT include any other context from the conversation, prior turns, user messages, file contents, or task background.',
    'MUST NOT include any personal data, personally identifiable information (PII), names, emails, phone numbers, addresses, IDs, or other identifiers.',
    'MUST NOT include any secrets, passwords, API keys, tokens, credentials, or sensitive values.',
    'MUST NOT quote, paraphrase, or summarize anything the user or the system said outside the immediate intent of this call.',
    'Write it as a generic, self-contained justification, e.g. "Fetching weather data to answer a forecast question." Keep it under 200 characters.',
].join(' ');

/** Maximum number of characters retained from a reason value when forwarded to telemetry. */
export const TOOL_CALL_REASON_MAX_LENGTH = 500;

/**
 * Returns a new input schema with the `reason` property added.
 *
 * Idempotent: if `reason` is already present, the original schema is returned.
 * The property is added to `required` so MCP clients prompt the LLM to provide
 * it; the AJV-compiled validator on the tool is unaffected (it operates on a
 * separate schema instance), so a missing `reason` does not fail validation.
 */
export function injectReasonProperty(inputSchema: ToolInputSchema): ToolInputSchema {
    if (!inputSchema || typeof inputSchema !== 'object') return inputSchema;

    const properties = (inputSchema.properties ?? {}) as Record<string, unknown>;
    if (properties[TOOL_CALL_REASON_PROPERTY]) return inputSchema;

    const required = Array.isArray(inputSchema.required) ? inputSchema.required : [];

    return {
        ...inputSchema,
        properties: {
            ...properties,
            [TOOL_CALL_REASON_PROPERTY]: {
                type: 'string',
                description: TOOL_CALL_REASON_DESCRIPTION,
            },
        },
        required: required.includes(TOOL_CALL_REASON_PROPERTY)
            ? required
            : [...required, TOOL_CALL_REASON_PROPERTY],
    };
}

/**
 * Removes the `reason` property from a mutable args object and returns its
 * trimmed, length-capped value (or `undefined` if missing/empty/non-string).
 *
 * Always strip before AJV validation, payment processing, and tool dispatch —
 * the field is metadata for telemetry and must not leak to downstream code.
 */
export function extractAndStripReason(args: Record<string, unknown> | undefined): string | undefined {
    if (!args || typeof args !== 'object') return undefined;

    const raw = args[TOOL_CALL_REASON_PROPERTY];
    delete args[TOOL_CALL_REASON_PROPERTY];

    if (typeof raw !== 'string') return undefined;
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    return trimmed.length > TOOL_CALL_REASON_MAX_LENGTH
        ? trimmed.slice(0, TOOL_CALL_REASON_MAX_LENGTH)
        : trimmed;
}
