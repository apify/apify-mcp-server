import type { ApifyClient } from '../../apify_client.js';
import { FAILURE_CATEGORY, TOOL_STATUS } from '../../const.js';
import { buildMCPResponse } from '../../utils/mcp.js';

type RunStorageKind = 'dataset' | 'keyValueStore';

const STORAGE_LABEL: Record<RunStorageKind, { field: 'defaultDatasetId' | 'defaultKeyValueStoreId'; label: string }> = {
    dataset: { field: 'defaultDatasetId', label: 'dataset' },
    keyValueStore: { field: 'defaultKeyValueStoreId', label: 'key-value store' },
};

/**
 * Resolve the default dataset or key-value store ID from a run.
 * On failure (run missing, storage missing) returns a soft-fail MCP error response.
 */
export async function resolveRunDefaultStorage(
    client: ApifyClient,
    runId: string,
    kind: RunStorageKind,
): Promise<{ id: string } | { error: ReturnType<typeof buildMCPResponse> }> {
    const { field, label } = STORAGE_LABEL[kind];
    const run = await client.run(runId).get();
    if (!run) {
        return {
            error: buildMCPResponse({
                texts: [`Run '${runId}' not found.`],
                isError: true,
                telemetry: { toolStatus: TOOL_STATUS.SOFT_FAIL, failureCategory: FAILURE_CATEGORY.INVALID_INPUT },
            }),
        };
    }
    const id = run[field];
    if (!id) {
        return {
            error: buildMCPResponse({
                texts: [`Run '${runId}' has no default ${label}.`],
                isError: true,
                telemetry: { toolStatus: TOOL_STATUS.SOFT_FAIL, failureCategory: FAILURE_CATEGORY.INVALID_INPUT },
            }),
        };
    }
    return { id };
}
