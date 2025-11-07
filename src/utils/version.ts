import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Gets the package version dynamically from package.json
 * Returns null if the file cannot be read
 */
export function getPackageVersion(): string | null {
    try {
        // Read package.json and extract version
        // In production, this will be replaced at build time
        // eslint-disable-next-line no-underscore-dangle
        const __filename = fileURLToPath(import.meta.url);
        // eslint-disable-next-line no-underscore-dangle
        const __dirname = dirname(__filename);
        const packagePath = join(__dirname, '../../package.json');
        const packageData = JSON.parse(readFileSync(packagePath, 'utf-8'));
        return packageData.version || null;
    } catch {
        // Return null if package.json cannot be read
        return null;
    }
}
