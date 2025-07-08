import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import { HelperTools } from '../const.js';
import type { InternalTool, ToolEntry } from '../types.js';
import { ajv } from '../utils/ajv.js';
import { turndown } from '../utils/turndown.js';

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

            // Only allow URLs starting with https://docs.apify.com
            if (!url.startsWith('https://docs.apify.com')) {
                return {
                    content: [{
                        type: 'text',
                        text: `Only URLs starting with https://docs.apify.com are allowed.`,
                    }],
                };
            }

            let html;
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
                html = await response.text();
            } catch {
                return {
                    content: [{
                        type: 'text',
                        text: `Failed to fetch the documentation page at ${url}. Please check the URL and try again.`,
                    }],
                };
            }
            const markdown = turndown.turndown(html);

            return {
                content: [{
                    type: 'text',
                    text: `Fetched content from ${url}:\n\n${markdown}`,
                }],
            };
        },
    } as InternalTool,
};
