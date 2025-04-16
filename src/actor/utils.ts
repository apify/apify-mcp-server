import { Actor } from 'apify';

import type { ActorRunData } from './types.js';

export function getActorRunData(): ActorRunData | null {
    return Actor.isAtHome() ? {
        id: process.env.ACTOR_RUN_ID,
        actId: process.env.ACTOR_ID,
        userId: process.env.APIFY_USER_ID,
        startedAt: process.env.ACTOR_STARTED_AT,
        finishedAt: null,
        status: 'RUNNING',
        meta: {
            origin: process.env.APIFY_META_ORIGIN,
        },
        options: {
            build: process.env.ACTOR_BUILD_NUMBER,
            memoryMbytes: process.env.ACTOR_MEMORY_MBYTES,
        },
        buildId: process.env.ACTOR_BUILD_ID,
        defaultKeyValueStoreId: process.env.ACTOR_DEFAULT_KEY_VALUE_STORE_ID,
        defaultDatasetId: process.env.ACTOR_DEFAULT_DATASET_ID,
        defaultRequestQueueId: process.env.ACTOR_DEFAULT_REQUEST_QUEUE_ID,
        buildNumber: process.env.ACTOR_BUILD_NUMBER,
        containerUrl: process.env.ACTOR_WEB_SERVER_URL,
        standbyUrl: process.env.ACTOR_STANDBY_URL,
    } : null;
}
