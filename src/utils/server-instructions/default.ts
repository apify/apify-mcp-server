/**
 * Default mode server instructions — standard tool references without UI-specific rules.
 */

import { HelperTools } from '../../const.js';
import { getCommonInstructions } from './common.js';

/** Returns server instructions for default (non-UI) mode. */
export function getDefaultInstructions(): string {
    return getCommonInstructions({
        schemaToolHint: `Use \`${HelperTools.ACTOR_GET_DETAILS}\` first to obtain the Actor's input schema`,
        workflowRules: '',
        toolDisambiguation: '',
    });
}
