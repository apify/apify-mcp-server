import { readJsonFile } from './generic.js';

const packageJson = readJsonFile<{ version?: string }>(import.meta.url, '../../package.json');

/**
 * Gets the package version from package.json
 * Returns null if version is not available
 */
export function getPackageVersion(): string | null {
    return packageJson.version || null;
}
