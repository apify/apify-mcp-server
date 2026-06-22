import { HelperTools } from '../../const.js';
import type { InternalToolArgs, ToolEntry } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import {
    buildCallActorAppsDescription,
    buildCallActorDescription,
    callActorAjvValidate,
    callActorInputSchema,
    executeCallActor,
} from '../core/call_actor_common.js';
import { actorRunOutputSchema } from '../structured_output_schemas.js';

/**
 * Single call-actor definition shared by both modes — only the description differs
 * (apps mode appends a widget addendum).
 */
function createCallActorTool(description: string): ToolEntry {
    return Object.freeze({
        type: TOOL_TYPE.INTERNAL,
        name: HelperTools.ACTOR_CALL,
        description,
        inputSchema: callActorInputSchema,
        outputSchema: actorRunOutputSchema,
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
}

/** Default mode call-actor tool. */
export const defaultCallActor: ToolEntry = createCallActorTool(buildCallActorDescription());

/**
 * Apps mode call-actor tool.
 * Renders no widget; for a live progress UI, use the call-actor-widget sibling.
 */
export const appsCallActor: ToolEntry = createCallActorTool(buildCallActorAppsDescription());
