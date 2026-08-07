/**
 * Langfuse client and OpenTelemetry tracing setup for workflow evaluations.
 *
 * Credentials are read from the environment by the Langfuse SDK itself:
 * LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL.
 */

import { LangfuseClient } from '@langfuse/client';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { NodeSDK } from '@opentelemetry/sdk-node';

/** Environment variables the Langfuse SDK reads to authenticate. */
const LANGFUSE_ENV_VARS = ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_BASE_URL'] as const;

/**
 * Fail fast on missing configuration, then build the Langfuse client. Shared by
 * both CLI entry points; `extraEnvKeys` are the caller's own requirements.
 *
 * Assumes `sanitizeProcessEnv()` already ran: the entry point owns that, as in the
 * other eval entry points.
 */
export function createLangfuseClient(extraEnvKeys: readonly string[] = []): LangfuseClient {
    const missing = [...LANGFUSE_ENV_VARS, ...extraEnvKeys].filter((key) => !process.env[key]);
    if (missing.length > 0) {
        // eslint-disable-next-line no-console
        console.error(`❌ Error: missing environment variable(s): ${missing.join(', ')}`);
        process.exit(1);
    }

    return new LangfuseClient();
}

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
