import type { ActorRun, Dataset, KeyValueClientListKeysResult } from 'apify-client';

import log from '@apify/log';

import type { ApifyClient } from '../../apify_client.js';
import { FAILURE_CATEGORY, HelperTools, TOOL_STATUS } from '../../const.js';
import { buildMCPResponse } from '../../utils/mcp.js';
import { formatRunStatusMessage, type ProgressTracker, TERMINAL_RUN_STATUSES } from '../../utils/progress.js';

/** Cap on `storages.keyValueStore.keys` array length. */
const KV_KEYS_LIMIT = 50;

/** Maximum value for `waitSecs`. Stays under the 60s tool-call ceiling several MCP clients impose. */
export const WAIT_SECS_MAX = 45;

/**
 * `waitSecs` value advertised in `nextStep` poll hints. Lower than tool-level defaults because the agent
 * is already known to be polling a non-terminal run — short cadence keeps it responsive without hammering.
 */
const POLL_HINT_WAIT_SECS = 10;

/** Limit for the dataset metadata `itemCount=0` lag-fallback probe. */
const ITEM_COUNT_PROBE_LIMIT = 1;

/** Delay before the second `itemCount=0` probe — small budget to absorb listItems total propagation lag. */
const ITEM_COUNT_RETRY_DELAY_MS = 500;

async function sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => { setTimeout(resolve, ms); });
}

/** Sentinel used by `raceAbort` to signal that the abort signal won the race. */
const ABORT = Symbol('ABORT');

/**
 * Race a promise against an abort signal. Returns the resolved value, or {@link ABORT} if the
 * signal fires first. Cleans up its abort listener on either branch so callers never leak.
 */
async function raceAbort<T>(promise: Promise<T>, abortSignal: AbortSignal | undefined): Promise<T | typeof ABORT> {
    if (!abortSignal) return promise;
    let listener: (() => void) | undefined;
    const abortPromise = new Promise<typeof ABORT>((resolve) => {
        listener = () => resolve(ABORT);
        abortSignal.addEventListener('abort', listener, { once: true });
    });
    try {
        return await Promise.race([promise, abortPromise]);
    } finally {
        if (listener) abortSignal.removeEventListener('abort', listener);
    }
}

// -----------------------------------------------------------------------------
// Response types
// -----------------------------------------------------------------------------

export type RunDataset = {
    id: string;
    name?: string;
    title?: string;
    itemCount?: number;
    cleanItemCount?: number;
    fields?: string[];
};

export type RunKeyValueStore = {
    id: string;
    name?: string;
    title?: string;
    keyCount?: number;
    keys?: string[];
};

/**
 * Canonical run response shape returned by `call-actor` and `get-actor-run`.
 * Wire shape for `content[]`: `[JSON.stringify(structuredContent), `${summary}\n${nextStep}`]`
 * — see `res/call_actor_redesign_v4.md` § content[] shape for the load-bearing rationale.
 */
export type RunResponse = {
    runId: string;
    actorId: string;
    actorName?: string;
    status: string;
    statusMessage?: string;
    exitCode?: number;
    startedAt?: string;
    finishedAt?: string;
    stats?: {
        runTimeSecs?: number;
        computeUnits?: number;
        memMaxBytes?: number;
    };
    storages: {
        dataset?: RunDataset;
        keyValueStore?: RunKeyValueStore;
    };
    summary: string;
    nextStep: string;
};

export type FetchActorRunResult = {
    run: ActorRun;
    structuredContent: RunResponse;
};

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Translate Apify slash-notation field paths to dot-notation. */
function slashToDot(field: string): string {
    return field.replace(/\//g, '.');
}

/**
 * Drop undefined and null keys. Apify's SDK returns null for fields it doesn't have (e.g.
 * an unnamed default dataset's `name`), and the response shape declares no nullable fields, so we
 * filter both to keep the response clean and pass `getActorRunOutputSchema` validation.
 */
function omitNullish<T extends Record<string, unknown>>(obj: T): T {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v !== undefined && v !== null) out[k] = v;
    }
    return out as T;
}

function toIsoString(value: Date | string | undefined | null): string | undefined {
    if (!value) return undefined;
    return value instanceof Date ? value.toISOString() : value;
}

function buildStats(run: ActorRun): RunResponse['stats'] | undefined {
    const stats = run.stats as ActorRun['stats'] | undefined;
    if (!stats) return undefined;
    const out = omitNullish({
        runTimeSecs: stats.runTimeSecs,
        computeUnits: stats.computeUnits,
        memMaxBytes: stats.memMaxBytes,
    });
    return Object.keys(out).length > 0 ? out : undefined;
}

function buildRunDataset(run: ActorRun, datasetMeta: Dataset | null, resolvedItemCount?: number): RunDataset | undefined {
    if (!run.defaultDatasetId) return undefined;
    if (!datasetMeta) {
        return { id: run.defaultDatasetId };
    }
    return omitNullish({
        id: datasetMeta.id,
        name: datasetMeta.name,
        title: datasetMeta.title,
        itemCount: resolvedItemCount ?? datasetMeta.itemCount,
        cleanItemCount: datasetMeta.cleanItemCount,
        fields: datasetMeta.fields?.map(slashToDot),
    });
}

function buildRunKeyValueStore(run: ActorRun, listKeysResult: KeyValueClientListKeysResult | null): RunKeyValueStore | undefined {
    if (!run.defaultKeyValueStoreId) return undefined;
    if (!listKeysResult) {
        return { id: run.defaultKeyValueStoreId };
    }
    const keys = listKeysResult.items.map((k) => k.key);
    // Empty KV: surface only the id (matches non-terminal shape) instead of `keys: [], keyCount: 0`.
    if (keys.length === 0 && !listKeysResult.isTruncated) {
        return { id: run.defaultKeyValueStoreId };
    }
    // The Apify listKeys endpoint does not report a true total. When the page is not truncated,
    // we know the page count equals the total; when truncated, omit keyCount and let the agent
    // detect "more keys exist" from `keys.length === KV_KEYS_LIMIT`.
    const keyCount = listKeysResult.isTruncated ? undefined : keys.length;
    return omitNullish({ id: run.defaultKeyValueStoreId, keys, keyCount });
}

function errMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Apify's pagination counter is eventually consistent (~5s post-terminal). Probe with `listItems({ limit: 1 })`
 * when `itemCount === 0` on a SUCCEEDED run — if the probe returns items, surface the larger count.
 * Returns the resolved item count, or `undefined` if the dataset id is unknown / we shouldn't override.
 */
async function resolveItemCountWithLagFallback(
    client: ApifyClient,
    run: ActorRun,
    datasetMeta: Dataset | null,
    mcpSessionId?: string,
): Promise<number | undefined> {
    if (run.status !== 'SUCCEEDED' || !datasetMeta || !run.defaultDatasetId) return datasetMeta?.itemCount;
    if (datasetMeta.itemCount > 0) return datasetMeta.itemCount;
    try {
        // `total` is the dataset's true count from the SDK; `items.length` is capped by `limit` and
        // would undercount whenever lag has hidden more than `ITEM_COUNT_PROBE_LIMIT` items.
        const first = await client.dataset(run.defaultDatasetId).listItems({ limit: ITEM_COUNT_PROBE_LIMIT });
        if ((first.total ?? 0) > 0) return first.total;
        // One retry: the listItems total can lag past terminal — give propagation a brief budget.
        await sleep(ITEM_COUNT_RETRY_DELAY_MS);
        const second = await client.dataset(run.defaultDatasetId).listItems({ limit: ITEM_COUNT_PROBE_LIMIT });
        return second.total ?? 0;
    } catch (error) {
        log.warning('itemCount lag-fallback probe failed', { datasetId: run.defaultDatasetId, mcpSessionId, errMessage: errMessage(error) });
        return datasetMeta.itemCount;
    }
}

async function actorNameForActorId(client: ApifyClient, actorId: string | undefined, mcpSessionId?: string): Promise<string | undefined> {
    if (!actorId) return undefined;
    try {
        const actor = await client.actor(actorId).get();
        return actor ? `${actor.username}/${actor.name}` : undefined;
    } catch (error) {
        log.warning('Failed to fetch actor name', { actId: actorId, mcpSessionId, errMessage: errMessage(error) });
        return undefined;
    }
}

// -----------------------------------------------------------------------------
// Status templates — one summary + nextStep per Apify status
// -----------------------------------------------------------------------------

function elapsedSecs(run: ActorRun): number {
    if (!run.startedAt) return 0;
    const startedAtMs = run.startedAt instanceof Date ? run.startedAt.getTime() : new Date(run.startedAt).getTime();
    return Math.max(0, Math.round((Date.now() - startedAtMs) / 1000));
}

function pollHint(runId: string): string {
    return `Use ${HelperTools.ACTOR_RUNS_GET} with runId=${runId} and waitSecs=${POLL_HINT_WAIT_SECS} to`;
}

type KvSummary =
    | { hasKv: true; kvId: string; keys: string[]; keyCountLabel: string; summarySuffix: string }
    | { hasKv: false; summarySuffix: '' };

/**
 * `buildRunKeyValueStore` omits `keyCount` on truncation; surface that as "at least N keys"
 * instead of silently substituting `keys.length`.
 */
function summarizeKv(keyValueStore?: RunKeyValueStore): KvSummary {
    const kvId = keyValueStore?.id;
    const keys = keyValueStore?.keys ?? [];
    if (!kvId || keys.length === 0) {
        return { hasKv: false, summarySuffix: '' };
    }
    const reportedKeyCount = keyValueStore.keyCount;
    const kvTruncated = reportedKeyCount === undefined && keys.length === KV_KEYS_LIMIT;
    const n = reportedKeyCount ?? keys.length;
    const keyCountLabel = kvTruncated ? `at least ${KV_KEYS_LIMIT} keys` : `${n} ${n === 1 ? 'key' : 'keys'}`;
    return { hasKv: true, kvId, keys, keyCountLabel, summarySuffix: ` Key-value store has ${keyCountLabel}.` };
}

function buildSucceededSummaryNextStep(
    runTimeSecs: number,
    dataset?: RunDataset,
    keyValueStore?: RunKeyValueStore,
): { summary: string; nextStep: string } {
    const itemCount = dataset?.itemCount;
    const datasetId = dataset?.id;
    const kv = summarizeKv(keyValueStore);

    // Dataset is primary. nextStep stays dataset-only (one primary action) but the summary mentions
    // KV when both exist so the caller can see the run also produced key-value records.
    if (itemCount !== undefined && itemCount > 0 && datasetId) {
        const fields = dataset?.fields ?? [];
        const fieldsHint = fields.length > 0
            ? ` Available fields (dot notation): ${fields.join(', ')} — pass via fields="..." to project.`
            : '';
        return {
            summary: `SUCCEEDED in ${runTimeSecs}s. ${itemCount} ${itemCount === 1 ? 'item' : 'items'}; ${fields.length} fields available.${kv.summarySuffix}`,
            nextStep: `Use ${HelperTools.DATASET_GET_ITEMS} with datasetId=${datasetId} and limit=20 to fetch items (${itemCount} total).${fieldsHint} Preview with limit=3.`,
        };
    }

    // datasetId known but metadata unavailable (transient fetch failure on a terminal run). Don't
    // claim "no output found" — point the agent at dataset items so they can verify directly.
    if (itemCount === undefined && datasetId) {
        return {
            summary: `SUCCEEDED in ${runTimeSecs}s. Dataset metadata unavailable.${kv.summarySuffix}`,
            nextStep: `Use ${HelperTools.DATASET_GET_ITEMS} with datasetId=${datasetId} and limit=20 to inspect output.`,
        };
    }

    // KV store is rarely the primary output for Apify actors (mostly SDK state / intermediate data),
    // so we don't recommend it as `nextStep` — but `kv.summarySuffix` keeps it visible in the summary
    // when records exist, so callers can still discover them.
    return {
        summary: `SUCCEEDED in ${runTimeSecs}s. No dataset items found.${kv.summarySuffix}`,
        nextStep: `Inspect statusMessage and stats in this response; if the missing output was unexpected, re-run ${HelperTools.ACTOR_CALL} with adjusted input.`,
    };
}

function buildTimedOutSummaryNextStep(
    runTimeSecs: number,
    dataset?: RunDataset,
    keyValueStore?: RunKeyValueStore,
): { summary: string; nextStep: string } {
    const datasetId = dataset?.id;
    const kv = summarizeKv(keyValueStore);

    // TIMED-OUT branches on `datasetId` (not `itemCount > 0`) so an empty partial dataset is still
    // surfaced as the primary follow-up — partial output is the diagnostic signal here.
    if (datasetId) {
        const itemCount = dataset?.itemCount ?? 0;
        const fields = dataset?.fields ?? [];
        return {
            summary: `TIMED-OUT after ${runTimeSecs}s.${kv.summarySuffix}`,
            nextStep: `Use ${HelperTools.DATASET_GET_ITEMS} with datasetId=${datasetId} and limit=20 to fetch any partial output (${itemCount} ${itemCount === 1 ? 'item' : 'items'} written). Available fields: ${fields.length > 0 ? fields.join(', ') : 'none'}.`,
        };
    }

    return {
        summary: `TIMED-OUT after ${runTimeSecs}s.${kv.summarySuffix}`,
        nextStep: `Inspect statusMessage and stats in this response; the run produced no dataset to fetch.`,
    };
}

/**
 * Build {summary, nextStep} per status. Returns one primary action — never two.
 */
export function buildStatusSummaryNextStep(params: {
    run: ActorRun;
    dataset?: RunDataset;
    keyValueStore?: RunKeyValueStore;
}): { summary: string; nextStep: string } {
    const { run, dataset, keyValueStore } = params;
    const { id: runId, status, statusMessage } = run;
    // The platform usually populates stats.runTimeSecs on terminal runs, but not always (e.g.
    // ABORTED before stats flushed). Fall back to `elapsedSecs(run)` so summaries don't render
    // as literal "undefined".
    const runTimeSecs = run.stats?.runTimeSecs ?? elapsedSecs(run);

    switch (status) {
        case 'READY':
            return {
                summary: `READY. Run ${runId} was created but has not started.`,
                nextStep: `${pollHint(runId)} wait for progress.`,
            };
        case 'RUNNING':
            return {
                summary: `RUNNING for ${elapsedSecs(run)}s. ${statusMessage || 'In progress'}.`,
                nextStep: `${pollHint(runId)} poll for completion.`,
            };
        case 'TIMING-OUT':
            return {
                summary: `TIMING-OUT after ${elapsedSecs(run)}s. ${statusMessage || 'Run-time limit reached; cleanup in progress'}.`,
                nextStep: `${pollHint(runId)} observe terminal state.`,
            };
        case 'ABORTING':
            return {
                summary: `ABORTING after ${elapsedSecs(run)}s. ${statusMessage || 'Cancellation in progress'}.`,
                nextStep: `${pollHint(runId)} observe terminal state.`,
            };
        case 'SUCCEEDED':
            return buildSucceededSummaryNextStep(runTimeSecs, dataset, keyValueStore);
        case 'FAILED':
            return {
                summary: `FAILED after ${runTimeSecs}s${statusMessage ? `: ${statusMessage}` : ''}.`,
                nextStep: `Diagnose using statusMessage and exitCode in this response; re-run ${HelperTools.ACTOR_CALL} with adjusted input if the cause is fixable.`,
            };
        case 'ABORTED':
            return {
                summary: `ABORTED after ${runTimeSecs}s${statusMessage ? `: ${statusMessage}` : ''}.`,
                nextStep: `Use ${HelperTools.ACTOR_CALL} again if you want to rerun the Actor.`,
            };
        case 'TIMED-OUT':
            return buildTimedOutSummaryNextStep(runTimeSecs, dataset, keyValueStore);
        default:
            return {
                summary: `${status}. Run ${runId}.`,
                nextStep: `${pollHint(runId)} check current state.`,
            };
    }
}

// -----------------------------------------------------------------------------
// Wait + progress
// -----------------------------------------------------------------------------

type WaitResult =
    | { kind: 'ok'; run: ActorRun; actorName: string | undefined }
    | { kind: 'not-found' }
    | { kind: 'aborted' };

/**
 * Wait for an Actor run to reach a terminal state, racing against an optional client abort signal.
 *
 * `onAbort` is invoked when the client cancels the request mid-wait, before the function returns
 * `{ kind: 'aborted' }`. Callers that need to cancel the underlying run on client abort pass it;
 * read-only callers omit it.
 */
async function waitForRunWithProgress(opts: {
    client: ApifyClient;
    runId: string;
    waitSecs: number;
    progressTracker?: ProgressTracker | null;
    abortSignal?: AbortSignal;
    mcpSessionId?: string;
    onAbort?: (runId: string, client: ApifyClient) => Promise<void>;
}): Promise<WaitResult> {
    const { client, runId, waitSecs, progressTracker, abortSignal, mcpSessionId, onAbort } = opts;

    if (abortSignal?.aborted) return { kind: 'aborted' };

    // Race the initial run.get() against the abort signal so a mid-call cancel returns promptly
    // instead of blocking on the HTTP fetch (the SDK does not accept an AbortSignal directly).
    const initial = await raceAbort(client.run(runId).get(), abortSignal);
    if (initial === ABORT) return { kind: 'aborted' };
    if (!initial) return { kind: 'not-found' };
    let run = initial;

    // Kick off the actor-name fetch but don't await yet — it runs in parallel with the wait/progress
    // branch below, and is only strictly needed for the progressTracker label and the response field.
    const actorNamePromise = actorNameForActorId(client, run.actId, mcpSessionId);

    if (waitSecs > 0 && !TERMINAL_RUN_STATUSES.has(run.status)) {
        if (progressTracker) {
            const trackerLabel = (await actorNamePromise) ?? 'actor';
            await progressTracker.updateProgress(formatRunStatusMessage(trackerLabel, run));
            progressTracker.startActorRunUpdates(runId, client, trackerLabel, run);
        }

        // Race waitForFinish against the client's abort signal so a cancelled request returns
        // promptly instead of blocking up to `waitSecs`. Behavior on abort is delegated to `onAbort`.
        let raced: ActorRun | typeof ABORT;
        try {
            raced = await raceAbort(client.run(runId).waitForFinish({ waitSecs }), abortSignal);
        } finally {
            progressTracker?.stop();
        }

        if (raced === ABORT) {
            await onAbort?.(runId, client);
            return { kind: 'aborted' };
        }
        run = raced;

        // The platform may write the final statusMessage just after the status flips; re-fetch on
        // terminal so the response (and any final progress emission) sees the freshest snapshot.
        if (TERMINAL_RUN_STATUSES.has(run.status)) {
            const finalRun = (await client.run(runId).get().catch(() => undefined)) ?? run;
            if (progressTracker) {
                await progressTracker.updateProgress(formatRunStatusMessage((await actorNamePromise) ?? 'actor', finalRun));
            }
            run = finalRun;
        }
    }

    return { kind: 'ok', run, actorName: await actorNamePromise };
}

// -----------------------------------------------------------------------------
// Main fetch — used by both default and widget variants
// -----------------------------------------------------------------------------

export async function fetchActorRunData(params: {
    runId: string;
    waitSecs: number;
    client: ApifyClient;
    progressTracker?: ProgressTracker | null;
    abortSignal?: AbortSignal;
    mcpSessionId?: string;
    onAbort?: (runId: string, client: ApifyClient) => Promise<void>;
}): Promise<{ error: object } | { aborted: true } | { result: FetchActorRunResult }> {
    const { runId, waitSecs, client, progressTracker, abortSignal, mcpSessionId, onAbort } = params;

    const waitResult = await waitForRunWithProgress({ client, runId, waitSecs, progressTracker, abortSignal, mcpSessionId, onAbort });
    if (waitResult.kind === 'aborted') return { aborted: true };
    if (waitResult.kind === 'not-found') {
        return {
            error: buildMCPResponse({
                texts: [`Run with ID '${runId}' not found.`],
                isError: true,
                telemetry: { toolStatus: TOOL_STATUS.SOFT_FAIL, failureCategory: FAILURE_CATEGORY.INVALID_INPUT },
            }),
        };
    }
    const { run, actorName } = waitResult;

    log.debug('Get Actor run', { runId, status: run.status, mcpSessionId, waitSecs });

    let datasetInfo: Dataset | null = null;
    let kvListResult: KeyValueClientListKeysResult | null = null;

    if (TERMINAL_RUN_STATUSES.has(run.status)) {
        // Per-promise catches: a single transient metadata fetch failure must not hard-fail the
        // whole call. The response still carries the storage id, which is enough for the agent
        // to fetch items / records directly.
        const [datasetFetched, kvFetched] = await Promise.all([
            run.defaultDatasetId
                ? client.dataset(run.defaultDatasetId).get().catch((error) => {
                    log.warning('Failed to fetch dataset metadata', { datasetId: run.defaultDatasetId, mcpSessionId, errMessage: errMessage(error) });
                    return null;
                })
                : Promise.resolve(null),
            run.defaultKeyValueStoreId
                ? client.keyValueStore(run.defaultKeyValueStoreId).listKeys({ limit: KV_KEYS_LIMIT }).catch((error) => {
                    log.warning('Failed to list KV store keys', {
                        keyValueStoreId: run.defaultKeyValueStoreId,
                        mcpSessionId,
                        errMessage: errMessage(error),
                    });
                    return null;
                })
                : Promise.resolve(null),
        ]);
        datasetInfo = datasetFetched ?? null;
        kvListResult = kvFetched ?? null;
    }

    const resolvedItemCount = await resolveItemCountWithLagFallback(client, run, datasetInfo, mcpSessionId);
    const dataset = buildRunDataset(run, datasetInfo, resolvedItemCount);
    const keyValueStore = buildRunKeyValueStore(run, kvListResult);
    const { summary, nextStep } = buildStatusSummaryNextStep({ run, dataset, keyValueStore });

    const structuredContent: RunResponse = {
        runId: run.id,
        actorId: run.actId,
        actorName,
        status: run.status,
        statusMessage: run.statusMessage ?? undefined,
        exitCode: run.exitCode ?? undefined,
        startedAt: toIsoString(run.startedAt),
        finishedAt: toIsoString(run.finishedAt),
        stats: buildStats(run),
        storages: { dataset, keyValueStore },
        summary,
        nextStep,
    };

    return { result: { run, structuredContent } };
}
