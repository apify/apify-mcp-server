import type { ApifyClientOptions } from 'apify';
import { ApifyClient as _ApifyClient } from 'apify-client';
import type { AxiosRequestConfig } from 'axios';

import { PLACEHOLDER_APIFY_TOKEN, USER_AGENT_ORIGIN } from './const.js';

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
         * Placeholder token handling (Smithery/Docker Hub).
         *
         * We use a placeholder token to allow non-interactive environments (Smithery scans,
         * Docker Hub builds) to traverse tool-loading paths without real secrets. The placeholder
         * does not authorize any API calls. If detected here, we drop it and run unauthenticated,
         * which is enough for server startup and listing tools (where possible).
         */
        if (options.token?.toLowerCase() === PLACEHOLDER_APIFY_TOKEN) {
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
