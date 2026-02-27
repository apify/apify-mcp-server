/**
 * Server instructions entry point.
 * Selects the appropriate instructions based on server mode.
 */

import type { ServerMode } from '../../types.js';
import { getDefaultInstructions } from './default.js';
import { getOpenaiInstructions } from './openai.js';

/** Mode → instructions builder. Add new modes here. */
const instructionsByMode: Record<ServerMode, () => string> = {
    default: getDefaultInstructions,
    openai: getOpenaiInstructions,
};

/**
 * Build server instructions for the given server mode.
 */
export function getServerInstructions(mode: ServerMode = 'default'): string {
    return instructionsByMode[mode]();
}
