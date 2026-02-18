import type { ActorCallOptions, ActorRun } from 'apify-client';

import log from '@apify/log';

import type { ApifyClient } from '../../apify-client.js';
import { TOOL_MAX_OUTPUT_CHARS } from '../../const.js';
import type { ActorDefinitionStorage, DatasetItem } from '../../types.js';
import { ensureOutputWithinCharLimit, getActorDefinitionStorageFieldNames } from '../../utils/actor.js';
import { logHttpError, redactSkyfirePayId } from '../../utils/logging.js';
import type { ProgressTracker } from '../../utils/progress.js';
import type { JsonSchemaProperty } from '../../utils/schema-generation.js';
import { generateSchemaFromItems } from '../../utils/schema-generation.js';

// Define a named return type for callActorGetDataset
export type CallActorGetDatasetResult = {
    runId: string;
    datasetId: string;
    itemCount: number;
    schema: JsonSchemaProperty;
    previewItems: DatasetItem[];
    usageTotalUsd?: number;
    usageUsd?: Record<string, number>;
};

/**
 * Calls an Apify Actor and retrieves metadata about the dataset results.
 *
 * This function executes an Actor and returns summary information instead with a result items preview of the full dataset
 * to prevent overwhelming responses. The actual data can be retrieved using the get-actor-output tool.
 *
 * It requires the `APIFY_TOKEN` environment variable to be set.
 * If the `APIFY_IS_AT_HOME` the dataset items are pushed to the Apify dataset.
 *
 * @param {string} actorName - The name of the Actor to call.
 * @param {unknown} input - The input to pass to the actor.
 * @param {ApifyClient} apifyClient - The Apify client to use for authentication.
 * @returns {Promise<CallActorGetDatasetResult | null>} - A promise that resolves to an object containing the actor run and dataset items.
 * @throws {Error} - Throws an error if the `APIFY_TOKEN` is not set
 */
export async function callActorGetDataset(options: {
    actorName: string;
    input: unknown;
    apifyClient: ApifyClient;
    callOptions?: ActorCallOptions;
    progressTracker?: ProgressTracker | null;
    abortSignal?: AbortSignal;
    previewOutput?: boolean;
    mcpSessionId?: string;
}): Promise<CallActorGetDatasetResult | null> {
    const {
        actorName,
        input,
        apifyClient,
        callOptions,
        progressTracker,
        abortSignal,
        previewOutput = true,
        mcpSessionId,
    } = options;
    const CLIENT_ABORT = Symbol('CLIENT_ABORT'); // Just internal symbol to identify client abort
    const actorClient = apifyClient.actor(actorName);

    // Start the actor run
    const actorRun: ActorRun = await actorClient.start(input, callOptions);

    // Start progress tracking if tracker is provided
    if (progressTracker) {
        progressTracker.startActorRunUpdates(actorRun.id, apifyClient, actorName);
    }

    // Create abort promise that handles both API abort and race rejection
    const abortPromise = async () => new Promise<typeof CLIENT_ABORT>((resolve) => {
        abortSignal?.addEventListener('abort', async () => {
            // Abort the actor run via API
            try {
                await apifyClient.run(actorRun.id).abort({ gracefully: false });
            } catch (e) {
                logHttpError(e, 'Error aborting Actor run', { runId: actorRun.id });
            }
            // Reject to stop waiting
            resolve(CLIENT_ABORT);
        }, { once: true });
    });

    // Wait for completion or cancellation
    const potentialAbortedRun = await Promise.race([
        apifyClient.run(actorRun.id).waitForFinish(),
        ...(abortSignal ? [abortPromise()] : []),
    ]);

    if (potentialAbortedRun === CLIENT_ABORT) {
        log.info('Actor run aborted by client', { actorName, mcpSessionId, input: redactSkyfirePayId(input) });
        return null;
    }
    const completedRun = potentialAbortedRun as ActorRun;

    // Process the completed run
    const dataset = apifyClient.dataset(completedRun.defaultDatasetId);
    const [datasetItems, defaultBuild] = await Promise.all([
        dataset.listItems(),
        (await actorClient.defaultBuild()).get(),
    ]);

    // Generate schema using the shared utility
    const generatedSchema = generateSchemaFromItems(datasetItems.items, {
        clean: true,
        arrayMode: 'all',
    });
    const schema = generatedSchema || { type: 'object', properties: {} };

    /**
     * Get important fields that are using in any dataset view as they MAY be used in filtering to ensure the output fits
     * the tool output limits. Client has to use the get-actor-output tool to retrieve the full dataset or filtered out fields.
     */
    const storageDefinition = defaultBuild?.actorDefinition?.storages?.dataset as ActorDefinitionStorage | undefined;
    const importantProperties = getActorDefinitionStorageFieldNames(storageDefinition || {});
    const previewItems = previewOutput
        ? ensureOutputWithinCharLimit(datasetItems.items, importantProperties, TOOL_MAX_OUTPUT_CHARS)
        : [];

    return {
        runId: actorRun.id,
        datasetId: completedRun.defaultDatasetId,
        itemCount: datasetItems.count,
        schema,
        previewItems,
        usageTotalUsd: completedRun.usageTotalUsd,
        usageUsd: completedRun.usageUsd as Record<string, number> | undefined,
    };
}
