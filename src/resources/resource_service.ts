import type {
    BlobResourceContents,
    ListResourcesResult,
    ListResourceTemplatesResult,
    ReadResourceResult,
    Resource,
    TextResourceContents,
} from '@modelcontextprotocol/sdk/types.js';

import log from '@apify/log';

import type { ApifyClient } from '../apify_client.js';
import type { PaymentProvider } from '../payments/types.js';
import { SERVER_MODE } from '../types.js';
import { isApifyApiUri, readApiResource } from './api_resources.js';
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
        if (isApifyApiUri(uri)) {
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
                const fs = await import('node:fs');
                const widgetJs = fs.readFileSync(widget.jsPath, 'utf-8');

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

        return {
            contents: [
                {
                    uri,
                    mimeType: 'text/plain',
                    text: `Resource ${uri} not found`,
                },
            ],
        };
    };

    // Read is a generic proxy over any Apify API GET URL, advertised in the server instructions;
    // there are no fixed templates to enumerate.
    const listResourceTemplates = async (): Promise<ListResourceTemplatesResult> => ({
        resourceTemplates: [],
    });

    return {
        listResources,
        readResource,
        listResourceTemplates,
    };
}
