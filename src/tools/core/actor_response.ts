import dedent from 'dedent';

import type { DatasetItem } from '../../types.js';
import type { CallActorGetDatasetResult } from './actor_execution.js';

/**
 * Result from buildActorResponseContent function.
 * Contains both text content and structured content.
 */
export type ActorResponseResult = {
    content: ({ type: 'text'; text: string })[];
    structuredContent: {
        runId: string;
        datasetId: string;
        totalItemCount: number;
        items: DatasetItem[];
        instructions: string;
    };
};

/**
 * Builds the response content for Actor tool calls.
 *
 * Returns `structuredContent` (the canonical data payload) and a `content` array with:
 *   [0] serialized JSON of `structuredContent` — per MCP spec 2025-11-25, tools returning
 *       structured content SHOULD also return the serialized JSON as a TextContent block
 *       for backwards-compat clients.
 *   [1] human-readable metadata + instructions — last, because LLMs ignore metadata that
 *       isn't at the end of the response.
 *
 * If the preview is limited, the response informs the LLM so it doesn't hallucinate
 * missing items.
 */
export function buildActorResponseContent(
    actorName: string,
    result: CallActorGetDatasetResult,
    previewOutput = true,
): ActorResponseResult {
    const { runId, datasetId, totalItemCount, schema } = result;

    // Extract item schema if schema is an array
    let displaySchema = schema;
    if (schema && schema.type === 'array' && typeof schema.items === 'object' && schema.items !== null) {
        displaySchema = schema.items;
    }

    // Build instructions for retrieving additional data
    const isPreviewLimited = totalItemCount !== result.previewItems.length;
    const previewNote = isPreviewLimited
        ? dedent`
            Note: You have access only to a limited preview
            (${result.previewItems.length} of ${totalItemCount} items). Do not present this as the full output.
        `
        : '';
    const previewLimitNote = isPreviewLimited
        ? dedent`
            You have access only to a limited preview of the Actor output.
            Do not present this as the full output, as you have only ${result.previewItems.length} item(s) available instead of the full ${totalItemCount} item(s).
            Be aware of this and inform users about the currently loaded count and the total available output items count.
        `
        : '';
    let emptyPreviewNote = '';
    if (result.previewItems.length === 0) {
        emptyPreviewNote = previewOutput
            ? 'No items available for preview—either the Actor did not return any items or they are too large for preview.'
            : 'Preview skipped (previewOutput: false).';
    }
    const instructions = dedent`
        ${emptyPreviewNote}
        If you need to retrieve additional data, use the "get-actor-output" tool with datasetId: "${datasetId}".${previewNote}
        Be sure to limit the number of results when using the "get-actor-output" tool, since you never know how large the items may be, and they might exceed the output limits.
    `;

    // Build structured content — the canonical data payload.
    const structuredContent = {
        runId: result.runId,
        datasetId: result.datasetId,
        totalItemCount: result.totalItemCount,
        items: result.previewItems,
        instructions,
    };

    // Construct the human-readable text block (metadata + instructions) for LLM consumption.
    const textContent = dedent`
        Actor "${actorName}" completed successfully!

        Results summary:
        • Run ID: ${runId}
        • Dataset ID: ${datasetId}
        • Total items: ${totalItemCount}

        Actor output data schema:
        * You can use this schema to understand the structure of the output data and, for example, retrieve specific fields based on your current task.
        \`\`\`json
        ${JSON.stringify(displaySchema)}
        \`\`\`

        Above this text block is a preview of the Actor output containing ${result.previewItems.length} item(s).${previewLimitNote}

        ${instructions}
    `;

    // Per MCP spec 2025-11-25, a tool returning structuredContent SHOULD also return
    // the serialized JSON in a TextContent block for backwards-compat clients.
    // The human-readable block must come last — LLMs don't acknowledge metadata otherwise.
    const content: ({ type: 'text'; text: string })[] = [
        { type: 'text', text: JSON.stringify(structuredContent) },
        { type: 'text', text: textContent },
    ];

    return { content, structuredContent };
}
