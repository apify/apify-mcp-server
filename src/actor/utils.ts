import { parse } from 'node:querystring';

import { Actor } from 'apify';

import { processInput } from './input.js';
import type { ActorRunData, Input } from './types.js';
import { addTool, getActorsAsTools, removeTool } from '../tools/index.js';
import type { ToolWrap } from '../types.js';

export function parseInputParamsFromUrl(url: string): Input {
    const query = url.split('?')[1] || '';
    const params = parse(query) as unknown as Input;
    return processInput(params);
}

/**
 * Process input parameters and get tools
 * If URL contains query parameter `actors`, return tools from Actors otherwise return null.
 * @param url
 */
export async function processParamsGetTools(url: string) {
    const input = parseInputParamsFromUrl(url);
    let tools: ToolWrap[] = [];
    if (input.actors) {
        tools = await getActorsAsTools(input.actors as string[]);
    }
    if (input.enableActorAutoLoading) {
        tools.push(addTool, removeTool);
    }
    return tools;
}

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
