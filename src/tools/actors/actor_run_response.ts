import type { ActorRun, Dataset, KeyValueClientListKeysResult } from 'apify-client';

import log from '@apify/log';

import type { ApifyClient } from '../../apify_client.js';
import { DATASET_SIZE_HINT_BYTES, HELPER_TOOLS, NARROW_OUTPUT_HINT } from '../../const.js';
import { buildActorRunWidgetMeta } from '../../resources/widgets.js';
import type { ConsoleLinkContext } from '../../types.js';
import {
    buildConsoleDatasetUrl,
    buildConsoleKeyValueStoreUrl,
    buildConsoleRunUrl,
    VERBATIM_LINKS_NUDGE,
} from '../../utils/console_link.js';
import { logHttpError } from '../../utils/logging.js';
import { respondOk, respondUserError, type ToolResponse } from '../../utils/mcp.js';
import { formatRunStatusMessage, type ProgressTracker, TERMINAL_RUN_STATUSES } from '../../utils/progress.js';
import { cleanEmptyProperties } from '../../utils/schema_generation.js';
import { DEFAULT_DATASET_ITEMS_LIMIT } from '../storage/get_dataset_items.js';

/** Cap on `storages.keyValueStores.default.keys` array length. */
const KV_KEYS_LIMIT = 50;

/** nextStep text for widget-rendered responses: suppresses LLM polling. */
export const WIDGET_NO_POLL_NEXT_STEP =
    'Widget is rendering live progress. Do NOT poll — the widget self-updates until completion.';

/** Maximum value for `waitSecs`. Stays under the 60s tool-call ceiling several MCP clients impose. */
export const WAIT_SECS_MAX = 45;

/** Default seconds to wait for completion on `call-actor` and direct actor tools. `get-actor-run` also defaults to 30. */
export const CALL_ACTOR_WAIT_SECS_DEFAULT = 30;

const POLL_HINT_WAIT_SECS = 30;

/** Limit for the dataset metadata `itemCount=0` lag-fallback probe. */
const ITEM_COUNT_PROBE_LIMIT = 1;

/**
 * Delays before each `itemCount=0` lag-fallback probe. Apify docs state `itemCount`
 * can lag up to ~5s after `pushItem`. We probe immediately, then again at +1s/+3s/+5s so a
 * SUCCEEDED-but-empty dataset has the full propagation window to surface real items.
 */
const ITEM_COUNT_PROBE_DELAYS_MS = [0, 1000, 2000, 2000] as const;

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
    /** Personalized Apify Console link; set only for Console UI token sessions. */
    apifyConsoleUrl?: string;
    name?: string;
    title?: string;
    itemCount?: number;
    /**
     * Uncompressed size of the dataset in bytes (Apify `stats.inflatedBytes`). Items are stored as BSON,
     * so this approximates — not exactly equals — the JSON size fetched into context. The single-dataset
     * GET response does not return it (only the dataset-list endpoint does), so it is normally absent.
     */
    inflatedBytes?: number;
    /**
     * Dot-notation field paths. Pure-numeric segments (array indices) are stripped and the
     * list is deduped at build time, so callers receive a flat unique projection-valid list
     * rather than the inflated `entities.hashtags.0.text`, `entities.hashtags.1.text`, ...
     * shape Apify returns for array-heavy datasets.
     */
    fields?: string[];
    /**
     * JSON Schema fragment for each dataset row. Populated only by direct actor tools (where
     * the target Actor is known at tools/list time, so historical row shape can be looked up
     * via `actorStore`). Absent for `call-actor` / `get-actor-run` (dynamic target).
     */
    itemsSchema?: { type: 'object'; properties: Record<string, unknown> };
};

export type RunKeyValueStore = {
    id: string;
    /** Personalized Apify Console link; set only for Console UI token sessions. */
    apifyConsoleUrl?: string;
    name?: string;
    title?: string;
    keyCount?: number;
    keys?: string[];
};

/**
 * Storage shape mirrors `ActorRunStorageIds` from the Apify client — a map of alias → storage
 * object where `default` is always the primary entry. Using the same plural alias-map structure
 * means named Actor storages (e.g. `storages.datasets.results`) can be added without introducing
 * new field names. On the completed-run path (`get-actor-run` / `call-actor` with wait) every entry
 * — `default` and aliases — is enriched with fetched metadata. The immediate start-run path returns
 * before any fetch, so there every entry carries `{ id }` only.
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
    /** Personalized Apify Console link to the run; set only for Console UI token sessions. */
    apifyConsoleUrl?: string;
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

/**
 * Apify expands array indices in dataset fields (e.g. `entities.hashtags.0.text`,
 * `entities.hashtags.1.text`, ... `entities.hashtags.14.text`), so deeply-nested or
 * array-heavy schemas balloon into hundreds of redundant paths. Strip pure-numeric
 * segments and dedupe; the resulting paths stay valid projections for `fields="..."`.
 *
 * Exported for direct unit testing of edge cases (empty input, all-numeric paths) —
 * production callers go through `normalizeDatasetFields`.
 */
export function collapseArrayIndices(fields: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const field of fields) {
        const collapsed = field
            .split('.')
            .filter((segment) => !/^\d+$/.test(segment))
            .join('.');
        if (collapsed && !seen.has(collapsed)) {
            seen.add(collapsed);
            result.push(collapsed);
        }
    }
    return result;
}

/**
 * Canonical normalization for an Apify-returned `dataset.fields` array: translate
 * slash-notation to dot-notation AND collapse expanded array indices. Used at every
 * MCP tool boundary that surfaces dataset field metadata (`buildRunDataset` for
 * `call-actor` / `get-actor-run`, and `get-dataset` for the raw API passthrough).
 */
export function normalizeDatasetFields(fields: string[]): string[] {
    return collapseArrayIndices(fields.map((f) => f.replace(/\//g, '.')));
}

export function toIsoString(value: Date | string | undefined | null): string | undefined {
    if (!value) return undefined;
    return value instanceof Date ? value.toISOString() : value;
}

export function buildStats(run: ActorRun): RunResponse['stats'] | undefined {
    const stats = run.stats as ActorRun['stats'] | undefined;
    if (!stats) return undefined;
    return cleanEmptyProperties({
        runTimeSecs: stats.runTimeSecs,
        computeUnits: stats.computeUnits,
        memMaxBytes: stats.memMaxBytes,
    }) as RunResponse['stats'] | undefined;
}

function buildRunDataset(id: string, datasetMeta: Dataset | null, resolvedItemCount?: number): RunDataset {
    if (!datasetMeta) {
        return { id };
    }
    const inflatedBytes = (datasetMeta.stats as { inflatedBytes?: number } | undefined)?.inflatedBytes;
    return cleanEmptyProperties({
        id,
        name: datasetMeta.name,
        title: datasetMeta.title,
        itemCount: resolvedItemCount ?? datasetMeta.itemCount,
        // Undeclared on the apify-client `DatasetStats` type and read defensively. The platform
        // reports `0` when it doesn't populate the size yet; treat that as absent (a literal
        // "0 bytes" is misleading for a non-empty dataset). `cleanEmptyProperties` drops undefined.
        inflatedBytes: inflatedBytes && inflatedBytes > 0 ? inflatedBytes : undefined,
        fields: datasetMeta.fields ? normalizeDatasetFields(datasetMeta.fields) : undefined,
    }) as RunDataset;
}

function buildRunKeyValueStore(id: string, listKeysResult: KeyValueClientListKeysResult | null): RunKeyValueStore {
    if (!listKeysResult) {
        return { id };
    }
    const keys = listKeysResult.items.map((k) => k.key);
    // Empty KV: surface only the id (matches non-terminal shape) instead of `keys: [], keyCount: 0`.
    if (keys.length === 0 && !listKeysResult.isTruncated) {
        return { id };
    }
    // The Apify listKeys endpoint does not report a true total. When the page is not truncated,
    // we know the page count equals the total; when truncated, omit keyCount and let the agent
    // detect "more keys exist" from `keys.length === KV_KEYS_LIMIT`.
    const keyCount = listKeysResult.isTruncated ? undefined : keys.length;
    return cleanEmptyProperties({ id, keys, keyCount }) as RunKeyValueStore;
}

/**
 * alias → id map for one storage type, with `default` (the run's `defaultXId`) guaranteed present
 * if known. Mirrors `ActorRunStorageIds`, whose `default` key is always populated for a real run.
 * The `if (defaultId && !ids.default)` guard is defensive: the platform guarantees
 * `storageIds.<type>.default` equals `run.defaultXId`, so the fallback only matters when `storageIds`
 * is absent entirely.
 */
function buildStorageAliasIds(
    aliasMap: Record<string, string> | undefined,
    defaultId?: string,
): Record<string, string> {
    const ids: Record<string, string> = { ...(aliasMap ?? {}) };
    if (defaultId && !ids.default) ids.default = defaultId;
    return ids;
}

/**
 * Wrap an alias → entry map with the `default`-presence guard: returns undefined when the map lacks
 * `default`, so the caller omits the storage type entirely (RunStorages requires `default` whenever a
 * storage type is present). The completed-run path passes its assembled enriched entries; the
 * start-run path passes id-only entries built from `buildStorageAliasIds`.
 */
function buildStorageEntries<T>(entries: Record<string, T>): { default: T; [alias: string]: T } | undefined {
    if (!('default' in entries)) return undefined;
    return entries as { default: T; [alias: string]: T };
}

async function buildStorageEntriesFromIds<T>(
    ids: Record<string, string>,
    buildEntry: (id: string) => Promise<T>,
): Promise<{ default: T; [alias: string]: T } | undefined> {
    const pairs = await Promise.all(
        Object.entries(ids).map(async ([alias, id]) => [alias, await buildEntry(id)] as const),
    );
    return buildStorageEntries(Object.fromEntries(pairs));
}

function errMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Fetch dataset metadata; a transient failure logs and yields null so the entry keeps its id only. */
async function fetchDatasetMeta(client: ApifyClient, id: string, mcpSessionId?: string): Promise<Dataset | null> {
    try {
        return (await client.dataset(id).get()) ?? null;
    } catch (error) {
        log.warning('Failed to fetch dataset metadata', { datasetId: id, mcpSessionId, errMessage: errMessage(error) });
        return null;
    }
}

/** List KV store keys; a transient failure logs and yields null so the entry keeps its id only. */
async function fetchKvKeys(
    client: ApifyClient,
    id: string,
    mcpSessionId?: string,
): Promise<KeyValueClientListKeysResult | null> {
    try {
        return await client.keyValueStore(id).listKeys({ limit: KV_KEYS_LIMIT });
    } catch (error) {
        log.warning('Failed to list KV store keys', {
            keyValueStoreId: id,
            mcpSessionId,
            errMessage: errMessage(error),
        });
        return null;
    }
}

/**
 * For Console UI token sessions, sets the Apify Console `apifyConsoleUrl` on the run and its default
 * storages and returns the narrative suffix (the links + the verbatim nudge) in a single pass.
 * No-op returning `''` for non-Console sessions (`linkContext` undefined).
 */
export function applyConsoleLinks(response: RunResponse, linkContext: ConsoleLinkContext | undefined): string {
    if (!linkContext) return '';
    response.apifyConsoleUrl = buildConsoleRunUrl(linkContext, response.runId);
    const parts = [`run ${response.apifyConsoleUrl}`];
    const dataset = response.storages.datasets?.default;
    if (dataset) {
        dataset.apifyConsoleUrl = buildConsoleDatasetUrl(linkContext, dataset.id);
        parts.push(`dataset ${dataset.apifyConsoleUrl}`);
    }
    const keyValueStore = response.storages.keyValueStores?.default;
    if (keyValueStore) {
        keyValueStore.apifyConsoleUrl = buildConsoleKeyValueStoreUrl(linkContext, keyValueStore.id);
        parts.push(`key-value store ${keyValueStore.apifyConsoleUrl}`);
    }
    return `\nApify Console: ${parts.join(' | ')}\n${VERBATIM_LINKS_NUDGE}`;
}

/**
 * Apify's pagination counter is eventually consistent (~5s post-terminal). Probe with `listItems({ limit: 1 })`
 * after a SUCCEEDED run reports `itemCount === 0`. Callers decide when the probe is needed.
 */
async function fetchDatasetItemCountWithLagFallback(
    client: ApifyClient,
    datasetId: string,
    waitSecs: number | undefined,
    abortSignal?: AbortSignal,
): Promise<number> {
    const delays = waitSecs !== 0 ? ITEM_COUNT_PROBE_DELAYS_MS : [0];
    let itemCount = 0;

    try {
        // `total` is the dataset's true count from the SDK; `items.length` is capped by `limit` and
        // would undercount whenever lag has hidden more than `ITEM_COUNT_PROBE_LIMIT` items.
        // When `waitSecs === 0` the caller asked for an immediate response (e.g. the widget's initial
        // render), so we do a single immediate probe and skip the delayed retries — otherwise the
        // ~5s lag-recovery schedule would block "immediate" callers for the full window.
        for (const delay of delays) {
            if (delay > 0) {
                const sleepResult = await raceAbort(
                    new Promise<void>((resolve) => {
                        setTimeout(resolve, delay);
                    }),
                    abortSignal,
                );
                if (sleepResult === ABORT) break;
            }
            const result = await raceAbort(
                client.dataset(datasetId).listItems({ limit: ITEM_COUNT_PROBE_LIMIT }),
                abortSignal,
            );
            if (result === ABORT) break;
            itemCount = result.total ?? 0;
            if (itemCount > 0) break;
        }
    } catch (error) {
        log.warning('itemCount lag-fallback probe failed', {
            datasetId,
            errMessage: errMessage(error),
        });
    }

    return itemCount;
}

async function actorNameForActorId(
    client: ApifyClient,
    actorId: string | undefined,
    mcpSessionId?: string,
): Promise<string | undefined> {
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
    return `Use ${HELPER_TOOLS.ACTOR_RUNS_GET} with runId=${runId} and waitSecs=${POLL_HINT_WAIT_SECS} to`;
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

/**
 * nextStep suffix reporting dataset size. The byte size is always shown when known; the steer to
 * narrow is appended only when it exceeds DATASET_SIZE_HINT_BYTES. `inflatedBytes` is the
 * whole-dataset uncompressed size; shared by get-actor-run and get-dataset.
 */
export function datasetSizeNextStepHint(inflatedBytes: number | undefined): string {
    if (inflatedBytes === undefined || inflatedBytes <= 0) return '';
    const size = ` Full output is ~${inflatedBytes} bytes.`;
    if (inflatedBytes <= DATASET_SIZE_HINT_BYTES) return size;
    return `${size} Fetching all may exceed context; ${NARROW_OUTPUT_HINT}.`;
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
            nextStep: `Use ${HELPER_TOOLS.DATASET_GET_ITEMS} with datasetId=${datasetId} and limit (for example ${DEFAULT_DATASET_ITEMS_LIMIT}) to fetch items (${itemCount} total).${datasetSizeNextStepHint(dataset?.inflatedBytes)}${fieldsProjectionHint(fields)}`,
        };
    }

    // datasetId known but metadata unavailable (transient fetch failure on a terminal run). Don't
    // claim "no output found" — point the agent at dataset items so they can verify directly.
    if (itemCount === undefined && datasetId) {
        return {
            summary: `SUCCEEDED in ${runTimeSecs}s. Dataset metadata unavailable.${statusMessageLine(statusMessage)}${kv.summarySuffix}`,
            nextStep: `Use ${HELPER_TOOLS.DATASET_GET_ITEMS} with datasetId=${datasetId} and limit (for example ${DEFAULT_DATASET_ITEMS_LIMIT}) to inspect output.`,
        };
    }

    // Metadata can report itemCount === 0 briefly after SUCCEEDED (eventual consistency). Surface the
    // same fetch-first guidance as TIMED-OUT with an empty partial dataset — never imply "re-run only".
    if (itemCount === 0 && datasetId) {
        return {
            summary: `SUCCEEDED in ${runTimeSecs}s. No dataset items found.${statusMessageLine(statusMessage)}${kv.summarySuffix}`,
            nextStep: `Use ${HELPER_TOOLS.DATASET_GET_ITEMS} with datasetId=${datasetId} and limit (for example ${DEFAULT_DATASET_ITEMS_LIMIT}) to verify output (metadata reports 0 items).${fieldsProjectionHint(dataset?.fields)}`,
        };
    }

    // KV store is rarely the primary output for Apify actors (mostly SDK state / intermediate data),
    // so we don't recommend it as `nextStep` — but `kv.summarySuffix` keeps it visible in the summary
    // when records exist, so callers can still discover them. Surface the upstream statusMessage so
    // a text-only reader sees the actor's own diagnostic (often the only signal here). The nextStep
    // stays generic ("re-run the Actor"): this builder is shared by get-actor-run / abort-actor-run,
    // which only have a runId and can't know whether the run came from call-actor or a native Actor
    // tool — naming a specific tool would mislead callers (see #1007).
    return {
        summary: `SUCCEEDED in ${runTimeSecs}s. No dataset items found.${statusMessageLine(statusMessage)}${kv.summarySuffix}`,
        nextStep: `Inspect statusMessage and stats in this response; if the missing output was unexpected, re-run the Actor with adjusted input.`,
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
            nextStep: `Use ${HELPER_TOOLS.DATASET_GET_ITEMS} with datasetId=${datasetId} and limit (for example ${DEFAULT_DATASET_ITEMS_LIMIT}) to fetch any partial output (${itemCount} ${itemCount === 1 ? 'item' : 'items'} written). Available fields: ${fields.length > 0 ? fields.join(', ') : 'none'}.`,
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
                nextStep: `Diagnose using statusMessage and exitCode in this response; re-run the Actor with adjusted input if the cause is fixable.`,
            };
        case 'ABORTED':
            return {
                summary: `ABORTED after ${runTimeSecs}s.${statusMessageLine(statusMessage)}`,
                nextStep: `Re-run the Actor if you want to retry.`,
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
    const actorNamePromise =
        opts.actorName !== undefined
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
            const finalRun =
                (await client
                    .run(runId)
                    .get()
                    .catch(() => undefined)) ?? run;
            if (progressTracker) {
                await progressTracker.updateProgress(
                    formatRunStatusMessage((await actorNamePromise) ?? 'actor', finalRun),
                );
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
 * Shared construction for the immediate start response, used by both the base and widget
 * builders below. Returns the full `RunResponse` with the computed (non-widget) `nextStep`;
 * `buildStartRunWidgetResponse` overrides `nextStep` on its own copy.
 */
function buildStartRunSharedContent(actorName: string, actorRun: ActorRun): RunResponse {
    // Start path returns before any metadata fetch, so every entry — default and aliases — is id-only.
    const datasetIds = buildStorageAliasIds(actorRun.storageIds?.datasets, actorRun.defaultDatasetId ?? undefined);
    const kvIds = buildStorageAliasIds(
        actorRun.storageIds?.keyValueStores,
        actorRun.defaultKeyValueStoreId ?? undefined,
    );
    const datasets = buildStorageEntries(
        Object.fromEntries(Object.entries(datasetIds).map(([alias, id]) => [alias, { id }])),
    );
    const keyValueStores = buildStorageEntries(
        Object.fromEntries(Object.entries(kvIds).map(([alias, id]) => [alias, { id }])),
    );

    const { summary, nextStep } = buildStatusSummaryNextStep({
        run: actorRun,
        dataset: datasets?.default,
        keyValueStore: keyValueStores?.default,
    });

    return {
        runId: actorRun.id,
        actorId: actorRun.actId,
        actorName,
        status: actorRun.status,
        startedAt: toIsoString(actorRun.startedAt),
        storages: {
            ...(datasets && { datasets }),
            ...(keyValueStores && { keyValueStores }),
        },
        summary,
        nextStep,
    };
}

/**
 * Build a RunResponse from an already-started ActorRun without waiting.
 * Used when waitSecs=0 (default and apps modes).
 * Storage metadata contains IDs only; pollers fetch updates via get-actor-run.
 */
export function buildStartRunResponse(params: {
    actorName: string;
    actorRun: ActorRun;
    linkContext?: ConsoleLinkContext;
}): ToolResponse {
    const { actorName, actorRun, linkContext } = params;

    const structuredContent = buildStartRunSharedContent(actorName, actorRun);
    const consoleLinks = applyConsoleLinks(structuredContent, linkContext);

    return respondOk(
        [
            JSON.stringify(structuredContent),
            `${structuredContent.summary}\n${structuredContent.nextStep}${consoleLinks}`,
        ],
        { structuredContent },
    );
}

/**
 * Build a RunResponse from an already-started ActorRun for widget-rendered responses:
 * nextStep is replaced with a no-poll message and widget _meta is included so the UI renders
 * automatically. Used only by `*-widget` tools.
 */
export function buildStartRunWidgetResponse(params: { actorName: string; actorRun: ActorRun }): ToolResponse {
    const { actorName, actorRun } = params;

    const base = buildStartRunSharedContent(actorName, actorRun);
    const structuredContent = { ...base, nextStep: WIDGET_NO_POLL_NEXT_STEP };

    return respondOk(
        [JSON.stringify(structuredContent), `${structuredContent.summary}\n${structuredContent.nextStep}`],
        {
            structuredContent,
            meta: buildActorRunWidgetMeta(actorName),
        },
    );
}

// -----------------------------------------------------------------------------
// Main fetch — used by both default and widget variants
// -----------------------------------------------------------------------------

/**
 * Default `onAbort` for callers that want the run cancelled when the MCP request is cancelled.
 * Logs and swallows abort failures so a transient API error doesn't override the original
 * cancellation result.
 */
export const abortRunOnSignal = async (runId: string, client: ApifyClient): Promise<void> => {
    await client
        .run(runId)
        .abort({ gracefully: false })
        .catch((error) => {
            logHttpError(error, 'Error aborting Actor run', { runId });
        });
};

export async function fetchActorRunData(params: {
    runId: string;
    waitSecs?: number;
    actorName?: string;
    client: ApifyClient;
    progressTracker?: ProgressTracker | null;
    abortSignal?: AbortSignal;
    mcpSessionId?: string;
    onAbort?: (runId: string, client: ApifyClient) => Promise<void>;
}): Promise<{ error: ToolResponse } | { aborted: true } | { result: FetchActorRunResult }> {
    const { runId, waitSecs, client, progressTracker, abortSignal, mcpSessionId, onAbort } = params;

    const waitResult = await waitForRunWithProgress({
        client,
        runId,
        waitSecs,
        actorName: params.actorName,
        progressTracker,
        abortSignal,
        mcpSessionId,
        onAbort,
    });
    if (waitResult.kind === 'aborted') return { aborted: true };
    if (waitResult.kind === 'not-found') {
        return {
            error: respondUserError(`Run with ID '${runId}' not found.`),
        };
    }
    const { run, actorName } = waitResult;

    log.debug('Get Actor run', { runId, status: run.status, mcpSessionId, waitSecs });

    // Enrich every storage — default and aliases from `run.storageIds` — with fetched metadata.
    // Dataset metadata is fetched on every poll (not just terminal) so the summary can surface
    // partial progress on long-running scrapes (e.g. "127 results so far"), giving polling agents
    // real movement instead of the same "In progress." each cycle. KV listKeys stays terminal-only —
    // non-terminal summaries don't reference KV records. All fetches run in parallel, so latency is
    // one round-trip regardless of alias count. Per-fetch catches: a single transient failure must
    // not hard-fail the call — that entry still carries its id, enough to fetch items / records.
    const isTerminal = TERMINAL_RUN_STATUSES.has(run.status);
    const isSucceeded = run.status === 'SUCCEEDED';
    const datasetIds = buildStorageAliasIds(run.storageIds?.datasets, run.defaultDatasetId ?? undefined);
    const kvIds = buildStorageAliasIds(run.storageIds?.keyValueStores, run.defaultKeyValueStoreId ?? undefined);

    const [datasets, keyValueStores] = await Promise.all([
        buildStorageEntriesFromIds(datasetIds, async (id) => {
            const meta = await fetchDatasetMeta(client, id, mcpSessionId);
            let itemCount = meta?.itemCount;
            if (isSucceeded && itemCount === 0) {
                itemCount = await fetchDatasetItemCountWithLagFallback(client, id, waitSecs, abortSignal);
            }
            return buildRunDataset(id, meta, itemCount);
        }),
        buildStorageEntriesFromIds(kvIds, async (id) => {
            const keys = isTerminal ? await fetchKvKeys(client, id, mcpSessionId) : null;
            return buildRunKeyValueStore(id, keys);
        }),
    ]);

    // Narrative summarizes the default storages only; aliases are surfaced in structured output.
    const { summary, nextStep } = buildStatusSummaryNextStep({
        run,
        dataset: datasets?.default,
        keyValueStore: keyValueStores?.default,
    });

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
            ...(datasets && { datasets }),
            ...(keyValueStores && { keyValueStores }),
        },
        summary,
        nextStep,
    };

    return { result: { run, structuredContent } };
}
