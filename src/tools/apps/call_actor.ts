import { HelperTools } from '../../const.js';
import type { InternalToolArgs, ToolEntry } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import {
    buildCallActorAppsDescription,
    callActorAjvValidate,
    callActorInputSchema,
    executeCallActor,
} from '../core/call_actor_common.js';
import { getActorRunOutputSchema } from '../structured_output_schemas.js';

const CALL_ACTOR_APPS_DESCRIPTION = buildCallActorAppsDescription();

/**
 * Apps mode call-actor tool.
 * Renders no widget; for a live progress UI, use the call-actor-widget sibling.
 */
export const appsCallActor: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HelperTools.ACTOR_CALL,
    description: CALL_ACTOR_APPS_DESCRIPTION,
    inputSchema: callActorInputSchema,
    outputSchema: getActorRunOutputSchema,
    ajvValidate: callActorAjvValidate,
    paymentRequired: true,
    annotations: {
        title: 'Call Actor',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
    },
    execution: {
        // Support long-running tasks
        taskSupport: 'optional',
    },
    call: async (toolArgs: InternalToolArgs) => executeCallActor(toolArgs),
} as const);
