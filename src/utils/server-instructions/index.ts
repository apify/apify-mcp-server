/**
 * Server instructions entry point.
 * Selects the appropriate instructions based on server mode.
 */

import { ServerMode } from '../../types.js';
import { getAppsInstructions } from './apps.js';
import { getDefaultInstructions } from './default.js';

/** Mode → instructions builder. Add new modes here. */
const instructionsByMode: Record<ServerMode, () => string> = {
    [ServerMode.DEFAULT]: getDefaultInstructions,
    [ServerMode.APPS]: getAppsInstructions,
};

/**
 * Build server instructions for the given server mode.
 */
export function getServerInstructions(mode: ServerMode = ServerMode.DEFAULT): string {
    return instructionsByMode[mode]();
}
