import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import log from '@apify/log';

import { HelperTools } from '../const.js';
import { fetchApifyDocsCache } from '../state.js';
import type { InternalTool, ToolEntry } from '../types.js';
import { ajv } from '../utils/ajv.js';
import { htmlToMarkdown } from '../utils/html-to-md.js';

const fetchApifyDocsToolArgsSchema = z.object({
    url: z.string()
        .min(1)
        .describe(`URL of the Apify documentation page to fetch. This should be the full URL, including the protocol (e.g., https://docs.apify.com/).`),
});

export const fetchApifyDocsTool: ToolEntry = {
    type: 'internal',
    tool: {
        name: HelperTools.DOCS_FETCH,
        description: `Apify documentation fetch tool. This tool allows you to fetch the full content of an Apify documentation page by its URL.`,
        args: fetchApifyDocsToolArgsSchema,
        inputSchema: zodToJsonSchema(fetchApifyDocsToolArgsSchema),
        ajvValidate: ajv.compile(zodToJsonSchema(fetchApifyDocsToolArgsSchema)),
        call: async (toolArgs) => {
            const { args } = toolArgs;

            const parsed = fetchApifyDocsToolArgsSchema.parse(args);
            const url = parsed.url.trim();
            const urlWithoutFragment = url.split('#')[0];

            // Only allow URLs starting with https://docs.apify.com
            if (!url.startsWith('https://docs.apify.com')) {
                return {
                    content: [{
                        type: 'text',
                        text: `Only URLs starting with https://docs.apify.com are allowed.`,
                    }],
                };
            }

            // Cache URL without fragment to avoid fetching the same page multiple times
            let markdown = fetchApifyDocsCache.get(urlWithoutFragment);
            // If the content is not cached, fetch it from the URL
            if (!markdown) {
                try {
                    const response = await fetch(url);
                    if (!response.ok) {
                        return {
                            content: [{
                                type: 'text',
                                text: `Failed to fetch the documentation page at ${url}. Status: ${response.status} ${response.statusText}`,
                            }],
                        };
                    }
                    const html = await response.text();
                    markdown = htmlToMarkdown(html);
                    // Cache the processed Markdown content
                    // Use the URL without fragment as the key to avoid caching same page with different fragments
                    fetchApifyDocsCache.set(urlWithoutFragment, markdown);
                } catch (error) {
                    log.error('Failed to fetch the documentation page', { url, error });
                    return {
                        content: [{
                            type: 'text',
                            text: `Failed to fetch the documentation page at ${url}. Please check the URL and try again.`,
                        }],
                    };
                }
            }

            return {
                content: [{
                    type: 'text',
                    text: `Fetched content from ${url}:\n\n${markdown}`,
                }],
            };
        },
    } as InternalTool,
};
