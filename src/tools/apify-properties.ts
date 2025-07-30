import type { ISchemaProperties } from '../types.js';

const USER_DATA_DESCRIPTION = `User data object. A JSON object with custom user data that will be passed in the userData property of the Request object for each URL`;
const HEADERS_DESCRIPTION = `Headers object. A JSON object whose properties and values contain HTTP headers that will sent with the request.`;

/**
 * Adds resource picker schema structure to array properties with editor === 'resourcePicker'.
 * The resource picker allows users to select resources from their Apify account.
 */
export function addResourcePickerProperties(property: ISchemaProperties): ISchemaProperties {
    return {
        ...property,
        items: {
            ...property.items,
            type: 'string',
            title: 'Resource ID',
            description: 'Resource ID, either Apify Dataset, Key-Value Store, or Request List identifier',
        },
    };
}

/**
 * Adds key-value schema structure to array properties with editor === 'keyValue'.
 */
export function addKeyValueProperties(property: ISchemaProperties): ISchemaProperties {
    return {
        ...property,
        items: {
            ...property.items,
            type: 'object',
            title: 'Key-Value Pair',
            description: 'Key-value pair definition',
            properties: {
                key: {
                    type: 'string',
                    title: 'Key',
                    description: 'Key string',
                },
                value: {
                    type: 'string',
                    title: 'Value',
                    description: 'Value string',
                },
            },
        },
    };
}

/**
 * Adds globs schema structure to array properties with editor === 'globs'.
 */
export function addGlobsProperties(property: ISchemaProperties): ISchemaProperties {
    return {
        ...property,
        items: {
            ...property.items,
            type: 'object',
            title: 'Glob',
            description: 'Glob pattern definition',
            properties: {
                glob: {
                    type: 'string',
                    title: 'Glob',
                    description: `Glob pattern string. Globs are patterns that specify sets of URLs using wildcards, such as * (matches any character except / one or more times), ** (matches any character one or more times), ? (matches any character), or [abc] (matches selected characters).`,
                    examples: [
                        'http://www.example.com/pages/*',
                    ],
                },
                method: {
                    type: 'string',
                    title: 'HTTP Method',
                    description: 'HTTP method for the request',
                    enum: [
                        'GET',
                        'POST',
                        'PUT',
                        'DELETE',
                        'PATCH',
                        'HEAD',
                        'OPTIONS',
                        'CONNECT',
                        'TRACE',
                    ],
                    default: 'GET',
                },
                payload: {
                    type: 'string',
                    title: 'Payload',
                    description: 'Payload for the request',
                },
                userData: {
                    type: 'object',
                    title: 'User Data',
                    description: USER_DATA_DESCRIPTION,
                    properties: {},
                },
                headers: {
                    type: 'object',
                    title: 'Headers',
                    description: HEADERS_DESCRIPTION,
                    properties: {},
                },
            },
        },
    };
}

/**
 * Adds pseudoUrls schema structure to array properties with items.editor === 'pseudoUrls'.
 */
export function addPseudoUrlsProperties(property: ISchemaProperties): ISchemaProperties {
    return {
        ...property,
        items: {
            ...property.items,
            type: 'object',
            title: 'PseudoUrl',
            description: `PseudoUrl definition. Represents a pseudo-URL (PURL) - an URL pattern used by web crawlers to specify which URLs should the crawler visit.
            A PURL is simply a URL with special directives enclosed in [] brackets. Currently, the only supported directive is [RegExp], which defines a JavaScript-style regular expression to match against the URL.`,
            properties: {
                purl: {
                    type: 'string',
                    title: 'PseudoUrl',
                    description: `PseudoUrl pattern string. Be careful to correctly escape special characters in the pseudo-URL string. If either [ or ] is part of the normal query string, it must be encoded as [\\x5B] or [\\x5D], respectively`,
                    examples: [
                        'http://www.example.com/pages/[(\\w|-)*]',
                    ],
                },
                method: {
                    type: 'string',
                    title: 'HTTP Method',
                    description: 'HTTP method for the request',
                    enum: [
                        'GET',
                        'POST',
                        'PUT',
                        'DELETE',
                        'PATCH',
                        'HEAD',
                        'OPTIONS',
                        'CONNECT',
                        'TRACE',
                    ],
                    default: 'GET',
                },
                payload: {
                    type: 'string',
                    title: 'Payload',
                    description: 'Payload for the request',
                },
                userData: {
                    type: 'object',
                    title: 'User Data',
                    description: USER_DATA_DESCRIPTION,
                    properties: {},
                },
                headers: {
                    type: 'object',
                    title: 'Headers',
                    description: HEADERS_DESCRIPTION,
                    properties: {},
                },
            },
        },
    };
}

/**
 * Adds Apify proxy-specific properties to a proxy object property.
 */
export function addProxyProperties(property: ISchemaProperties): ISchemaProperties {
    return {
        ...property,
        properties: {
            ...property.properties,
            /**
             * We are not adding the Apify proxy country list field since that requires a MongoDB connection,
             * which is not possible for the local stdio server, and an API endpoint for that is not available.
             * So currently, there is no way for the user to select countries for the Apify proxy.
             */
            useApifyProxy: {
                title: 'Use Apify Proxy',
                type: 'boolean',
                description: 'Whether to use Apify Proxy. Set this to false when you want to use custom proxy URLs.',
                default: true,
            },
            apifyProxyGroups: {
                title: 'Apify Proxy Groups',
                type: 'array',
                description: `Select specific Apify Proxy groups to use (e.g., RESIDENTIAL, DATACENTER).
**DATACENTER:**
The fastest and cheapest option. It uses datacenters to change your IP address. Note that there is a chance of being blocked because of the activity of other users.

**RESIDENTIAL:**
IP addresses located in homes and offices around the world. These IPs are the least likely to be blocked.`,
                items: {
                    type: 'string',
                    title: 'Proxy group name',
                    description: 'Proxy group name',
                    enum: [
                        'RESIDENTIAL',
                        'DATACENTER',
                    ],
                },
            },
            proxyUrls: {
                title: 'Proxy URLs',
                type: 'array',
                description: 'List of custom proxy URLs to be used instead of the Apify Proxy.',
                items: {
                    type: 'string',
                    title: 'Custom proxy URL',
                    description: 'Custom proxy URL',
                },
            },
        },
        required: ['useApifyProxy'],
    };
}

/**
 * Adds request list source structure to array properties with editor 'requestListSources'.
 */
export function addRequestListSourcesProperties(property: ISchemaProperties): ISchemaProperties {
    return {
        ...property,
        items: {
            ...property.items,
            type: 'object',
            title: 'Request list source',
            description: 'Request list source',
            properties: {
                url: {
                    title: 'URL',
                    type: 'string',
                    description: 'URL of the request list source',
                },
                method: {
                    title: 'HTTP Method',
                    type: 'string',
                    description: 'HTTP method for the request list source',
                    enum: [
                        'GET',
                        'POST',
                        'PUT',
                        'DELETE',
                        'PATCH',
                        'HEAD',
                        'OPTIONS',
                        'CONNECT',
                        'TRACE',
                    ],
                    default: 'GET',
                },
                payload: {
                    title: 'Payload',
                    type: 'string',
                    description: 'Payload for the request list source',
                },
                userData: {
                    type: 'object',
                    title: 'User Data',
                    description: USER_DATA_DESCRIPTION,
                    properties: {},
                },
                headers: {
                    type: 'object',
                    title: 'Headers',
                    description: HEADERS_DESCRIPTION,
                    properties: {},
                },
            },
        },
    };
}
