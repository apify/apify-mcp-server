import type { ApifyClientOptions } from 'apify';
import { ApifyClient as _ApifyClient } from 'apify-client';
import type { AxiosRequestConfig } from 'axios';

import { USER_AGENT_ORIGIN } from './const.js';
import type { AuthToken } from './types.js';

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

/**
 * Adds Skyfire header to the request config if needed.
 * @param config
 * @param authToken
 * @private
 */
function addSkyfireHeader(config: AxiosRequestConfig, authToken?: AuthToken): AxiosRequestConfig {
    if (authToken?.type === 'skyfire') {
        const updatedConfig = { ...config };
        updatedConfig.headers = updatedConfig.headers ?? {};
        updatedConfig.headers['skyfire-pay-id'] = authToken.value;
        return updatedConfig;
    }
    return config;
}

export class ApifyClient extends _ApifyClient {
    constructor(options: ApifyClientOptions & { authToken?: AuthToken }) {
        // Destructure to separate authToken from other options
        const { authToken, ...clientOptions } = options;

        /**
         * In order to publish to DockerHub, we need to run their build task to validate our MCP server.
         * This was failing since we were sending this dummy token to Apify in order to build the Actor tools.
         * So if we encounter this dummy value, we remove it to use Apify client as unauthenticated, which is sufficient
         * for server start and listing of tools.
         */
        if (clientOptions.token?.toLowerCase() === 'your-apify-token') {
            delete clientOptions.token;
        }

        // Handle authToken if provided
        if (authToken) {
            if (authToken.type === 'skyfire') {
                // For Skyfire tokens: DO NOT set as bearer token
                // Only add the skyfire-pay-id header via request interceptor
                // Remove any existing token to ensure no bearer auth
                delete clientOptions.token;
            } else {
                // For Apify tokens: Use as regular bearer token (existing behavior)
                clientOptions.token = authToken.value;
            }
        }

        const requestInterceptors = [addUserAgent];
        if (authToken?.type === 'skyfire') {
            requestInterceptors.push((config) => addSkyfireHeader(config, authToken));
        }

        super({
            ...clientOptions, // Now safe to spread without authToken
            baseUrl: getApifyAPIBaseUrl(),
            requestInterceptors,
        });
    }
}
