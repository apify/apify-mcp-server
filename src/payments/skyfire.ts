import {
    SKYFIRE_PAY_ID_PROPERTY_DESCRIPTION,
    SKYFIRE_README_CONTENT,
    SKYFIRE_TOOL_INSTRUCTIONS,
} from '../const.js';
import type { ToolEntry } from '../types.js';
import { cloneToolEntry } from '../utils/tools.js';
import type { PaymentHeaders, PaymentProvider } from './types.js';

const SKYFIRE_PAY_ID_KEY = 'skyfire-pay-id';
const REDACTED_VALUE = '[REDACTED]';

/**
 * Skyfire payment provider.
 *
 * Injects `skyfire-pay-id` into eligible tool schemas and forwards the
 * Skyfire PAY JWT token as a header on outbound Apify API requests.
 */
export class SkyfirePaymentProvider implements PaymentProvider {
    readonly id = 'skyfire' as const;
    readonly allowsUnauthenticated = true;

    decorateToolSchema(tool: ToolEntry): ToolEntry {
        if (!tool.paymentRequired) return tool;

        const cloned = cloneToolEntry(tool);

        // Append Skyfire instructions to description (idempotent)
        if (cloned.description && !cloned.description.includes(SKYFIRE_TOOL_INSTRUCTIONS)) {
            cloned.description += `\n\n${SKYFIRE_TOOL_INSTRUCTIONS}`;
        }

        // Add skyfire-pay-id property to inputSchema (idempotent)
        if (cloned.inputSchema && 'properties' in cloned.inputSchema) {
            const props = cloned.inputSchema.properties as Record<string, unknown>;
            if (!props[SKYFIRE_PAY_ID_KEY]) {
                props[SKYFIRE_PAY_ID_KEY] = {
                    type: 'string',
                    description: SKYFIRE_PAY_ID_PROPERTY_DESCRIPTION,
                };
            }
        }

        return Object.freeze(cloned);
    }

    validatePayment(args: Record<string, unknown>): string | null {
        if (args[SKYFIRE_PAY_ID_KEY] === undefined) {
            return `Missing required "${SKYFIRE_PAY_ID_KEY}" field. Obtain a Skyfire PAY JWT token via the create-pay-token tool and pass it as "${SKYFIRE_PAY_ID_KEY}".`;
        }
        return null;
    }

    getPaymentHeaders(args: Record<string, unknown>): PaymentHeaders {
        const payId = args[SKYFIRE_PAY_ID_KEY];
        if (typeof payId === 'string') {
            return { [SKYFIRE_PAY_ID_KEY]: payId };
        }
        return {};
    }

    removePaymentFields(args: Record<string, unknown>): Record<string, unknown> {
        const { [SKYFIRE_PAY_ID_KEY]: _removed, ...rest } = args;
        return rest;
    }

    getUsageGuide(): string | null {
        return SKYFIRE_README_CONTENT;
    }

    redactForLogging(args: unknown): unknown {
        if (!isPlainRecord(args) || !(SKYFIRE_PAY_ID_KEY in args)) {
            return args;
        }
        if (args[SKYFIRE_PAY_ID_KEY] === REDACTED_VALUE) {
            return args;
        }
        return { ...args, [SKYFIRE_PAY_ID_KEY]: REDACTED_VALUE };
    }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
