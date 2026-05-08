import type { ApifyClient } from '../../apify_client.js';
import { FAILURE_CATEGORY, TOOL_STATUS } from '../../const.js';
import { buildMCPResponse } from '../../utils/mcp.js';

type RunStorageKind = 'dataset' | 'keyValueStore';

type McpResponse = ReturnType<typeof buildMCPResponse>;

const STORAGE_LABEL: Record<RunStorageKind, { field: 'defaultDatasetId' | 'defaultKeyValueStoreId'; label: string }> = {
    dataset: { field: 'defaultDatasetId', label: 'dataset' },
    keyValueStore: { field: 'defaultKeyValueStoreId', label: 'key-value store' },
};

/** Returns a soft-fail MCP response on failure rather than throwing. */
export async function resolveRunDefaultStorage(
    client: ApifyClient,
    runId: string,
    kind: RunStorageKind,
): Promise<{ id: string } | { error: McpResponse }> {
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
