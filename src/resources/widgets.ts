/**
 * Widget registry for MCP server UI widgets
 *
 * This module manages widget configuration and validates that widget files exist
 * at runtime.
 */

import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps';
import type { Resource } from '@modelcontextprotocol/sdk/types.js';

export { RESOURCE_MIME_TYPE };

const WIDGET_DOMAIN = 'https://apify.com';

const RESOURCE_DOMAINS = [
    'https://mcp.apify.com',
    'https://images.apifyusercontent.com',
    'https://apify-image-uploads-prod.s3.us-east-1.amazonaws.com',
    'https://apify-image-uploads-prod.s3.amazonaws.com',
    WIDGET_DOMAIN,
    'https://fonts.googleapis.com',
    'https://fonts.gstatic.com',
] as const;

const CONNECT_DOMAINS = [`https://api.apify.com`] as const;

// MCP Apps standard CSP (camelCase)
const WIDGET_CSP = {
    connectDomains: CONNECT_DOMAINS,
    resourceDomains: RESOURCE_DOMAINS,
} as const;

// ChatGPT-specific CSP compatibility key uses snake_case field names.
// See: https://developers.openai.com/apps-sdk/reference/#component-resource-_meta-fields
const OPENAI_WIDGET_CSP = {
    connect_domains: CONNECT_DOMAINS,
    resource_domains: RESOURCE_DOMAINS,
} as const;

const WIDGET_BASE_UI = {
    visibility: ['model', 'app'] as const,
    prefersBorder: true,
    domain: WIDGET_DOMAIN,
    csp: WIDGET_CSP,
} as const;

export const WIDGET_URIS = {
    SEARCH_ACTORS: 'ui://widget/search-actors.html',
    ACTOR_RUN: 'ui://widget/actor-run.html',
} as const;

type WidgetMeta = NonNullable<Resource['_meta']> & {
  // ChatGPT UX hints (does not affect MCP Jam renderer detection)
  'openai/toolInvocation/invoking'?: string;
  'openai/toolInvocation/invoked'?: string;
  // ChatGPT-specific compatibility keys (OpenAI aliases for standard _meta.ui.* fields)
  // See: https://developers.openai.com/apps-sdk/reference/#_meta-fields-on-tool-descriptor
  //      https://developers.openai.com/apps-sdk/reference/#component-resource-_meta-fields
  // 'openai/widgetAccessible'?: boolean;
  'openai/widgetCSP'?: typeof OPENAI_WIDGET_CSP;
  // 'openai/widgetPrefersBorder'?: boolean;
  // 'openai/widgetDomain'?: string;
  // MCP Apps standard metadata (SEP-1865)
  ui: {
    resourceUri: string;
    visibility: readonly string[];
    prefersBorder: boolean;
    domain: string;
    csp: typeof WIDGET_CSP;
  };
};

/**
 * Creates widget metadata for tool definitions.
 *
 * IMPORTANT: `openai/outputTemplate` is intentionally NOT included here.
 * MCP Jam's `detectUIType()` checks for both `openai/outputTemplate` and `ui.resourceUri`.
 * If both are present, it returns `OPENAI_SDK_AND_MCP_APPS` and defaults to the legacy
 * ChatGPT renderer, which doesn't speak JSON-RPC — breaking our MCP Apps widgets.
 * By only including `ui.resourceUri`, MCP Jam detects `MCP_APPS` and uses the correct renderer.
 *
 * The `openai/toolInvocation/*` keys are safe — they're UX hints only and don't affect
 * renderer detection.
 */
function createWidgetMeta(params: {
    resourceUri: string;
    invoking: string;
    invoked: string;
}): WidgetMeta {
    const { resourceUri, invoking, invoked } = params;

    return {
        'openai/toolInvocation/invoking': invoking,
        'openai/toolInvocation/invoked': invoked,
        // ChatGPT compatibility keys — required for public apps in ChatGPT.
        // These were removed during MCP Apps migration but ChatGPT still reads them.
        // 'openai/widgetAccessible': true,
        'openai/widgetCSP': OPENAI_WIDGET_CSP,
        // 'openai/widgetPrefersBorder': WIDGET_BASE_UI.prefersBorder,
        // 'openai/widgetDomain': WIDGET_BASE_UI.domain,
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
