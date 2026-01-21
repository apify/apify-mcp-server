/**
 * Tool categories and their associated tools.
 * This file is separate from index.ts to avoid circular dependencies.
 */
import type { ToolCategory } from '../types.js';
import { callActor } from './actor.js';
import { getDataset, getDatasetItems, getDatasetSchema } from './dataset.js';
import { getUserDatasetsList } from './dataset_collection.js';
import { fetchActorDetailsTool } from './fetch-actor-details.js';
import { fetchActorSchemaTool } from './fetch-actor-schema.js';
import { fetchApifyDocsTool } from './fetch-apify-docs.js';
import { getActorOutput } from './get-actor-output.js';
import { getHtmlSkeleton } from './get-html-skeleton.js';
import { addTool } from './helpers.js';
import { getKeyValueStore, getKeyValueStoreKeys, getKeyValueStoreRecord } from './key_value_store.js';
import { getUserKeyValueStoresList } from './key_value_store_collection.js';
import { abortActorRun, getActorRun, getActorRunLog } from './run.js';
import { getUserRunsList } from './run_collection.js';
import { searchActorsInternalTool } from './search-actors-internal.js';
import { searchApifyDocsTool } from './search-apify-docs.js';
import { searchActors } from './store_collection.js';

export const toolCategories = {
    experimental: [
        addTool,
    ],
    actors: [
        fetchActorDetailsTool,
        fetchActorSchemaTool,
        searchActors,
        searchActorsInternalTool,
        callActor,
    ],
    docs: [
        searchApifyDocsTool,
        fetchApifyDocsTool,
    ],
    runs: [
        getActorRun,
        getUserRunsList,
        getActorRunLog,
        abortActorRun,
    ],
    storage: [
        getDataset,
        getDatasetItems,
        getDatasetSchema,
        getActorOutput,
        getKeyValueStore,
        getKeyValueStoreKeys,
        getKeyValueStoreRecord,
        getUserDatasetsList,
        getUserKeyValueStoresList,
    ],
    dev: [
        getHtmlSkeleton,
    ],
};

export const toolCategoriesEnabledByDefault: ToolCategory[] = [
    'actors',
    'docs',
];
