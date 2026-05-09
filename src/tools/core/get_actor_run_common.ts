import type { ActorRun, Dataset, KeyValueClientListKeysResult } from 'apify-client';
import dedent from 'dedent';
import { z } from 'zod';

import log from '@apify/log';

import type { ApifyClient } from '../../apify_client.js';
import { FAILURE_CATEGORY, HelperTools, TOOL_STATUS } from '../../const.js';
import { getWidgetConfig, WIDGET_URIS } from '../../resources/widgets.js';
import type { HelperTool, ToolInputSchema } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { buildMCPResponse, buildUsageMeta } from '../../utils/mcp.js';
import { formatRunStatusMessage, type ProgressTracker, TERMINAL_RUN_STATUSES } from '../../utils/progress.js';
import { getActorRunOutputSchema } from '../structured_output_schemas.js';

/** Bumped on breaking shape changes; additive changes do not bump. */
export const RESPONSE_VERSION = 'v4';

/** Cap on `storages.keyValueStore.keys` array length. */
export const KV_KEYS_LIMIT = 50;

/** Maximum value for `waitSecs`. Stays under the 60s tool-call ceiling several MCP clients impose. */
export const WAIT_SECS_MAX = 45;

/** Default `waitSecs` for `get-actor-run`. Intentionally non-zero so polling callers wait briefly by default. */
export const WAIT_SECS_DEFAULT = 30;

/** Limit for the dataset metadata `itemCount=0` lag-fallback probe. */
const ITEM_COUNT_PROBE_LIMIT = 1;

/**
 * Zod schema for `get-actor-run` arguments — shared between default and widget variants.
 */
export const getActorRunArgs = z.object({
    runId: z.string()
        .min(1)
        .describe('The ID of the Actor run.'),
    waitSecs: z.number()
        .int()
        .min(0)
        .max(WAIT_SECS_MAX)
        .optional()
        .default(WAIT_SECS_DEFAULT)
        .describe(
            `Maximum seconds to wait for the run to reach a terminal state (SUCCEEDED, FAILED, ABORTED, TIMED-OUT). `
            + `0 returns immediately with the current status. Cap: ${WAIT_SECS_MAX}. Default: ${WAIT_SECS_DEFAULT}. `
            + `When the caller passes _meta.progressToken and waitSecs > 0, the server emits notifications/progress on each statusMessage change observed during the wait.`,
        ),
});

const GET_ACTOR_RUN_DESCRIPTION = `Get detailed information about a specific Actor run.

Returns the canonical run-result shape: status, storages (dataset / key-value store), stats, summary, nextStep.
- summary describes the past (e.g. "SUCCEEDED in 22s. 47 items; 3 fields available.").
- nextStep prescribes one primary follow-up action with identifiers interpolated (e.g. "Use get-dataset-items with datasetId=...").
- waitSecs (0–${WAIT_SECS_MAX}, default ${WAIT_SECS_DEFAULT}) waits up to that many seconds for terminal status before returning.

USAGE:
- Use to check the status of a run started with ${HelperTools.ACTOR_CALL}.
- Pass waitSecs > 0 to block until terminal (or until the cap elapses).
- If \`${HelperTools.ACTOR_CALL_WIDGET}\` or \`${HelperTools.ACTOR_RUNS_GET_WIDGET}\` rendered a widget for this run, do NOT poll here — the widget self-polls.

USAGE EXAMPLES:
- user_input: Show details of run y2h7sK3Wc
- user_input: Wait for run y2h7sK3Wc to finish`;

/**
 * Shared tool metadata for `get-actor-run` — everything except the `call` handler.
 * Mode-independent. Widget `_meta` lives in the widget variant.
 */
export const getActorRunMetadata: Omit<HelperTool, 'call'> = {
    type: 'internal',
    name: HelperTools.ACTOR_RUNS_GET,
    description: GET_ACTOR_RUN_DESCRIPTION,
    inputSchema: z.toJSONSchema(getActorRunArgs) as ToolInputSchema,
    outputSchema: getActorRunOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(getActorRunArgs)),
    paymentRequired: true,
    annotations: {
        title: 'Get Actor run',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
};

// -----------------------------------------------------------------------------
// Canonical response shape (v4)
// -----------------------------------------------------------------------------

export type CanonicalRunStorageStats = {
    readCount?: number;
    writeCount?: number;
    deleteCount?: number;
    listCount?: number;
    storageBytes?: number;
};

export type CanonicalRunDataset = {
    id: string;
    name?: string;
    title?: string;
    createdAt?: string;
    modifiedAt?: string;
    itemCount?: number;
    cleanItemCount?: number;
    fields?: string[];
    stats?: CanonicalRunStorageStats;
};

export type CanonicalRunKeyValueStore = {
    id: string;
    name?: string;
    title?: string;
    createdAt?: string;
    modifiedAt?: string;
    stats?: CanonicalRunStorageStats;
    keyCount?: number;
    keys?: string[];
};

export type CanonicalRunResponse = {
    responseVersion: typeof RESPONSE_VERSION;
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
        dataset?: CanonicalRunDataset;
        keyValueStore?: CanonicalRunKeyValueStore;
    };
    summary: string;
    nextStep: string;
};

export type FetchActorRunResult = {
    run: ActorRun;
    structuredContent: CanonicalRunResponse;
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
 * an unnamed default dataset's `name`), and the v4 shape declares no nullable fields, so we
 * filter both to keep the response clean and pass `getActorRunOutputSchema` validation.
 */
function compact<T extends Record<string, unknown>>(obj: T): T {
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

function buildStats(run: ActorRun): CanonicalRunResponse['stats'] | undefined {
    const stats = run.stats as ActorRun['stats'] | undefined;
    if (!stats) return undefined;
    const out = compact({
        runTimeSecs: stats.runTimeSecs,
        computeUnits: stats.computeUnits,
        memMaxBytes: stats.memMaxBytes,
    });
    return Object.keys(out).length > 0 ? out : undefined;
}

function buildDatasetBlock(run: ActorRun, datasetMeta: Dataset | null, resolvedItemCount?: number): CanonicalRunDataset | undefined {
    if (!run.defaultDatasetId) return undefined;
    if (!datasetMeta) {
        return { id: run.defaultDatasetId };
    }
    return compact({
        id: datasetMeta.id,
        name: datasetMeta.name,
        title: datasetMeta.title,
        createdAt: toIsoString(datasetMeta.createdAt),
        modifiedAt: toIsoString(datasetMeta.modifiedAt),
        itemCount: resolvedItemCount ?? datasetMeta.itemCount,
        cleanItemCount: datasetMeta.cleanItemCount,
        fields: datasetMeta.fields?.map(slashToDot),
        stats: datasetMeta.stats ? compact({ ...datasetMeta.stats }) : undefined,
    });
}

function buildKeyValueStoreBlock(run: ActorRun, listKeysResult: KeyValueClientListKeysResult | null): CanonicalRunKeyValueStore | undefined {
    if (!run.defaultKeyValueStoreId) return undefined;
    if (!listKeysResult) {
        return { id: run.defaultKeyValueStoreId };
    }
    const keys = listKeysResult.items.map((k) => k.key);
    // The Apify listKeys endpoint does not report a true total. When the page is not truncated,
    // we know the page count equals the total; when truncated, omit keyCount and let the agent
    // detect "more keys exist" from `keys.length === KV_KEYS_LIMIT`.
    const keyCount = listKeysResult.isTruncated ? undefined : keys.length;
    return compact({
        id: run.defaultKeyValueStoreId,
        keys,
        keyCount,
    });
}

function errMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function tryGetDatasetMeta(client: ApifyClient, datasetId: string | undefined, mcpSessionId?: string): Promise<Dataset | null> {
    if (!datasetId) return null;
    try {
        return (await client.dataset(datasetId).get()) ?? null;
    } catch (error) {
        log.warning('Failed to fetch dataset metadata', { datasetId, mcpSessionId, errMessage: errMessage(error) });
        return null;
    }
}

async function tryListKvKeys(client: ApifyClient, kvStoreId: string | undefined, mcpSessionId?: string): Promise<KeyValueClientListKeysResult | null> {
    if (!kvStoreId) return null;
    try {
        return await client.keyValueStore(kvStoreId).listKeys({ limit: KV_KEYS_LIMIT });
    } catch (error) {
        log.warning('Failed to list key-value store keys', { kvStoreId, mcpSessionId, errMessage: errMessage(error) });
        return null;
    }
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
        const probe = await client.dataset(run.defaultDatasetId).listItems({ limit: ITEM_COUNT_PROBE_LIMIT });
        return Math.max(datasetMeta.itemCount, probe.items.length);
    } catch (error) {
        log.warning('itemCount lag-fallback probe failed', { datasetId: run.defaultDatasetId, mcpSessionId, errMessage: errMessage(error) });
        return datasetMeta.itemCount;
    }
}

async function resolveActorName(client: ApifyClient, actId: string | undefined, mcpSessionId?: string): Promise<string | undefined> {
    if (!actId) return undefined;
    try {
        const actor = await client.actor(actId).get();
        return actor ? `${actor.username}/${actor.name}` : undefined;
    } catch (error) {
        log.warning('Failed to fetch actor name', { actId, mcpSessionId, errMessage: errMessage(error) });
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
    return `Use ${HelperTools.ACTOR_RUNS_GET} with runId=${runId} and waitSecs=10 to`;
}

/**
 * Build {summary, nextStep} per the v4 status templates table. Returns one primary action — never two.
 */
export function buildStatusTemplate(params: {
    run: ActorRun;
    dataset?: CanonicalRunDataset;
    keyValueStore?: CanonicalRunKeyValueStore;
}): { summary: string; nextStep: string } {
    const { run, dataset, keyValueStore } = params;
    const { id: runId, status, statusMessage } = run;
    const runTimeSecs = run.stats?.runTimeSecs;
    const itemCount = dataset?.itemCount ?? 0;
    const fields = dataset?.fields ?? [];
    const fieldCount = fields.length;
    const datasetId = dataset?.id;
    const kvId = keyValueStore?.id;
    const keys = keyValueStore?.keys ?? [];
    const keyCount = keyValueStore?.keyCount ?? keys.length;

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
        case 'SUCCEEDED': {
            if (itemCount > 0 && datasetId) {
                return {
                    summary: `SUCCEEDED in ${runTimeSecs}s. ${itemCount} items; ${fieldCount} fields available.`,
                    nextStep: `Use ${HelperTools.DATASET_GET_ITEMS} with datasetId=${datasetId} and limit=20 to fetch items (${itemCount} total). Available fields (dot notation): ${fields.join(', ')} — pass via fields="..." to project. Preview with limit=3.`,
                };
            }
            if (keys.length > 0 && kvId) {
                const others = keys.filter((k) => k !== 'OUTPUT');
                if (keys.includes('OUTPUT')) {
                    return {
                        summary: `SUCCEEDED in ${runTimeSecs}s. Output written to key-value store (${keyCount} keys).`,
                        nextStep: `Use ${HelperTools.KEY_VALUE_STORE_RECORD_GET} with keyValueStoreId=${kvId} and recordKey="OUTPUT" to read the main output. Other keys: ${others.join(', ') || 'none'}.`,
                    };
                }
                return {
                    summary: `SUCCEEDED in ${runTimeSecs}s. Output written to key-value store (${keyCount} keys).`,
                    nextStep: `Use ${HelperTools.KEY_VALUE_STORE_RECORD_GET} with keyValueStoreId=${kvId} and one of these keys (as recordKey): ${keys.join(', ')}.`,
                };
            }
            return {
                summary: `SUCCEEDED in ${runTimeSecs}s. No dataset items and no key-value records were found.`,
                nextStep: `Inspect statusMessage and stats in this response; if the missing output was unexpected, re-run ${HelperTools.ACTOR_CALL} with adjusted input.`,
            };
        }
        case 'FAILED':
            return {
                summary: `FAILED after ${runTimeSecs}s${statusMessage ? `: ${statusMessage}` : ''}.`,
                nextStep: `Diagnose using statusMessage and exitCode in this response; re-run ${HelperTools.ACTOR_CALL} with adjusted input if the cause is fixable.`,
            };
        case 'ABORTED':
            return {
                summary: `ABORTED after ${runTimeSecs}s${statusMessage ? `: ${statusMessage}` : ''}.`,
                nextStep: `Use ${HelperTools.ACTOR_CALL} again if you want to rerun the actor.`,
            };
        case 'TIMED-OUT':
            if (datasetId) {
                return {
                    summary: `TIMED-OUT after ${runTimeSecs}s.`,
                    nextStep: `Use ${HelperTools.DATASET_GET_ITEMS} with datasetId=${datasetId} and limit=20 to fetch any partial output (${itemCount} items written). Available fields: ${fields.length > 0 ? fields.join(', ') : 'none'}.`,
                };
            }
            return {
                summary: `TIMED-OUT after ${runTimeSecs}s.`,
                nextStep: `Inspect statusMessage and stats in this response; the run produced no dataset to fetch.`,
            };
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

/**
 * If the run isn't already terminal and `waitSecs > 0`, polls Apify up to `waitSecs` seconds and
 * (when a `progressTracker` is provided) emits `notifications/progress` on each statusMessage change.
 * Returns the final ActorRun snapshot.
 */
async function waitForRunWithProgress(opts: {
    client: ApifyClient;
    runId: string;
    waitSecs: number;
    progressTracker?: ProgressTracker | null;
    actorName?: string;
    initial: ActorRun;
}): Promise<ActorRun> {
    const { client, runId, waitSecs, progressTracker, actorName, initial } = opts;

    if (waitSecs <= 0 || TERMINAL_RUN_STATUSES.has(initial.status)) {
        return initial;
    }

    const trackerLabel = actorName ?? 'actor';
    if (progressTracker) {
        await progressTracker.updateProgress(formatRunStatusMessage(trackerLabel, initial));
        progressTracker.startActorRunUpdates(runId, client, trackerLabel, initial);
    }

    let waited: ActorRun;
    try {
        waited = await client.run(runId).waitForFinish({ waitSecs });
    } finally {
        progressTracker?.stop();
    }

    // The platform may write the final statusMessage just after the status flips; re-fetch so the
    // response and the final progress emission see the same terminal snapshot.
    if (progressTracker && TERMINAL_RUN_STATUSES.has(waited.status)) {
        const finalRun = (await client.run(runId).get().catch(() => undefined)) ?? waited;
        await progressTracker.updateProgress(formatRunStatusMessage(trackerLabel, finalRun));
        return finalRun;
    }
    return waited;
}

// -----------------------------------------------------------------------------
// Main fetch — used by both default and widget variants
// -----------------------------------------------------------------------------

export async function fetchActorRunData(params: {
    runId: string;
    waitSecs: number;
    client: ApifyClient;
    progressTracker?: ProgressTracker | null;
    mcpSessionId?: string;
}): Promise<{ error: object } | { result: FetchActorRunResult }> {
    const { runId, waitSecs, client, progressTracker, mcpSessionId } = params;

    const initialRun = await client.run(runId).get();
    if (!initialRun) {
        return {
            error: buildMCPResponse({
                texts: [`Run with ID '${runId}' not found.`],
                isError: true,
                telemetry: { toolStatus: TOOL_STATUS.SOFT_FAIL, failureCategory: FAILURE_CATEGORY.INVALID_INPUT },
            }),
        };
    }

    // Resolve actor name in parallel with the wait. Lost cosmetic: progress notification
    // labels during the wait fall back to "actor" instead of "username/name", but the response
    // still carries the resolved name once both promises settle.
    const [actorName, run] = await Promise.all([
        resolveActorName(client, initialRun.actId, mcpSessionId),
        waitForRunWithProgress({ client, runId, waitSecs, progressTracker, initial: initialRun }),
    ]);

    log.debug('Get actor run', { runId, status: run.status, mcpSessionId, waitSecs });

    let datasetMeta: Dataset | null = null;
    let kvKeys: KeyValueClientListKeysResult | null = null;
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
        [datasetMeta, kvKeys] = await Promise.all([
            tryGetDatasetMeta(client, run.defaultDatasetId, mcpSessionId),
            tryListKvKeys(client, run.defaultKeyValueStoreId, mcpSessionId),
        ]);
    }

    const resolvedItemCount = await resolveItemCountWithLagFallback(client, run, datasetMeta, mcpSessionId);
    const dataset = buildDatasetBlock(run, datasetMeta, resolvedItemCount);
    const keyValueStore = buildKeyValueStoreBlock(run, kvKeys);
    const { summary, nextStep } = buildStatusTemplate({ run, dataset, keyValueStore });

    const structuredContent: CanonicalRunResponse = compact({
        responseVersion: RESPONSE_VERSION,
        runId: run.id,
        actorId: run.actId,
        actorName,
        status: run.status,
        statusMessage: run.statusMessage,
        exitCode: run.exitCode,
        startedAt: toIsoString(run.startedAt),
        finishedAt: toIsoString(run.finishedAt),
        stats: buildStats(run),
        storages: compact({ dataset, keyValueStore }),
        summary,
        nextStep,
    });

    return { result: { run, structuredContent } };
}

// -----------------------------------------------------------------------------
// Response builders
// -----------------------------------------------------------------------------

export function buildGetActorRunError(runId: string, error: unknown): ReturnType<typeof buildMCPResponse> {
    return buildMCPResponse({
        texts: [dedent`
            Failed to get Actor run '${runId}': ${errMessage(error)}.
            Please verify the run ID and ensure that the run exists.
        `],
        isError: true,
        telemetry: { toolStatus: TOOL_STATUS.SOFT_FAIL },
    });
}

/**
 * Build the success response. Default mode emits text = `summary\nnextStep` (carries identifiers via interpolation).
 * Widget mode emits a short pointer text and adds widget `_meta` keys.
 */
export function buildGetActorRunSuccessResponse(
    params: FetchActorRunResult & { widget: boolean },
): ReturnType<typeof buildMCPResponse> {
    const { run, structuredContent, widget } = params;

    if (!widget) {
        return buildMCPResponse({
            texts: [`${structuredContent.summary}\n${structuredContent.nextStep}`],
            structuredContent,
            _meta: buildUsageMeta(run),
        });
    }

    return buildMCPResponse({
        texts: [`Actor run ${structuredContent.runId} status: ${structuredContent.status}. A run widget has been rendered.`],
        structuredContent,
        _meta: {
            ...(getWidgetConfig(WIDGET_URIS.ACTOR_RUN)?.meta ?? {}),
            ...(buildUsageMeta(run) ?? {}),
            'openai/widgetDescription': `Actor run progress for ${structuredContent.actorName ?? structuredContent.runId}`,
        },
    });
}
