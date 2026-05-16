import type { ActorRun, Dataset, KeyValueClientListKeysResult } from 'apify-client';

import log from '@apify/log';

import type { ApifyClient } from '../../apify_client.js';
import { FAILURE_CATEGORY, HelperTools, TOOL_STATUS } from '../../const.js';
import { getWidgetConfig, WIDGET_URIS } from '../../resources/widgets.js';
import { buildMCPResponse } from '../../utils/mcp.js';
import { formatRunStatusMessage, type ProgressTracker, TERMINAL_RUN_STATUSES } from '../../utils/progress.js';

/** Cap on `storages.keyValueStores.default.keys` array length. */
const KV_KEYS_LIMIT = 50;

/** nextStep text for widget-rendered responses: suppresses LLM polling. */
export const WIDGET_NO_POLL_NEXT_STEP = 'Widget is rendering live progress. Do NOT poll — the widget self-updates until completion.';

/** Maximum value for `waitSecs`. Stays under the 60s tool-call ceiling several MCP clients impose. */
export const WAIT_SECS_MAX = 45;

const POLL_HINT_WAIT_SECS = 30;

/** Limit for the dataset metadata `itemCount=0` lag-fallback probe. */
const ITEM_COUNT_PROBE_LIMIT = 1;

/**
 * Delays before each `itemCount=0` lag-fallback probe. Apify docs state `itemCount` / `cleanItemCount`
 * can lag up to ~5s after `pushItem`. We probe immediately, then again at +1s/+3s/+5s so a
 * SUCCEEDED-but-empty dataset has the full propagation window to surface real items.
 */
const ITEM_COUNT_PROBE_DELAYS_MS = [0, 1000, 2000, 2000] as const;

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
    // Already aborted: `addEventListener('abort', ...)` won't fire (the event has passed), so the
    // listener would never resolve and the race would block on `promise`.
    if (abortSignal.aborted) return ABORT;
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
 * Storage shape mirrors `ActorRunStorageIds` from the Apify client — a map of alias → storage
 * object where `default` is always the primary entry. Using the same plural alias-map structure
 * means named Actor storages (e.g. `storages.datasets.results`) can be added without introducing
 * new field names. Each value extends the bare Apify ID string with fetched metadata.
 */
export type RunStorages = {
    datasets?: { default: RunDataset; [alias: string]: RunDataset };
    keyValueStores?: { default: RunKeyValueStore; [alias: string]: RunKeyValueStore };
};

/**
 * Canonical run response shape returned by `call-actor` and `get-actor-run`.
 * content[0] mirrors structuredContent as JSON (spec compat); content[1] is the
 * LLM-readable summary + nextStep narrative.
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
    storages: RunStorages;
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
    waitSecs: number | undefined,
    mcpSessionId?: string,
    abortSignal?: AbortSignal,
): Promise<number | undefined> {
    if (run.status !== 'SUCCEEDED' || !datasetMeta || !run.defaultDatasetId) return datasetMeta?.itemCount;
    if (datasetMeta.itemCount > 0) return datasetMeta.itemCount;
    try {
        // `total` is the dataset's true count from the SDK; `items.length` is capped by `limit` and
        // would undercount whenever lag has hidden more than `ITEM_COUNT_PROBE_LIMIT` items.
        // When `waitSecs === 0` the caller asked for an immediate response (e.g. the widget's initial
        // render), so we do a single immediate probe and skip the delayed retries — otherwise the
        // ~5s lag-recovery schedule would block "immediate" callers for the full window.
        const delays = waitSecs !== 0 ? ITEM_COUNT_PROBE_DELAYS_MS : [0];
        let lastTotal = 0;
        for (const delay of delays) {
            if (delay > 0) {
                const sleepResult = await raceAbort(sleep(delay), abortSignal);
                if (sleepResult === ABORT) return lastTotal;
            }
            const result = await raceAbort(
                client.dataset(run.defaultDatasetId).listItems({ limit: ITEM_COUNT_PROBE_LIMIT }),
                abortSignal,
            );
            if (result === ABORT) return lastTotal;
            lastTotal = result.total ?? 0;
            if (lastTotal > 0) return lastTotal;
        }
        return lastTotal;
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

/**
 * Render an upstream `statusMessage` as a clearly-attributed suffix (` Actor status: "..."`).
 * Attribution prevents readers from mistaking the upstream message (which can be stale relative
 * to elapsed time) for our own narrative; the trailing period is stripped so the surrounding
 * template's period doesn't produce `..`.
 */
function statusMessageLine(statusMessage: string | null | undefined): string {
    if (!statusMessage) return '';
    const trimmed = statusMessage.trim().replace(/\.+$/, '');
    if (!trimmed) return '';
    return ` Actor status: "${trimmed}".`;
}

/**
 * Suffix surfacing partial dataset progress on non-terminal runs (e.g. " 127 results so far.").
 * Empty when the count is unknown or zero so callers don't see "0 results so far" on early polls.
 * Worded generically — Actors aren't always scraping; "results" reads naturally for any output.
 */
function progressSuffix(dataset?: RunDataset): string {
    const n = dataset?.itemCount;
    if (n === undefined || n === 0) return '';
    return ` ${n} ${n === 1 ? 'result' : 'results'} so far.`;
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

function fieldsProjectionHint(fields: string[] | undefined): string {
    if (!fields || fields.length === 0) return '';
    return ` Available fields (dot notation): ${fields.join(', ')} — pass via fields="..." to project.`;
}

function buildSucceededSummaryNextStep(
    runTimeSecs: number,
    statusMessage: string | null | undefined,
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
        return {
            summary: `SUCCEEDED in ${runTimeSecs}s. ${itemCount} ${itemCount === 1 ? 'item' : 'items'}; ${fields.length} fields available.${kv.summarySuffix}`,
            nextStep: `Use ${HelperTools.DATASET_GET_ITEMS} with datasetId=${datasetId} and limit=20 to fetch items (${itemCount} total).${fieldsProjectionHint(fields)}`,
        };
    }

    // datasetId known but metadata unavailable (transient fetch failure on a terminal run). Don't
    // claim "no output found" — point the agent at dataset items so they can verify directly.
    if (itemCount === undefined && datasetId) {
        return {
            summary: `SUCCEEDED in ${runTimeSecs}s. Dataset metadata unavailable.${statusMessageLine(statusMessage)}${kv.summarySuffix}`,
            nextStep: `Use ${HelperTools.DATASET_GET_ITEMS} with datasetId=${datasetId} and limit=20 to inspect output.`,
        };
    }

    // Metadata can report itemCount === 0 briefly after SUCCEEDED (eventual consistency). Surface the
    // same fetch-first guidance as TIMED-OUT with an empty partial dataset — never imply "re-run only".
    if (itemCount === 0 && datasetId) {
        return {
            summary: `SUCCEEDED in ${runTimeSecs}s. No dataset items found.${statusMessageLine(statusMessage)}${kv.summarySuffix}`,
            nextStep: `Use ${HelperTools.DATASET_GET_ITEMS} with datasetId=${datasetId} and limit=20 to verify output (metadata reports 0 items).${fieldsProjectionHint(dataset?.fields)}`,
        };
    }

    // KV store is rarely the primary output for Apify actors (mostly SDK state / intermediate data),
    // so we don't recommend it as `nextStep` — but `kv.summarySuffix` keeps it visible in the summary
    // when records exist, so callers can still discover them. Surface the upstream statusMessage so
    // a text-only reader sees the actor's own diagnostic (often the only signal here).
    return {
        summary: `SUCCEEDED in ${runTimeSecs}s. No dataset items found.${statusMessageLine(statusMessage)}${kv.summarySuffix}`,
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
                summary: `READY. Run ${runId} was created and is about to start.`,
                nextStep: `${pollHint(runId)} wait for progress.`,
            };
        case 'RUNNING':
            return {
                summary: `RUNNING for ${elapsedSecs(run)}s.${statusMessageLine(statusMessage) || ' In progress.'}${progressSuffix(dataset)}`,
                nextStep: `${pollHint(runId)} poll for completion.`,
            };
        case 'TIMING-OUT':
            return {
                summary: `TIMING-OUT after ${elapsedSecs(run)}s.${statusMessageLine(statusMessage) || ' Run-time limit reached; cleanup in progress.'}${progressSuffix(dataset)}`,
                nextStep: `${pollHint(runId)} observe terminal state.`,
            };
        case 'ABORTING':
            return {
                summary: `ABORTING after ${elapsedSecs(run)}s.${statusMessageLine(statusMessage) || ' Cancellation in progress.'}${progressSuffix(dataset)}`,
                nextStep: `${pollHint(runId)} observe terminal state.`,
            };
        case 'SUCCEEDED':
            return buildSucceededSummaryNextStep(runTimeSecs, statusMessage, dataset, keyValueStore);
        case 'FAILED':
            return {
                summary: `FAILED after ${runTimeSecs}s.${statusMessageLine(statusMessage)}`,
                nextStep: `Diagnose using statusMessage and exitCode in this response; re-run ${HelperTools.ACTOR_CALL} with adjusted input if the cause is fixable.`,
            };
        case 'ABORTED':
            return {
                summary: `ABORTED after ${runTimeSecs}s.${statusMessageLine(statusMessage)}`,
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
    waitSecs?: number;
    actorName?: string;
    progressTracker?: ProgressTracker | null;
    abortSignal?: AbortSignal;
    mcpSessionId?: string;
    onAbort?: (runId: string, client: ApifyClient) => Promise<void>;
}): Promise<WaitResult> {
    const { client, runId, waitSecs, progressTracker, abortSignal, mcpSessionId, onAbort } = opts;

    if (abortSignal?.aborted) {
        await onAbort?.(runId, client);
        return { kind: 'aborted' };
    }

    // Race the initial run.get() against the abort signal so a mid-call cancel returns promptly
    // instead of blocking on the HTTP fetch (the SDK does not accept an AbortSignal directly).
    const initial = await raceAbort(client.run(runId).get(), abortSignal);
    if (initial === ABORT) {
        await onAbort?.(runId, client);
        return { kind: 'aborted' };
    }
    if (!initial) return { kind: 'not-found' };
    let run = initial;

    // Callers that already know the actor name (e.g. `call-actor` just started the run) supply it to
    // skip the lookup entirely. Otherwise kick off the fetch in parallel with the wait/progress branch
    // below — it's only strictly needed for the progressTracker label and the response field.
    const actorNamePromise = opts.actorName !== undefined
        ? Promise.resolve<string | undefined>(opts.actorName)
        : actorNameForActorId(client, run.actId, mcpSessionId);

    if ((waitSecs === undefined || waitSecs > 0) && !TERMINAL_RUN_STATUSES.has(run.status)) {
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
// Immediate start response — for callers that return without waiting
// -----------------------------------------------------------------------------

/**
 * Build a RunResponse from an already-started ActorRun without waiting.
 * Used when waitSecs=0 (default and apps modes) and by widget variants that return immediately.
 * Storage metadata contains IDs only; pollers/widgets fetch updates via get-actor-run.
 *
 * Pass `widget: true` for widget-rendered responses: nextStep is replaced with a no-poll
 * message and widget _meta is included so the UI renders automatically.
 */
export function buildStartRunResponse(params: {
    actorName: string;
    actorRun: ActorRun;
    widget?: boolean;
}): ReturnType<typeof buildMCPResponse> {
    const { actorName, actorRun, widget } = params;

    const dataset = actorRun.defaultDatasetId ? { id: actorRun.defaultDatasetId } : undefined;
    const keyValueStore = actorRun.defaultKeyValueStoreId ? { id: actorRun.defaultKeyValueStoreId } : undefined;

    const { summary, nextStep: computedNextStep } = buildStatusSummaryNextStep({
        run: actorRun,
        dataset,
        keyValueStore,
    });

    const nextStep = widget ? WIDGET_NO_POLL_NEXT_STEP : computedNextStep;

    const structuredContent: RunResponse = {
        runId: actorRun.id,
        actorId: actorRun.actId,
        actorName,
        status: actorRun.status,
        startedAt: toIsoString(actorRun.startedAt),
        storages: {
            ...(dataset && { datasets: { default: dataset } }),
            ...(keyValueStore && { keyValueStores: { default: keyValueStore } }),
        },
        summary,
        nextStep,
    };

    const widgetMeta = widget
        ? {
            ...(getWidgetConfig(WIDGET_URIS.ACTOR_RUN)?.meta ?? {}),
            'openai/widgetDescription': `Actor run progress for ${actorName}`,
        }
        : undefined;

    return buildMCPResponse({
        texts: [JSON.stringify(structuredContent), `${summary}\n${nextStep}`],
        structuredContent,
        ...(widgetMeta && { _meta: widgetMeta }),
    });
}

// -----------------------------------------------------------------------------
// Main fetch — used by both default and widget variants
// -----------------------------------------------------------------------------

export async function fetchActorRunData(params: {
    runId: string;
    waitSecs?: number;
    actorName?: string;
    client: ApifyClient;
    progressTracker?: ProgressTracker | null;
    abortSignal?: AbortSignal;
    mcpSessionId?: string;
    onAbort?: (runId: string, client: ApifyClient) => Promise<void>;
}): Promise<{ error: object } | { aborted: true } | { result: FetchActorRunResult }> {
    const { runId, waitSecs, client, progressTracker, abortSignal, mcpSessionId, onAbort } = params;

    const waitResult = await waitForRunWithProgress({
        client, runId, waitSecs, actorName: params.actorName, progressTracker, abortSignal, mcpSessionId, onAbort,
    });
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

    // Dataset metadata is fetched on every poll (not just terminal) so the summary can surface
    // partial progress on long-running scrapes (e.g. "127 results so far"), giving polling agents
    // real movement instead of the same "In progress." each cycle. The extra round-trip is the
    // accepted UX tradeoff. KV listKeys stays terminal-only — non-terminal summaries don't
    // reference KV records, so fetching them on every poll would be pure waste on the hot path.
    // Per-promise catches: a single transient metadata fetch failure must not hard-fail the
    // whole call. The response still carries the storage id, which is enough for the agent
    // to fetch items / records directly.
    const isTerminal = TERMINAL_RUN_STATUSES.has(run.status);
    const [datasetFetched, kvFetched] = await Promise.all([
        run.defaultDatasetId
            ? client.dataset(run.defaultDatasetId).get().catch((error) => {
                log.warning('Failed to fetch dataset metadata', { datasetId: run.defaultDatasetId, mcpSessionId, errMessage: errMessage(error) });
                return null;
            })
            : Promise.resolve(null),
        run.defaultKeyValueStoreId && isTerminal
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

    const resolvedItemCount = await resolveItemCountWithLagFallback(client, run, datasetInfo, waitSecs, mcpSessionId, abortSignal);
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
        storages: {
            ...(dataset && { datasets: { default: dataset } }),
            ...(keyValueStore && { keyValueStores: { default: keyValueStore } }),
        },
        summary,
        nextStep,
    };

    return { result: { run, structuredContent } };
}
