/**
 * Widget registry for MCP server UI widgets
 *
 * This module manages widget configuration and validates that widget files exist
 * at runtime.
 */

import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps';
import type { Resource } from '@modelcontextprotocol/sdk/types.js';

export { RESOURCE_MIME_TYPE };

const WIDGET_CSP_DOMAINS = {
    connect: ['https://api.apify.com'],
    resource: [
        'https://mcp.apify.com',
        'https://images.apifyusercontent.com',
        'https://apify-image-uploads-prod.s3.us-east-1.amazonaws.com',
        'https://apify-image-uploads-prod.s3.amazonaws.com',
        'https://apify.com',
        'https://fonts.googleapis.com',
        'https://fonts.gstatic.com',
    ],
} as const;

// CSP object with both snake_case (legacy, required by MCP Jam) and camelCase (MCP Apps spec) field names.
// TODO: Remove snake_case fields once all hosts support camelCase.
const WIDGET_CSP = {
    connect_domains: WIDGET_CSP_DOMAINS.connect,
    resource_domains: WIDGET_CSP_DOMAINS.resource,
    connectDomains: WIDGET_CSP_DOMAINS.connect,
    resourceDomains: WIDGET_CSP_DOMAINS.resource,
} as const;

const WIDGET_BASE_UI = {
    visibility: ['model', 'app'] as const,
    prefersBorder: true,
    domain: 'https://apify.com',
    csp: WIDGET_CSP,
} as const;

const OPENAI_WIDGET_BASE_META = {
    // Legacy OpenAI keys (still required by ChatGPT)
    'openai/widgetAccessible': true,
    'openai/resultCanProduceWidget': true,
    'openai/widgetPrefersBorder': true,
    'openai/widgetDomain': 'https://apify.com',
    'openai/widgetCSP': WIDGET_CSP,
    // MCP Apps standard metadata
    ui: WIDGET_BASE_UI,
} as const;

export const WIDGET_URIS = {
    SEARCH_ACTORS: 'ui://widget/search-actors.html',
    ACTOR_RUN: 'ui://widget/actor-run.html',
} as const;

// Both snake_case (legacy) and camelCase (MCP Apps spec) fields.
// TODO: Remove snake_case fields once all hosts support camelCase.
type WidgetCsp = {
  readonly connect_domains: readonly string[];
  readonly resource_domains: readonly string[];
  readonly connectDomains: readonly string[];
  readonly resourceDomains: readonly string[];
};

type WidgetMeta = NonNullable<Resource['_meta']> & {
  // Legacy OpenAI keys (still required by ChatGPT)
  'openai/outputTemplate': string;
  'openai/toolInvocation/invoking'?: string;
  'openai/toolInvocation/invoked'?: string;
  'openai/widgetAccessible': boolean;
  'openai/resultCanProduceWidget': boolean;
  'openai/widgetDomain': string;
  'openai/widgetCSP': WidgetCsp;
  // MCP Apps standard metadata
  ui: {
    resourceUri: string;
    visibility: readonly string[];
    prefersBorder: boolean;
    domain: string;
    csp: WidgetCsp;
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
            ui: { ...WIDGET_BASE_UI, resourceUri: WIDGET_URIS.SEARCH_ACTORS },
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
            ui: { ...WIDGET_BASE_UI, resourceUri: WIDGET_URIS.ACTOR_RUN },
        },
    },
};

export type AvailableWidget = WidgetConfig & {
  jsPath: string;
  exists: boolean;
};

/**
 * Resolves available widgets by checking if their files exist on the filesystem.
 *
 * @param baseDir - Base directory where the server code is located
 * @returns Map of widget URIs to their resolved state
 */
export async function resolveAvailableWidgets(baseDir: string): Promise<Map<string, AvailableWidget>> {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const resolvedWidgets = new Map<string, AvailableWidget>();
    const webDistPath = path.resolve(baseDir, '../web/dist');

    for (const [uri, config] of Object.entries(WIDGET_REGISTRY)) {
        const jsPath = path.resolve(webDistPath, config.jsFilename);
        const exists = fs.existsSync(jsPath);

        resolvedWidgets.set(uri, {
            ...config,
            jsPath,
            exists,
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
