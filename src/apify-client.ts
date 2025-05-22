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

export class ApifyClient extends _ApifyClient {
    constructor(options: ApifyClientOptions) {
        super({
            ...options,
            requestInterceptors: [addUserAgent],
        });
    }
}
