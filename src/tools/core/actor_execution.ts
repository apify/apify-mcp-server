import type { ActorCallOptions, ActorRun } from 'apify-client';

import log from '@apify/log';

import type { ApifyClient } from '../../apify_client.js';
import { TOOL_MAX_OUTPUT_CHARS } from '../../const.js';
import type { ActorDefinitionStorage, DatasetItem } from '../../types.js';
import { ensureOutputWithinCharLimit, getActorDefinitionStorageFieldNames } from '../../utils/actor.js';
import { logHttpError, redactSkyfirePayId } from '../../utils/logging.js';
import { formatRunStatusMessage, type ProgressTracker } from '../../utils/progress.js';
import type { JsonSchemaProperty } from '../../utils/schema_generation.js';
import { generateSchemaFromItems } from '../../utils/schema_generation.js';

// Define a named return type for callActorGetDataset
export type CallActorGetDatasetResult = {
    runId: string;
    datasetId: string;
    totalItemCount: number;
    previewItemCount: number;
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
 * @returns {Promise<CallActorGetDatasetResult | null>} - A promise that resolves to an object containing the actor run and dataset items.
 * @throws {Error} - Throws an error if the `APIFY_TOKEN` is not set
 * @param options
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
    const CLIENT_ABORT = Symbol('CLIENT_ABORT'); // Just an internal symbol to identify client abort
    const actorClient = apifyClient.actor(actorName);

    const abortActorRun = async (runId: string) => {
        try {
            await apifyClient.run(runId).abort({ gracefully: false });
        } catch (e) {
            logHttpError(e, 'Error aborting Actor run', { runId });
        }
    };

    // The Actor start request itself is not tied to our AbortSignal, so a client can cancel
    // before we even create the run. In that case we should exit without starting follow-up work.
    if (abortSignal?.aborted) {
        log.info('Actor run aborted by client before start', { actorName, mcpSessionId, input: redactSkyfirePayId(input) });
        return null;
    }

    // Start the actor run
    const actorRun: ActorRun = await actorClient.start(input, callOptions);

    // Cancellation can also arrive while actorClient.start() is still in flight. Once start()
    // returns we finally have a run ID, so we must immediately check again and abort that run
    // ourselves; otherwise the abort event is missed and the run continues in the background.
    if (abortSignal?.aborted) {
        await abortActorRun(actorRun.id);

        log.info('Actor run aborted by client', { actorName, mcpSessionId, input: redactSkyfirePayId(input) });
        return null;
    }

    // Resolve the race immediately on cancellation so waitForFinish() cannot win after the
    // client cancelled the request. Keep the abort promise so the run is actually aborted
    // before this function returns.
    let abortListener: (() => void) | undefined;
    let abortRequestPromise: Promise<void> | undefined;
    const abortPromise = new Promise<typeof CLIENT_ABORT>((resolve) => {
        abortListener = () => {
            abortRequestPromise = abortActorRun(actorRun.id);
            resolve(CLIENT_ABORT);
        };
        abortSignal?.addEventListener('abort', abortListener, { once: true });
    });

    // Start progress tracking if a tracker is provided
    if (progressTracker) {
        await progressTracker.updateProgress(formatRunStatusMessage(actorName, actorRun));
        progressTracker.startActorRunUpdates(actorRun.id, apifyClient, actorName, actorRun);
    }

    // Wait for completion or cancellation
    const potentialAbortedRun = await Promise.race([
        apifyClient.run(actorRun.id).waitForFinish(),
        ...(abortSignal ? [abortPromise] : []),
    ]);

    // Clean up the abort listener if waitForFinish() won the race, so a later signal
    // doesn't try to abort an already-completed run.
    if (abortListener) {
        abortSignal?.removeEventListener('abort', abortListener);
    }

    if (potentialAbortedRun === CLIENT_ABORT) {
        progressTracker?.stop();
        await abortRequestPromise;
        log.info('Actor run aborted by client', { actorName, mcpSessionId, input: redactSkyfirePayId(input) });
        return null;
    }
    const completedRun = potentialAbortedRun as ActorRun;

    // Stop the polling tracker before any final emit so a late tick can't duplicate it.
    progressTracker?.stop();

    // The platform may write the actor's final statusMessage just after the status
    // flips, so the snapshot from waitForFinish() can be stale. Re-fetch in parallel
    // with the dataset/build fetches to keep it off the critical path.
    const dataset = apifyClient.dataset(completedRun.defaultDatasetId);
    const [datasetItems, defaultBuild, finalRunStatus] = await Promise.all([
        dataset.listItems(),
        (await actorClient.defaultBuild()).get(),
        // Catch-and-coerce so a 404/transient API failure on the re-fetch can't fail the
        // whole tool call; the formatter falls back to the waitForFinish snapshot.
        progressTracker
            ? apifyClient.run(completedRun.id).get().catch(() => undefined)
            : Promise.resolve(undefined),
    ]);

    if (progressTracker) {
        // Fall back to the waitForFinish snapshot only if the re-fetch 404s (very rare).
        await progressTracker.updateProgress(
            formatRunStatusMessage(actorName, finalRunStatus ?? completedRun),
        );
    }

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
        // `datasetItems.total` comes from the X-Apify-Pagination-Total header, which is backed
        // by the dataset's cached `itemCount` counter. Per the API docs, this counter may lag
        // up to 5 seconds after items are written (eventual consistency). When called immediately
        // after a run finishes it can return 0 even though items are already stored.
        // Fall back to `items.length`: safe here because listItems() has no limit, so all items
        // are fetched and the length always reflects the true count.
        // See: https://docs.apify.com/api/v2/dataset-get (itemCount note)
        totalItemCount: datasetItems.total || datasetItems.items.length,
        previewItemCount: previewItems.length,
        schema,
        previewItems,
        usageTotalUsd: completedRun.usageTotalUsd,
        usageUsd: completedRun.usageUsd as Record<string, number> | undefined,
    };
}
