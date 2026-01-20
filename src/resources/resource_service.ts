import type { ListResourcesResult, ListResourceTemplatesResult, ReadResourceResult, Resource, TextResourceContents } from '@modelcontextprotocol/sdk/types.js';

import log from '@apify/log';

import { SKYFIRE_README_CONTENT } from '../const.js';
import type { UiMode } from '../types.js';
import type { AvailableWidget } from './widgets.js';

type ExtendedResourceContents = TextResourceContents & {
    html?: string;
    _meta?: AvailableWidget['meta'];
};

type ExtendedReadResourceResult = Omit<ReadResourceResult, 'contents'> & {
    contents: ExtendedResourceContents[];
};

type ResourceService = {
    listResources: () => Promise<ListResourcesResult>;
    readResource: (uri: string) => Promise<ExtendedReadResourceResult>;
    listResourceTemplates: () => Promise<ListResourceTemplatesResult>;
};

type ResourceServiceOptions = {
    skyfireMode?: boolean;
    uiMode?: UiMode;
    getAvailableWidgets: () => Map<string, AvailableWidget>;
};

export function createResourceService(options: ResourceServiceOptions): ResourceService {
    const { skyfireMode, uiMode, getAvailableWidgets } = options;

    const listResources = async (): Promise<ListResourcesResult> => {
        const resources: Resource[] = [];

        if (skyfireMode) {
            resources.push({
                uri: 'file://readme.md',
                name: 'readme',
                description: 'Apify MCP Server usage guide. Read this to understand how to use the server, '
                    + 'especially in Skyfire mode before interacting with it.',
                mimeType: 'text/markdown',
            });
        }

        if (uiMode === 'openai') {
            for (const widget of getAvailableWidgets().values()) {
                if (!widget.exists) {
                    continue;
                }
                resources.push({
                    uri: widget.uri,
                    name: widget.name,
                    description: widget.description,
                    mimeType: 'text/html+skybridge',
                    _meta: widget.meta,
                });
            }
        }

        return { resources };
    };

    const readResource = async (uri: string): Promise<ExtendedReadResourceResult> => {
        if (skyfireMode && uri === 'file://readme.md') {
            return {
                contents: [{
                    uri: 'file://readme.md',
                    mimeType: 'text/markdown',
                    text: SKYFIRE_README_CONTENT,
                }],
            };
        }

        if (uiMode === 'openai' && uri.startsWith('ui://widget/')) {
            const widget = getAvailableWidgets().get(uri);

            if (!widget || !widget.exists) {
                return {
                    contents: [{
                        uri,
                        mimeType: 'text/plain',
                        text: `Widget ${uri} is not available. ${!widget ? 'Not found in registry.' : `File not found at ${widget.jsPath}`}`,
                    }],
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
                    mimeType: 'text/html+skybridge',
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
                    contents: [{
                        uri,
                        mimeType: 'text/plain',
                        text: `Failed to load widget: ${errorMessage}`,
                    }],
                };
            }
        }

        return {
            contents: [{
                uri,
                mimeType: 'text/plain',
                text: `Resource ${uri} not found`,
            }],
        };
    };

    const listResourceTemplates = async (): Promise<ListResourceTemplatesResult> => ({
        resourceTemplates: [],
    });

    return {
        listResources,
        readResource,
        listResourceTemplates,
    };
}
