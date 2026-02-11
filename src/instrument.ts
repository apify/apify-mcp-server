/**
 * Sentry instrumentation for the stdio transport.
 *
 * IMPORTANT: This file must be imported before any other modules
 * to ensure Sentry is initialized as early as possible.
 *
 * Respects the --telemetry-enabled flag and TELEMETRY_ENABLED env var.
 * Sentry is disabled when telemetry is explicitly disabled.
 */
import { createRequire } from 'node:module';

import * as Sentry from '@sentry/node';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json');

// Check if telemetry is disabled via CLI arg or env var before yargs parses them.
// This mirrors the --telemetry-enabled / TELEMETRY_ENABLED option from stdio.ts.
const isTelemetryDisabled = process.argv.includes('--telemetry-enabled=false')
    || process.argv.includes('--no-telemetry-enabled')
    || process.env.TELEMETRY_ENABLED === 'false';

Sentry.init({
    dsn: 'https://916ec26e2f0abda151403acb5d8370c7@o272833.ingest.us.sentry.io/4510662589808640',
    release: packageJson.version,
    sendDefaultPii: true,
    enabled: !isTelemetryDisabled,
});
