import { describe, expect, it } from 'vitest';

import { KEY_VALUE_STORE_KEY_MAX_LENGTH, RESOURCE_ID_OR_NAME_MAX_LENGTH } from '../../src/const.js';
import { callActor } from '../../src/tools/actors/call_actor.js';
import { callActorMcpTool } from '../../src/tools/actors/call_actor_mcp_tool.js';
import { fetchActorDetails } from '../../src/tools/actors/fetch_actor_details.js';
import { fetchActorMcpToolList } from '../../src/tools/actors/fetch_actor_mcp_tool_list.js';
import { sendServerActorRequest } from '../../src/tools/actors/send_server_actor_request.js';
import { getDataset } from '../../src/tools/storage/get_dataset.js';
import { getDatasetItems } from '../../src/tools/storage/get_dataset_items.js';
import { getDatasetSchema } from '../../src/tools/storage/get_dataset_schema.js';
import { getKeyValueStore } from '../../src/tools/storage/get_key_value_store.js';
import { getKeyValueStoreKeys } from '../../src/tools/storage/get_key_value_store_keys.js';
import { getKeyValueStoreRecord } from '../../src/tools/storage/get_key_value_store_record.js';
import { callActorWidget } from '../../src/tools/widgets/call_actor_widget.js';
import { fetchActorDetailsWidget } from '../../src/tools/widgets/fetch_actor_details_widget.js';
import type { ToolEntry } from '../../src/types.js';

describe('Actor and storage ID-or-name arguments have a maximum length', () => {
    it.each<{ tool: ToolEntry; field: string; otherArgs: Record<string, unknown> }>([
        { tool: callActor, field: 'actor', otherArgs: { input: {} } },
        { tool: callActorWidget, field: 'actor', otherArgs: { input: {} } },
        { tool: fetchActorDetails, field: 'actor', otherArgs: {} },
        { tool: fetchActorDetailsWidget, field: 'actor', otherArgs: {} },
        { tool: callActorMcpTool, field: 'actor', otherArgs: { tool: 'add' } },
        { tool: fetchActorMcpToolList, field: 'actor', otherArgs: {} },
        { tool: sendServerActorRequest, field: 'actor', otherArgs: { method: 'GET', path: '/' } },
        { tool: getDataset, field: 'datasetId', otherArgs: {} },
        { tool: getDatasetItems, field: 'datasetId', otherArgs: {} },
        { tool: getDatasetSchema, field: 'datasetId', otherArgs: {} },
        { tool: getKeyValueStore, field: 'keyValueStoreId', otherArgs: {} },
        { tool: getKeyValueStoreKeys, field: 'keyValueStoreId', otherArgs: {} },
        { tool: getKeyValueStoreRecord, field: 'keyValueStoreId', otherArgs: { recordKey: 'INPUT' } },
    ])('$tool.name rejects $field longer than the limit', ({ tool, field, otherArgs }) => {
        const withLength = (length: number) => ({ ...otherArgs, [field]: 'a'.repeat(length) });

        expect(tool.ajvValidate(withLength(RESOURCE_ID_OR_NAME_MAX_LENGTH))).toBe(true);
        expect(tool.ajvValidate(withLength(RESOURCE_ID_OR_NAME_MAX_LENGTH + 1))).toBe(false);
    });
});

describe('key-value store record key arguments have a maximum length', () => {
    it.each<{ tool: ToolEntry; field: string; otherArgs: Record<string, unknown> }>([
        { tool: getKeyValueStoreRecord, field: 'recordKey', otherArgs: { keyValueStoreId: 'kv-1' } },
        { tool: getKeyValueStoreKeys, field: 'exclusiveStartKey', otherArgs: { keyValueStoreId: 'kv-1' } },
    ])('$tool.name rejects $field longer than the limit', ({ tool, field, otherArgs }) => {
        const withLength = (length: number) => ({ ...otherArgs, [field]: 'a'.repeat(length) });

        expect(tool.ajvValidate(withLength(KEY_VALUE_STORE_KEY_MAX_LENGTH))).toBe(true);
        expect(tool.ajvValidate(withLength(KEY_VALUE_STORE_KEY_MAX_LENGTH + 1))).toBe(false);
    });
});
