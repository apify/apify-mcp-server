import { HelperTools } from '../../const.js';
import type { InternalToolArgs, ToolEntry } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import {
    buildCallActorDescription,
    callActorAjvValidate,
    callActorInputSchema,
    executeCallActor,
} from '../core/call_actor_common.js';
import { getActorRunOutputSchema } from '../structured_output_schemas.js';

const CALL_ACTOR_DEFAULT_DESCRIPTION = buildCallActorDescription();

/**
 * Default mode call-actor tool.
 */
export const defaultCallActor: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HelperTools.ACTOR_CALL,
    description: CALL_ACTOR_DEFAULT_DESCRIPTION,
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
