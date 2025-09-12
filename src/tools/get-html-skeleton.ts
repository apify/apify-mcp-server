import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import { ApifyClient } from '../apify-client.js';
import { ACTOR_RAG_WEB_BROWSER, HelperTools, TOOL_MAX_OUTPUT_CHARS } from '../const.js';
import { getHtmlSkeletonCache } from '../state.js';
import type { InternalTool, ToolEntry } from '../types.js';
import { ajv } from '../utils/ajv.js';
import { isValidHttpUrl } from '../utils/generic.js';
import { stripHtml } from '../utils/html.js';
import { buildMCPResponse } from '../utils/mcp.js';

interface ScrapedPageItem {
    crawl: {
        httpStatusCode: number;
        httpStatusMessage: string;
    }
    metadata: {
        url: string;
    }
    query: string;
    html?: string;
}

const getHtmlSkeletonArgs = z.object({
    url: z.string()
        .min(1)
        .describe('URL of the webpage to retrieve HTML skeleton from.'),
    enableJavascript: z.boolean()
        .optional()
        .default(false)
        .describe('Whether to enable JavaScript rendering. Enabling this may increase the time taken to retrieve the HTML skeleton.'),
    page: z.number()
        .optional()
        .default(1)
        .describe('Page number to retrieve when paginating through content. Used to prevent exceeding the maximum tool output length.'),
});

export const getHtmlSkeleton: ToolEntry = {
    type: 'internal',
    tool: {
        name: HelperTools.GET_HTML_SKELETON,
        actorFullName: HelperTools.GET_HTML_SKELETON,
        description: `Retrieves the HTML skeleton (clean structure) from a given URL by stripping unwanted elements like scripts, styles, and non-essential attributes. This tool keeps only the core HTML structure, links, images, and data attributes for analysis. Supports optional JavaScript rendering for dynamic content and provides paginated output to handle large pages. This tool is useful for building web scrapers and data extraction tasks where a clean HTML structure is needed for writing concrete selectors or parsers.`,
        inputSchema: zodToJsonSchema(getHtmlSkeletonArgs),
        ajvValidate: ajv.compile(zodToJsonSchema(getHtmlSkeletonArgs)),
        call: async (toolArgs) => {
            const { args, apifyToken } = toolArgs;
            const parsed = getHtmlSkeletonArgs.parse(args);

            if (!isValidHttpUrl(parsed.url)) {
                return buildMCPResponse([`The provided URL is not a valid HTTP or HTTPS URL: ${parsed.url}`]);
            }

            // Try to get from cache first
            let strippedHtml = getHtmlSkeletonCache.get(parsed.url);
            if (!strippedHtml) {
                // Not in cache, call the Actor for scraping
                const client = new ApifyClient({ token: apifyToken });

                const run = await client.actor(ACTOR_RAG_WEB_BROWSER).call({
                    query: parsed.url,
                    outputFormats: [
                        'html',
                    ],
                    scrapingTool: parsed.enableJavascript ? 'browser-playwright' : 'raw-http',
                });

                const datasetItems = await client.dataset(run.defaultDatasetId).listItems();
                if (datasetItems.items.length === 0) {
                    return buildMCPResponse([`The scraping Actor (${ACTOR_RAG_WEB_BROWSER}) did not return any output for the URL: ${parsed.url}. Please check the Actor run for more details: ${run.id}`]);
                }

                const firstItem = datasetItems.items[0] as unknown as ScrapedPageItem;
                if (firstItem.crawl.httpStatusMessage.toLocaleLowerCase() !== 'ok') {
                    return buildMCPResponse([`The scraping Actor (${ACTOR_RAG_WEB_BROWSER}) returned an HTTP status ${firstItem.crawl.httpStatusCode} (${firstItem.crawl.httpStatusMessage}) for the URL: ${parsed.url}. Please check the Actor run for more details: ${run.id}`]);
                }

                if (!firstItem.html) {
                    return buildMCPResponse([`The scraping Actor (${ACTOR_RAG_WEB_BROWSER}) did not return any HTML content for the URL: ${parsed.url}. Please check the Actor run for more details: ${run.id}`]);
                }

                strippedHtml = stripHtml(firstItem.html);
                getHtmlSkeletonCache.set(parsed.url, strippedHtml);
            }

            // Pagination logic
            const totalLength = strippedHtml.length;
            const pageSize = TOOL_MAX_OUTPUT_CHARS;
            const totalPages = Math.ceil(totalLength / pageSize);
            const startIndex = (parsed.page - 1) * pageSize;
            const endIndex = Math.min(startIndex + pageSize, totalLength);
            const pageContent = strippedHtml.slice(startIndex, endIndex);
            const hasNextPage = parsed.page < totalPages;

            const paginationInfo = `\n\n--- Page ${parsed.page} of ${totalPages} ---\n${hasNextPage ? `Next page: ${parsed.page + 1}` : 'End of content'}`;

            return buildMCPResponse([pageContent + paginationInfo]);
        },
    } as InternalTool,
};
