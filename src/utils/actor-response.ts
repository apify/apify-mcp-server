import type { CallActorGetDatasetResult } from '../tools/actor';

/**
 * Builds the response content for Actor tool calls.
 * Includes Actor run metadata, output schema, and a preview of output items.
 *
 * The response starts with a preview of Actor output items, if available.
 * This must come first. Metadata and instructions for the LLM are provided last.
 * The LLM may ignore metadata and instructions if it is not at the end of the response.
 *
 * If the preview is limited and does not show all items, the response informs the LLM.
 * This is important because the LLM may assume it has all data and hallucinate missing items.
 *
 * @param actorName - The name of the actor.
 * @param result - The result from callActorGetDataset.
 * @returns The content array for the tool response.
 */
export function buildActorResponseContent(
    actorName: string,
    result: CallActorGetDatasetResult,
): ({ type: 'text'; text: string })[] {
    const { runId, datasetId, itemCount, schema } = result;

    // Extract item schema if schema is an array
    let displaySchema = schema;
    if (schema && schema.type === 'array' && typeof schema.items === 'object' && schema.items !== null) {
        displaySchema = schema.items;
    }

    // Construct text content
    const textContent = `Actor "${actorName}" completed successfully!

Results summary:
• Run ID: ${runId}
• Dataset ID: ${datasetId}
• Total items: ${itemCount}

Actor output data schema:
* You can use this schema to understand the structure of the output data and, for example, retrieve specific fields based on your current task.
\`\`\`json
${JSON.stringify(displaySchema, null, 2)}
\`\`\`

Above this text block is a preview of the Actor output containing ${result.previewItems.length} item(s).${itemCount !== result.previewItems.length ? ` You have access only to a limited preview of the Actor output. Do not present this as the full output, as you have only ${result.previewItems.length} item(s) available instead of the full ${itemCount} item(s). Be aware of this and inform users about the currently loaded count and the total available output items count.` : ''}

If you need to retrieve additional data, use the "get-actor-output" tool with: datasetId: "${datasetId}". Be sure to limit the number of results when using the "get-actor-output" tool, since you never know how large the items may be, and they might exceed the output limits.
`;

    const itemsPreviewText = result.previewItems.length > 0
        ? JSON.stringify(result.previewItems)
        : `No items available for preview—either the Actor did not return any items or they are too large for preview. In this case, use the "get-actor-output" tool.`;

    // Build content array
    return [
        { type: 'text', text: itemsPreviewText },
        /**
         * The metadata and instructions text must be at the end otherwise the LLM does not acknowledge it.
         */
        { type: 'text', text: textContent },
    ];
}
