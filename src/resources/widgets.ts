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

// MCP Apps CSP (camelCase only).
const WIDGET_UI_CSP = {
    connectDomains: WIDGET_CSP_DOMAINS.connect,
    resourceDomains: WIDGET_CSP_DOMAINS.resource,
} as const;

const WIDGET_BASE_UI = {
    visibility: ['model', 'app'] as const,
    prefersBorder: true,
    domain: 'https://apify.com',
    csp: WIDGET_UI_CSP,
} as const;

/**
 * Compatibility shim for legacy OpenAI widget metadata.
 * Keep this isolated so MCP Apps metadata (`ui`) remains the source of truth.
 */
const OPENAI_WIDGET_BASE_META = {
    // Legacy OpenAI keys (still required by ChatGPT)
    'openai/widgetAccessible': true,
    'openai/resultCanProduceWidget': true,
    'openai/widgetPrefersBorder': true,
    'openai/widgetDomain': 'https://apify.com',
    'openai/widgetCSP': WIDGET_UI_CSP,
} as const;

export const WIDGET_URIS = {
    SEARCH_ACTORS: 'ui://widget/search-actors.html',
    ACTOR_RUN: 'ui://widget/actor-run.html',
} as const;

type UiWidgetCsp = {
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
  'openai/widgetCSP': UiWidgetCsp;
  // MCP Apps standard metadata
  ui: {
    resourceUri: string;
    visibility: readonly string[];
    prefersBorder: boolean;
    domain: string;
    csp: UiWidgetCsp;
  };
};

function createWidgetMeta(params: {
    resourceUri: string;
    invoking: string;
    invoked: string;
}): WidgetMeta {
    const { resourceUri, invoking, invoked } = params;

    return {
        ...OPENAI_WIDGET_BASE_META,
        'openai/outputTemplate': resourceUri,
        'openai/toolInvocation/invoking': invoking,
        'openai/toolInvocation/invoked': invoked,
        ui: { ...WIDGET_BASE_UI, resourceUri },
    };
}

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
        meta: createWidgetMeta({
            resourceUri: WIDGET_URIS.SEARCH_ACTORS,
            invoking: 'Searching Apify Store...',
            invoked: 'Found Actors matching your criteria',
        }),
    },
    [WIDGET_URIS.ACTOR_RUN]: {
        uri: WIDGET_URIS.ACTOR_RUN,
        name: 'actor-run-widget',
        description: 'Interactive Actor run widget',
        jsFilename: 'actor-run-widget.js',
        title: 'Apify Actor Run',
        meta: createWidgetMeta({
            resourceUri: WIDGET_URIS.ACTOR_RUN,
            invoking: 'Running Apify Actor...',
            invoked: 'Actor run started',
        }),
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
