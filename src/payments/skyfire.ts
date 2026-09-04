import type { ToolEntry, ToolInputSchema } from '../types.js';
import { redactSkyfirePayId } from '../utils/logging.js';
import { appendToolDescription, cloneToolEntry } from '../utils/tools.js';
import {
    PAYMENT_PROTOCOL_HEADER,
    SKYFIRE_PAY_ID_KEY,
    SKYFIRE_PAY_ID_PROPERTY_DESCRIPTION,
    SKYFIRE_README_CONTENT,
    SKYFIRE_TOOL_INSTRUCTIONS,
} from './const.js';
import type { PaymentHeaders, PaymentProvider } from './types.js';

/** Adds `skyfire-pay-id` to a schema's properties in place, if not already present. */
function injectPayIdProperty(inputSchema: ToolInputSchema): void {
    if (!inputSchema || !('properties' in inputSchema)) return;
    const props = inputSchema.properties as Record<string, unknown>;
    if (!props[SKYFIRE_PAY_ID_KEY]) {
        props[SKYFIRE_PAY_ID_KEY] = {
            type: 'string',
            description: SKYFIRE_PAY_ID_PROPERTY_DESCRIPTION,
        };
    }
}

/**
 * Skyfire payment provider.
 *
 * Injects `skyfire-pay-id` into eligible tool schemas and forwards the
 * Skyfire PAY JWT token as a header on outbound Apify API requests.
 */
export class SkyfirePaymentProvider implements PaymentProvider {
    readonly id = 'skyfire' as const;
    readonly allowsUnauthenticated = true;

    static async create(): Promise<SkyfirePaymentProvider> {
        return new SkyfirePaymentProvider();
    }

    decorateToolSchema(tool: ToolEntry): ToolEntry {
        if (!tool.paymentRequired) return tool;

        const cloned = cloneToolEntry(tool);

        appendToolDescription(cloned, SKYFIRE_TOOL_INSTRUCTIONS);

        injectPayIdProperty(cloned.inputSchema);
        // A per-session inputSchema render bypasses the static field above — wrap it too, or
        // pay-id vanishes whenever it's used instead.
        if (cloned.buildInputSchema) {
            const renderBase = cloned.buildInputSchema;
            cloned.buildInputSchema = (ctx) => {
                const schema = renderBase(ctx);
                injectPayIdProperty(schema);
                return schema;
            };
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
            return {
                [SKYFIRE_PAY_ID_KEY]: payId,
                [PAYMENT_PROTOCOL_HEADER]: 'skyfire',
            };
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
        // TODO: redactSkyfirePayId is still used directly by other in-repo callers
        // (e.g. tools/actors/actor_executor.ts). Once those callers migrate to
        // `paymentProvider.redactForLogging()`, remove the standalone function and
        // centralize the redaction logic entirely inside this provider.
        return redactSkyfirePayId(args);
    }
}
