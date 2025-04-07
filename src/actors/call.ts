import { Actor, type ApifyClientOptions } from 'apify';
import type { ActorCallOptions } from 'apify-client';
import { ApifyClient } from 'apify-client';
import type { AxiosRequestConfig } from 'axios';

import { USER_AGENT_ORIGIN } from '../const.js';
import { log } from '../logger.js';

/**
* Calls an Apify actor and retrieves the dataset items.
*
* It requires the `APIFY_TOKEN` environment variable to be set.
* If the `APIFY_IS_AT_HOME` the dataset items are pushed to the Apify dataset.
*
* @param {string} actorName - The name of the actor to call.
* @param {ActorCallOptions} callOptions - The options to pass to the actor.
* @param {unknown} input - The input to pass to the actor.
* @returns {Promise<object[]>} - A promise that resolves to an array of dataset items.
* @throws {Error} - Throws an error if the `APIFY_TOKEN` is not set
*/
export async function callActorGetDataset(
    actorName: string,
    input: unknown,
    apifyToken: string,
    callOptions: ActorCallOptions | undefined = undefined,
): Promise<object[]> {
    const name = actorName;
    try {
        log.info(`Calling Actor ${name} with input: ${JSON.stringify(input)}`);

        const options: ApifyClientOptions = { requestInterceptors: [addUserAgent] };
        const client = new ApifyClient({ ...options, token: apifyToken });
        const actorClient = client.actor(name);

        const results = await actorClient.call(input, callOptions);
        const dataset = await client.dataset(results.defaultDatasetId).listItems();
        log.info(`Actor ${name} finished with ${dataset.items.length} items`);

        return dataset.items;
    } catch (error) {
        log.error(`Error calling actor: ${error}. Actor: ${name}, input: ${JSON.stringify(input)}`);
        throw new Error(`Error calling Actor: ${error}`);
    }
}

/**
 * Adds a User-Agent header to the request config.
 * @param config
 * @private
 */
function addUserAgent(config: AxiosRequestConfig): AxiosRequestConfig {
    const updatedConfig = { ...config };
    updatedConfig.headers = updatedConfig.headers ?? {};
    updatedConfig.headers['User-Agent'] = `${updatedConfig.headers['User-Agent'] ?? ''}; ${USER_AGENT_ORIGIN}`;
    return updatedConfig;
}
