import { readFileSync } from 'node:fs';

import type {
    BlobResourceContents,
    ListResourcesResult,
    ListResourceTemplatesResult,
    ReadResourceResult,
    Resource,
    TextResourceContents,
} from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import log from '@apify/log';

import type { ApifyClient } from '../apify_client.js';
import { getApifyAPIBaseUrl } from '../apify_client.js';
import type { PaymentProvider } from '../payments/types.js';
import { SERVER_MODE } from '../types.js';
import { readApiResource } from './api_resources.js';
import type { AvailableWidget } from './widgets.js';
import { RESOURCE_MIME_TYPE } from './widgets.js';

// API reads can yield binary blob contents, not just text; the widget fields are optional add-ons.
type ExtendedResourceContents = (TextResourceContents | BlobResourceContents) & {
    html?: string;
    _meta?: AvailableWidget['meta'];
};

type ExtendedReadResourceResult = Omit<ReadResourceResult, 'contents'> & {
    contents: ExtendedResourceContents[];
};

type ResourceService = {
    listResources: () => Promise<ListResourcesResult>;
    readResource: (uri: string, apifyClient?: ApifyClient) => Promise<ExtendedReadResourceResult>;
    listResourceTemplates: () => Promise<ListResourceTemplatesResult>;
};

type ResourceServiceOptions = {
    paymentProvider?: PaymentProvider;
    /**
     * Read the current server mode at call time. Callers must pass a getter rather
     * than a value: `serverMode` can flip from the preliminary DEFAULT to APPS when
     * the server's initialize request handler resolves the `'auto'` option against
     * client capabilities, and a captured value would freeze resource listings to
     * the preliminary mode.
     */
    getMode: () => SERVER_MODE;
    getAvailableWidgets: () => Map<string, AvailableWidget>;
};

export function createResourceService(options: ResourceServiceOptions): ResourceService {
    const { paymentProvider, getMode, getAvailableWidgets } = options;

    const listResources = async (): Promise<ListResourcesResult> => {
        const resources: Resource[] = [];

        if (paymentProvider?.getUsageGuide?.()) {
            resources.push({
                uri: 'file://readme.md',
                name: 'readme',
                description:
                    'Apify MCP Server usage guide. Read this to understand how to use the server ' +
                    'before interacting with it.',
                mimeType: 'text/markdown',
            });
        }

        if (getMode() === SERVER_MODE.APPS) {
            for (const widget of getAvailableWidgets().values()) {
                if (!widget.exists) {
                    continue;
                }
                resources.push({
                    uri: widget.uri,
                    name: widget.name,
                    description: widget.description,
                    mimeType: RESOURCE_MIME_TYPE,
                    _meta: widget.meta,
                });
            }
        }

        return { resources };
    };

    const readResource = async (uri: string, apifyClient?: ApifyClient): Promise<ExtendedReadResourceResult> => {
        // Route every http(s) URI to the API proxy — it owns the single origin gate, so a
        // non-Apify URL gets the explanatory origin refusal instead of the generic fallback.
        if (/^https?:\/\//i.test(uri)) {
            // API contents carry no widget `_meta`/`html`; the extended shape only adds optional fields.
            return (await readApiResource(uri, apifyClient)) as ExtendedReadResourceResult;
        }

        const usageGuide = paymentProvider?.getUsageGuide?.();
        if (usageGuide && uri === 'file://readme.md') {
            return {
                contents: [
                    {
                        uri: 'file://readme.md',
                        mimeType: 'text/markdown',
                        text: usageGuide,
                    },
                ],
            };
        }

        if (getMode() === SERVER_MODE.APPS && uri.startsWith('ui://widget/')) {
            const widget = getAvailableWidgets().get(uri);

            if (!widget || !widget.exists) {
                return {
                    contents: [
                        {
                            uri,
                            mimeType: 'text/plain',
                            text: `Widget ${uri} is not available. ${!widget ? 'Not found in registry.' : `File not found at ${widget.jsPath}`}`,
                        },
                    ],
                };
            }

            try {
                log.debug('Reading widget file', { uri, jsPath: widget.jsPath });
                const widgetJs = readFileSync(widget.jsPath, 'utf-8');

                const widgetHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${widget.title}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module">${widgetJs}</script>
  </body>
</html>`;

                const widgetContent: ExtendedResourceContents = {
                    uri,
                    mimeType: RESOURCE_MIME_TYPE,
                    text: widgetHtml,
                    html: widgetHtml,
                    _meta: widget.meta,
                };
                return {
                    contents: [widgetContent],
                };
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                return {
                    contents: [
                        {
                            uri,
                            mimeType: 'text/plain',
                            text: `Failed to load widget: ${errorMessage}`,
                        },
                    ],
                };
            }
        }

        // A URI that is neither an http(s) URL, the usage guide, nor a served widget is not a
        // readable resource — throw so the SDK returns a JSON-RPC error instead of success-shaped
        // "not found" content (see SEP-2164 and src/resources/AGENTS.md).
        throw new McpError(ErrorCode.InvalidParams, `Failed to read ${uri}: not a readable resource.`, { uri });
    };

    // Advertise the common URL shapes so clients that never surface the server instructions can
    // still discover the read proxy and its paging parameters (RFC 6570 `{?var}` = query params).
    // Advertisement only, NOT a route table: the read path stays a generic proxy, and any other
    // Apify API GET URL is readable the same way.
    const listResourceTemplates = async (): Promise<ListResourceTemplatesResult> => {
        const api = getApifyAPIBaseUrl();
        return {
            resourceTemplates: [
                {
                    uriTemplate: `${api}/v2/datasets/{datasetId}/items{?limit,offset,clean,fields,format}`,
                    name: 'dataset-items',
                    // No mimeType: `format` selects among 7 response types (json/jsonl/xml/html/csv/xlsx/rss),
                    // and the spec allows a template mimeType only when all matching resources share one.
                    description:
                        'Items of a dataset, read via resources/read (the server injects the Apify token). ' +
                        'Page with limit/offset; format defaults to JSON — responses inline up to 256 KB, ' +
                        'larger ones return a download URL.',
                },
                {
                    uriTemplate: `${api}/v2/key-value-stores/{storeId}/records/{recordKey}`,
                    name: 'key-value-store-record',
                    description:
                        'A single record, returned whole in its stored Content-Type via resources/read. ' +
                        'Not pageable — a record over 256 KB returns a download URL instead.',
                },
                {
                    uriTemplate: `${api}/v2/key-value-stores/{storeId}/keys{?limit,exclusiveStartKey}`,
                    name: 'key-value-store-keys',
                    description: 'Keys of a key-value store. Page with limit/exclusiveStartKey (not offset).',
                    mimeType: 'application/json',
                },
                {
                    uriTemplate: `${api}/v2/actor-runs/{runId}`,
                    name: 'actor-run',
                    description: 'Metadata of an Actor run: status, storage IDs, usage.',
                    mimeType: 'application/json',
                },
                {
                    uriTemplate: `${api}/v2/logs/{runId}`,
                    name: 'actor-run-log',
                    description: 'Log of an Actor run. Inlines up to 256 KB, larger returns a download URL.',
                    mimeType: 'text/plain',
                },
            ],
        };
    };

    return {
        listResources,
        readResource,
        listResourceTemplates,
    };
}
