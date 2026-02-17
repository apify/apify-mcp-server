/**
 * Sentry instrumentation for the stdio transport.
 *
 * IMPORTANT: This file must be imported before any other modules
 * to ensure Sentry is initialized as early as possible.
 *
 * Respects the --telemetry-enabled flag and TELEMETRY_ENABLED env var.
 * Sentry is disabled when telemetry is explicitly disabled.
 */
import * as Sentry from '@sentry/node';

import { getPackageVersion } from './utils/version.js';

// Check if telemetry is disabled via CLI arg or env var before yargs parses them.
// This mirrors the --telemetry-enabled / TELEMETRY_ENABLED option from stdio.ts.
const isTelemetryDisabled = process.argv.includes('--telemetry-enabled=false')
    || process.argv.includes('--no-telemetry-enabled')
    || process.env.TELEMETRY_ENABLED === 'false';

Sentry.init({
    dsn: 'https://916ec26e2f0abda151403acb5d8370c7@o272833.ingest.us.sentry.io/4510662589808640',
    release: getPackageVersion() ?? undefined,
    sendDefaultPii: true,
    enabled: !isTelemetryDisabled,
});

// Start a Sentry session for this CLI invocation so crash-free rate metrics work.
// Without explicit session tracking, Sentry has zero sessions and crash-free % is always 0%.
if (!isTelemetryDisabled) {
    Sentry.startSession();
    Sentry.captureSession();

    // End the session cleanly when the process exits normally.
    // If the process crashes, Sentry automatically marks the session as crashed.
    process.on('beforeExit', () => {
        Sentry.endSession();
    });
}
