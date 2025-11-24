import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json');

/**
 * Gets the package version from package.json
 * Returns null if version is not available
 */
export function getPackageVersion(): string | null {
    return packageJson.version || null;
}
