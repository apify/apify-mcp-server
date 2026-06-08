import { describe, expect, it } from 'vitest';

import { HelperTools, STORAGE_TYPE } from '../../src/const.js';
import { getStorageType } from '../../src/utils/tools.js';

describe('getStorageType()', () => {
    it('maps dataset tools to DATASET', () => {
        expect(getStorageType(HelperTools.DATASET_GET)).toBe(STORAGE_TYPE.DATASET);
        expect(getStorageType(HelperTools.DATASET_LIST_GET)).toBe(STORAGE_TYPE.DATASET);
        expect(getStorageType(HelperTools.DATASET_GET_ITEMS)).toBe(STORAGE_TYPE.DATASET);
        expect(getStorageType(HelperTools.DATASET_SCHEMA_GET)).toBe(STORAGE_TYPE.DATASET);
    });

    it('maps key-value store tools to KEY_VALUE_STORE', () => {
        expect(getStorageType(HelperTools.KEY_VALUE_STORE_GET)).toBe(STORAGE_TYPE.KEY_VALUE_STORE);
        expect(getStorageType(HelperTools.KEY_VALUE_STORE_LIST_GET)).toBe(STORAGE_TYPE.KEY_VALUE_STORE);
        expect(getStorageType(HelperTools.KEY_VALUE_STORE_KEYS_GET)).toBe(STORAGE_TYPE.KEY_VALUE_STORE);
        expect(getStorageType(HelperTools.KEY_VALUE_STORE_RECORD_GET)).toBe(STORAGE_TYPE.KEY_VALUE_STORE);
    });

    it('returns null for non-storage tools', () => {
        expect(getStorageType(HelperTools.ACTOR_CALL)).toBeNull();
        expect(getStorageType(HelperTools.STORE_SEARCH)).toBeNull();
        expect(getStorageType('apify/rag-web-browser')).toBeNull();
        expect(getStorageType('')).toBeNull();
    });
});
