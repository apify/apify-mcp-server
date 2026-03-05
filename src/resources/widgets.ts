/**
 * Widget registry for MCP server UI widgets
 *
 * This module manages widget configuration and validates that widget files exist
 * at runtime.
 */

import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps';
import type { Resource } from '@modelcontextprotocol/sdk/types.js';

export { RESOURCE_MIME_TYPE };

const WIDGET_CSP = {
    connectDomains: [`https://api.apify.com`],
    resourceDomains: [
        'https://mcp.apify.com',
        'https://images.apifyusercontent.com',
        'https://apify-image-uploads-prod.s3.us-east-1.amazonaws.com',
        'https://apify-image-uploads-prod.s3.amazonaws.com',
        'https://apify.com',
        'https://fonts.googleapis.com',
        'https://fonts.gstatic.com',
    ],
} as const;

const WIDGET_BASE_UI = {
    visibility: ['model', 'app'] as const,
    prefersBorder: true,
    domain: 'https://apify.com',
    csp: WIDGET_CSP,
} as const;

export const WIDGET_URIS = {
    SEARCH_ACTORS: 'ui://widget/search-actors.html',
    ACTOR_RUN: 'ui://widget/actor-run.html',
} as const;

type WidgetMeta = NonNullable<Resource['_meta']> & {
  // ChatGPT extensions (optional UX enhancements)
  'openai/toolInvocation/invoking'?: string;
  'openai/toolInvocation/invoked'?: string;
  // MCP Apps standard metadata (SEP-1865)
  ui: {
    resourceUri: string;
    visibility: readonly string[];
    prefersBorder: boolean;
    domain: string;
    csp: typeof WIDGET_CSP;
  };
};

function createWidgetMeta(params: {
    resourceUri: string;
    invoking: string;
    invoked: string;
}): WidgetMeta {
    const { resourceUri, invoking, invoked } = params;

    return {
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
