/**
 * Langfuse OpenTelemetry tracing setup for workflow evaluations.
 *
 * Spans are exported to Langfuse Cloud. Credentials are read from the
 * environment by the Langfuse SDK: LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY,
 * LANGFUSE_BASE_URL.
 */

import { LangfuseSpanProcessor } from '@langfuse/otel';
import { NodeSDK } from '@opentelemetry/sdk-node';

import { sanitizeEnvValue } from '../shared/config.js';

/** Environment variables the Langfuse SDK reads to authenticate. */
export const LANGFUSE_ENV_VARS = ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_BASE_URL'] as const;

/** Valid values for LANGFUSE_BASE_URL, surfaced in the fail-fast message. */
export const LANGFUSE_BASE_URLS = ['https://us.cloud.langfuse.com (US)', 'https://cloud.langfuse.com (EU)'] as const;

/**
 * Return the names of any required Langfuse env vars that are unset or empty
 * (after sanitizing). Pure — used both for the fail-fast check and in tests.
 */
export function getMissingLangfuseEnvVars(env: NodeJS.ProcessEnv = process.env): string[] {
    return LANGFUSE_ENV_VARS.filter((key) => !sanitizeEnvValue(env[key]));
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
