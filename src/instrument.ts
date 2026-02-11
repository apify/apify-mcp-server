/**
 * Sentry instrumentation for the stdio transport.
 *
 * IMPORTANT: This file must be imported before any other modules
 * to ensure Sentry is initialized as early as possible.
 */
import { createRequire } from 'node:module';

import * as Sentry from '@sentry/node';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json');

Sentry.init({
    dsn: 'https://916ec26e2f0abda151403acb5d8370c7@o272833.ingest.us.sentry.io/4510662589808640',
    release: packageJson.version,
    sendDefaultPii: true,
});
