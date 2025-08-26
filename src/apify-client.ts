import type { ApifyClientOptions } from 'apify';
import { ApifyClient as _ApifyClient } from 'apify-client';
import type { AxiosRequestConfig } from 'axios';

import { USER_AGENT_ORIGIN } from './const.js';

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

export function getApifyAPIBaseUrl(): string {
    // Workaround for Actor server where the platform APIFY_API_BASE_URL did not work with getActorDefinition from actors.ts
    if (process.env.APIFY_IS_AT_HOME) return 'https://api.apify.com';
    return process.env.APIFY_API_BASE_URL || 'https://api.apify.com';
}

export class ApifyClient extends _ApifyClient {
    constructor(options: ApifyClientOptions) {
        /**
         * In order to publish to DockerHub, we need to run their build task to validate our MCP server.
         * This was failing since we were sending this dummy token to Apify in order to build the Actor tools.
         * So if we encounter this dummy value, we remove it to use Apify client as unauthenticated, which is sufficient
         * for server start and listing of tools.
         */
        if (options.token?.toLowerCase() === 'your-apify-token') {
            // eslint-disable-next-line no-param-reassign
            delete options.token;
        }

        super({
            ...options,
            baseUrl: getApifyAPIBaseUrl(),
            requestInterceptors: [addUserAgent],
        });
    }
}
