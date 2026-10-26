import { McpError } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import { ApifyApiError } from 'apify-client';
import { z } from 'zod';

import { APIFY_ERROR_TYPE_CANNOT_START_ACTOR_RUNS, HELPER_TOOLS, MAX_INLINE_BYTES } from '../const.js';
import { SchemaTooLargeError, TimeoutError, UserInputError } from '../errors.js';
import { InternalError, InvalidParamsError } from '../mcp/errors.js';
import { maskSessionToken, REDACTED, redactJsonSecrets } from '../resources/api_resources.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../types.js';
import { TOOL_TYPE } from '../types.js';
import { fixZodSchemaRequired } from '../utils/ajv.js';
import { isActorRunLimitError, isPermissionApprovalError } from '../utils/apify_errors.js';
import { getHttpStatusCode } from '../utils/logging.js';
import { respondRaw, respondUserError, type ToolResponse } from '../utils/mcp.js';
import { isX402PaymentRequiredError } from '../utils/payment_errors.js';

export const CHATGPT_DATASET_LIMIT = 100;
export const CHATGPT_LOG_LIMIT = 50;

const OUTPUT_AJV = new Ajv({ strict: false, coerceTypes: false, removeAdditional: false });
OUTPUT_AJV.addFormat('date', (value: string) => z.iso.date().safeParse(value).success);
const WRAPPED_TOOLS = new WeakMap<ToolEntry, ToolEntry>();
const APIFY_TOKEN_PATTERN = /apify_(?:api|ui)_[A-Za-z0-9]+/g;
const TOKEN_ASSIGNMENT_PATTERN = /\bAPIFY_TOKEN\s*[=:]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/g;
const QUOTED_TOKEN_ASSIGNMENT_PATTERN =
    /((?:"APIFY_TOKEN"|'APIFY_TOKEN')\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g;
const MAX_ERROR_TEXT_BYTES = 4096;
const MAX_ERROR_DATA_BYTES = 16384;
const PAYMENT_REQUIRED_DATA = Symbol.for('paymentRequiredData');

function redactPlainText(value: string, token: string | undefined): string {
    return redactJsonSecrets(maskSessionToken(Buffer.from(value), token).toString('utf8'))
        .replace(APIFY_TOKEN_PATTERN, REDACTED)
        .replace(QUOTED_TOKEN_ASSIGNMENT_PATTERN, `$1"${REDACTED}"`)
        .replace(TOKEN_ASSIGNMENT_PATTERN, `APIFY_TOKEN=${REDACTED}`);
}

function redactText(value: string, token: string | undefined): string {
    // Several tools include a JSON text mirror. Parse it before redacting assignments so quotes and
    // escaped newlines remain valid JSON, while retaining the original formatting when nothing changes.
    const leading = value.trimStart()[0];
    if (leading === '[' || leading === '{') {
        try {
            const parsed: unknown = JSON.parse(value);
            const sanitized = JSON.stringify(parsed, (key, entry: unknown) => {
                if (typeof entry !== 'string') return entry;
                if (key === 'APIFY_TOKEN' || key === 'password' || key === 'urlSigningSecretKey') return REDACTED;
                return redactPlainText(entry, token);
            });
            return sanitized === JSON.stringify(parsed) ? value : sanitized;
        } catch {
            // Ordinary source or log text can start with a brace without being JSON.
        }
    }
    return redactPlainText(value, token);
}

/** Preserve types, source hashes and opaque binary content; only text is inspected for secrets. */
function redactResponse(response: ToolResponse, token: string | undefined): ToolResponse {
    const json = JSON.stringify(response, function (key, value: unknown) {
        if (typeof value !== 'string') return value;
        if (key === 'APIFY_TOKEN' || key === 'password' || key === 'urlSigningSecretKey') return REDACTED;
        return redactText(value, token);
    });
    // Mask tokens used as data keys too. Binary payloads are restored below without interpreting their encoding.
    const sanitized = respondRaw(
        JSON.parse(maskSessionToken(Buffer.from(json), token).toString('utf8').replace(APIFY_TOKEN_PATTERN, REDACTED)),
    );
    sanitized.content?.forEach((block, index) => {
        const original = response.content?.[index];
        if ((block.type === 'image' || block.type === 'audio') && original && 'data' in original) {
            block.data = original.data;
        } else if (
            block.type === 'resource' &&
            original?.type === 'resource' &&
            'blob' in original.resource &&
            'blob' in block.resource
        ) {
            block.resource.blob = original.resource.blob;
        }
    });
    return sanitized;
}

function boundedErrorText(value: string, token: string | undefined, limit = MAX_ERROR_TEXT_BYTES): string {
    const withheld = 'Upstream error detail was withheld because it exceeds the submission size limit.';
    if (Buffer.byteLength(value, 'utf8') > limit) return withheld;
    const sanitized = redactText(value, token);
    return Buffer.byteLength(sanitized, 'utf8') <= limit ? sanitized : withheld;
}

function sanitizedErrorData(value: unknown, token: string | undefined): unknown {
    try {
        const json = JSON.stringify(value);
        if (!json || Buffer.byteLength(json, 'utf8') > MAX_ERROR_DATA_BYTES) return undefined;
        const sanitized = maskSessionToken(Buffer.from(redactText(json, token)), token)
            .toString('utf8')
            .replace(APIFY_TOKEN_PATTERN, REDACTED);
        return Buffer.byteLength(sanitized, 'utf8') <= MAX_ERROR_DATA_BYTES ? JSON.parse(sanitized) : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Rebuild, never clone, an upstream error before the engine logs or maps it. Only known classifier
 * fields and bounded payment/protocol data survive; request config, causes and original stacks do not.
 */
function sanitizeThrownError(error: unknown, token: string | undefined): Error {
    try {
        const safe = new Error(boundedErrorText(error instanceof Error ? error.message : String(error), token));
        if (typeof error !== 'object' || error === null) return safe;
        const fields = error as Record<PropertyKey, unknown>;
        // These trusted prototypes retain instanceof-based handling without copying raw error fields.
        for (const errorClass of [
            ApifyApiError,
            McpError,
            SchemaTooLargeError,
            InvalidParamsError,
            InternalError,
            TimeoutError,
            UserInputError,
        ]) {
            if (error instanceof errorClass) {
                Object.setPrototypeOf(safe, errorClass.prototype);
                break;
            }
        }
        if (typeof fields.name === 'string') safe.name = boundedErrorText(fields.name, token, 128);
        const statusCode = getHttpStatusCode(error);
        if (statusCode !== undefined) Object.assign(safe, { statusCode });
        if (typeof fields.code === 'number' && Number.isFinite(fields.code)) Object.assign(safe, { code: fields.code });
        if (typeof fields.code === 'string') Object.assign(safe, { code: boundedErrorText(fields.code, token, 128) });
        if (typeof fields.type === 'string') Object.assign(safe, { type: boundedErrorText(fields.type, token, 128) });
        // Preserve the wrapped-message quota case even when its oversized message was withheld.
        if (isActorRunLimitError(error)) Object.assign(safe, { type: APIFY_ERROR_TYPE_CANNOT_START_ACTOR_RUNS });
        if ((safe.name === 'ZodError' || safe.name === '$ZodError') && Array.isArray(fields.issues)) {
            Object.assign(safe, { issues: [] });
        }
        if (isX402PaymentRequiredError(error)) {
            const captured = sanitizedErrorData(fields[PAYMENT_REQUIRED_DATA], token);
            if (captured !== undefined) Object.defineProperty(safe, PAYMENT_REQUIRED_DATA, { value: captured });
            if (error instanceof ApifyApiError) Object.assign(safe, { data: sanitizedErrorData(error.data, token) });
        } else if (isPermissionApprovalError(error)) {
            Object.assign(safe, { data: sanitizedErrorData({ approvalUrl: error.data?.approvalUrl }, token) });
        } else if (error instanceof McpError || error instanceof InvalidParamsError || error instanceof InternalError) {
            Object.assign(safe, { data: sanitizedErrorData(error.data, token) });
        }
        return safe;
    } catch {
        return new Error('The upstream operation failed; its error details could not be safely returned.');
    }
}

function buildOutputInputSchema(tool: ToolEntry): ToolInputSchema {
    const schema = fixZodSchemaRequired(structuredClone(tool.inputSchema)) as ToolInputSchema;
    schema.additionalProperties = false;
    if (tool.name === HELPER_TOOLS.DATASET_GET_ITEMS) {
        schema.properties = {
            ...schema.properties,
            limit: {
                type: 'integer',
                minimum: 1,
                maximum: CHATGPT_DATASET_LIMIT,
                default: 20,
                description: `Maximum dataset rows per call, from 1 to ${CHATGPT_DATASET_LIMIT}. Default: 20.`,
            },
        };
        schema.required = schema.required?.filter((name) => name !== 'limit');
    }
    if (tool.name === HELPER_TOOLS.ACTOR_RUNS_LOG || tool.name === HELPER_TOOLS.PRIVATE_ACTOR_BUILD_LOG) {
        schema.properties = {
            ...schema.properties,
            lines: {
                type: 'integer',
                minimum: 1,
                maximum: CHATGPT_LOG_LIMIT,
                default: 10,
                description: `Number of recent log lines, from 1 to ${CHATGPT_LOG_LIMIT}. Default: 10. Whole-log reads are unavailable.`,
            },
        };
        schema.required = schema.required?.filter((name) => name !== 'lines');
    }
    return schema;
}

function boundedArgs(tool: ToolEntry, args: InternalToolArgs['args']): InternalToolArgs['args'] {
    if (tool.name === HELPER_TOOLS.DATASET_GET_ITEMS) return { limit: 20, ...args };
    if (tool.name === HELPER_TOOLS.ACTOR_RUNS_LOG || tool.name === HELPER_TOOLS.PRIVATE_ACTOR_BUILD_LOG) {
        return { lines: 10, ...args };
    }
    return { ...args };
}

function oversizedResponse(toolName: string): ToolResponse {
    const remedy =
        toolName === HELPER_TOOLS.DATASET_GET_ITEMS
            ? 'Request fewer rows or select fewer fields, using offset to page through the dataset.'
            : toolName === HELPER_TOOLS.ACTOR_RUNS_LOG || toolName === HELPER_TOOLS.PRIVATE_ACTOR_BUILD_LOG
              ? 'Request fewer log lines. A single long line may still exceed this limit; inspect it in Apify Console.'
              : 'Request a smaller result where the tool supports it, or inspect the full output in Apify Console.';
    return respondUserError(
        `The tool completed, but its response exceeds the ${MAX_INLINE_BYTES}-byte submission limit and was withheld. ` +
            `${remedy} Do not repeat an operation that starts a paid run or changes source just to retrieve this response.`,
    );
}

/**
 * The loader applies this only to the restricted submission's explicit tools, in either mode.
 * Limits apply after the existing handler fetches data; they do not bound upstream download or allocation.
 */
export function wrapChatGptOutputTool(tool: ToolEntry): ToolEntry {
    if (tool.type !== TOOL_TYPE.INTERNAL) return tool;
    const cached = WRAPPED_TOOLS.get(tool);
    if (cached) return cached;
    const inputSchema = buildOutputInputSchema(tool);
    const ajvValidate = OUTPUT_AJV.compile(inputSchema);
    const wrapped: ToolEntry = Object.freeze({
        ...tool,
        inputSchema,
        ajvValidate,
        // Rejected extra arguments can carry credentials, before validation runs in the call engine.
        redactArgs: () => ({}),
        call: async (context) => {
            const args = boundedArgs(tool, context.args);
            if (!ajvValidate(args))
                return respondUserError('Use only the declared arguments and bounded retrieval limits.');
            try {
                const response = await tool.call({ ...context, args });
                const serialized = JSON.stringify(response);
                if (Buffer.byteLength(serialized, 'utf8') > MAX_INLINE_BYTES) return oversizedResponse(tool.name);
                const sanitized = redactResponse(response, context.apifyToken);
                if (Buffer.byteLength(JSON.stringify(sanitized), 'utf8') > MAX_INLINE_BYTES)
                    return oversizedResponse(tool.name);
                return sanitized;
            } catch (error) {
                throw sanitizeThrownError(error, context.apifyToken);
            }
        },
    });
    WRAPPED_TOOLS.set(tool, wrapped);
    return wrapped;
}
