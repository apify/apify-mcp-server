/**
 * Widget registry for MCP server UI widgets
 *
 * This module manages widget configuration and validates that widget files exist
 * at runtime. Includes cache-busting via content hashing to ensure clients always
 * fetch the latest widget version after deployments.
 */

import { createHash } from 'node:crypto';

import type { Resource } from '@modelcontextprotocol/sdk/types.js';

const OPENAI_WIDGET_CSP = {
    connect_domains: ['https://api.apify.com'],
    resource_domains: [
        'https://mcp.apify.com',
        'https://images.apifyusercontent.com',
        'https://apify-image-uploads-prod.s3.us-east-1.amazonaws.com',
        'https://apify-image-uploads-prod.s3.amazonaws.com',
        'https://apify.com',
    ],
} as const;

const OPENAI_WIDGET_BASE_META = {
    'openai/widgetAccessible': true,
    'openai/resultCanProduceWidget': true,
    'openai/widgetPrefersBorder': true,
    'openai/widgetDomain': 'https://apify.com',
    'openai/widgetCSP': OPENAI_WIDGET_CSP,
} as const;

export const WIDGET_URIS = {
    SEARCH_ACTORS: 'ui://widget/search-actors.html',
    ACTOR_RUN: 'ui://widget/actor-run.html',
} as const;

type WidgetMeta = NonNullable<Resource['_meta']> & {
  'openai/outputTemplate': string;
  'openai/toolInvocation/invoking'?: string;
  'openai/toolInvocation/invoked'?: string;
  'openai/widgetAccessible': boolean;
  'openai/resultCanProduceWidget': boolean;
  'openai/widgetDomain': string;
  'openai/widgetCSP': {
    readonly connect_domains: readonly string[];
    readonly resource_domains: readonly string[];
  };
};

export type WidgetConfig = {
  uri: Resource['uri'];
  name: Resource['name'];
  description: NonNullable<Resource['description']>;
  jsFilename: string;
  title: NonNullable<Resource['title']>;
  meta: WidgetMeta;
};

/**
 * Widget registry configuration
 * Maps widget URIs to their configuration
 */
export const WIDGET_REGISTRY: Record<string, WidgetConfig> = {
    [WIDGET_URIS.SEARCH_ACTORS]: {
        uri: WIDGET_URIS.SEARCH_ACTORS,
        name: 'search-actors-widget',
        description: 'Interactive Actor search results widget',
        jsFilename: 'search-actors-widget.js',
        title: 'Apify Actor Search',
        meta: {
            ...OPENAI_WIDGET_BASE_META,
            'openai/outputTemplate': WIDGET_URIS.SEARCH_ACTORS,
            'openai/toolInvocation/invoking': 'Searching Apify Store...',
            'openai/toolInvocation/invoked': 'Found Actors matching your criteria',
        },
    },
    [WIDGET_URIS.ACTOR_RUN]: {
        uri: WIDGET_URIS.ACTOR_RUN,
        name: 'actor-run-widget',
        description: 'Interactive Actor run widget',
        jsFilename: 'actor-run-widget.js',
        title: 'Apify Actor Run',
        meta: {
            ...OPENAI_WIDGET_BASE_META,
            'openai/outputTemplate': WIDGET_URIS.ACTOR_RUN,
            'openai/toolInvocation/invoking': 'Running Apify Actor...',
            'openai/toolInvocation/invoked': 'Actor run started',
        },
    },
};

export type AvailableWidget = WidgetConfig & {
  jsPath: string;
  exists: boolean;
  /** SHA-256 content hash (16 hex chars) of the widget JS file, used for cache-busting */
  versionHash?: string;
  /** Widget URI with version query parameter appended for cache-busting (e.g., ui://widget/search-actors.html?v=abc123) */
  versionedUri?: string;
};

/** Number of hex characters to use from the SHA-256 hash for cache-busting */
const VERSION_HASH_LENGTH = 16;

/**
 * Computes a truncated SHA-256 hash of the given content for cache-busting.
 */
export function computeContentHash(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, VERSION_HASH_LENGTH);
}

/**
 * Appends a version query parameter to a widget URI for cache-busting.
 */
export function appendWidgetVersion(uri: string, hash: string): string {
    return `${uri}?v=${hash}`;
}

/**
 * Strips the version query parameter from a widget URI, returning the base URI.
 * This is used in readResource to normalize incoming URIs before map lookup.
 */
export function stripWidgetVersion(uri: string): string {
    const queryIndex = uri.indexOf('?');
    if (queryIndex === -1) return uri;
    return uri.slice(0, queryIndex);
}

/**
 * Resolves available widgets by checking if their files exist on the filesystem.
 * For existing widgets, computes a content hash of the JS file for cache-busting.
 *
 * @param baseDir - Base directory where the server code is located
 * @returns Map of widget URIs to their resolved state (keyed by base URI without version)
 */
export async function resolveAvailableWidgets(baseDir: string): Promise<Map<string, AvailableWidget>> {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const resolvedWidgets = new Map<string, AvailableWidget>();
    const webDistPath = path.resolve(baseDir, '../web/dist');

    for (const [uri, config] of Object.entries(WIDGET_REGISTRY)) {
        const jsPath = path.resolve(webDistPath, config.jsFilename);
        const exists = fs.existsSync(jsPath);

        let versionHash: string | undefined;
        let versionedUri: string | undefined;

        if (exists) {
            const jsContent = fs.readFileSync(jsPath, 'utf-8');
            versionHash = computeContentHash(jsContent);
            versionedUri = appendWidgetVersion(uri, versionHash);
        }

        resolvedWidgets.set(uri, {
            ...config,
            jsPath,
            exists,
            versionHash,
            versionedUri,
        });
    }

    return resolvedWidgets;
}

/**
 * Get widget configuration by URI
 *
 * @param uri - Widget URI
 * @returns Widget configuration or undefined if not found
 */
export function getWidgetConfig(uri: string): WidgetConfig | undefined {
    return WIDGET_REGISTRY[uri];
}

/**
 * Returns widget meta with a versioned `openai/outputTemplate` URI for cache-busting.
 * Falls back to the base (unversioned) meta if the widget hasn't been resolved yet.
 *
 * @param baseUri - Base widget URI (e.g., WIDGET_URIS.SEARCH_ACTORS)
 * @param availableWidgets - Map of resolved widgets (from resolveAvailableWidgets)
 * @returns Widget meta with versioned outputTemplate, or undefined if widget not found
 */
export function getVersionedWidgetMeta(
    baseUri: string,
    availableWidgets: Map<string, AvailableWidget>,
): WidgetConfig['meta'] | undefined {
    const config = WIDGET_REGISTRY[baseUri];
    if (!config) return undefined;

    const resolved = availableWidgets.get(baseUri);
    if (!resolved?.versionedUri) return config.meta;

    return {
        ...config.meta,
        'openai/outputTemplate': resolved.versionedUri,
    };
}
