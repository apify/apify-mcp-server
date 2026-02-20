/**
 * Server instructions entry point.
 * Selects the appropriate instructions based on UI mode.
 */

import type { UiMode } from '../../types.js';
import { getDefaultInstructions } from './default.js';
import { getOpenaiInstructions } from './openai.js';

/**
 * Build server instructions for the given UI mode.
 *
 * @param uiMode - The UI mode ('openai' or undefined for default)
 * @returns Server instructions string
 */
export function getServerInstructions(uiMode?: UiMode): string {
    return uiMode === 'openai'
        ? getOpenaiInstructions()
        : getDefaultInstructions();
}
