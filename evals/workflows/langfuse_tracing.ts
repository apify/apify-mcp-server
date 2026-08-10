/**
 * OpenTelemetry tracing setup for workflow evaluations.
 *
 * Credentials are read from the environment by the Langfuse SDK itself, so nothing
 * here passes them; the entry point only checks they are present.
 */

import { LangfuseSpanProcessor } from '@langfuse/otel';
import { NodeSDK } from '@opentelemetry/sdk-node';

/** Environment variables the Langfuse SDK reads to authenticate. */
export const LANGFUSE_ENV_VARS = ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_BASE_URL'] as const;

let sdk: NodeSDK | null = null;

/**
 * Start the OpenTelemetry SDK with the Langfuse span processor.
 * Call shutdownTracing() before the process exits or the last span batch is lost.
 */
export function initTracing(): void {
    if (sdk) return;
    sdk = new NodeSDK({ spanProcessors: [new LangfuseSpanProcessor()] });
    sdk.start();
}

/**
 * Flush and shut down the OpenTelemetry SDK. Must run before process exit so
 * the final batch of spans reaches Langfuse.
 */
export async function shutdownTracing(): Promise<void> {
    if (!sdk) return;
    await sdk.shutdown();
    sdk = null;
}
