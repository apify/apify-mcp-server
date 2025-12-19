import { z } from 'zod';

import { HelperTools } from '../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../types.js';
import { compileSchema } from '../utils/ajv.js';
import { searchApifyDocsCached } from '../utils/apify-docs.js';
import { buildMCPResponse } from '../utils/mcp.js';
import { searchApifyDocsToolOutputSchema } from './structured-output-schemas.js';

const searchApifyDocsToolArgsSchema = z.object({
    query: z.string()
        .min(1)
        .describe(
            `Algolia full-text search query to find relevant documentation pages.
Use only keywords, do not use full sentences or questions.
For example, "standby actor" will return documentation pages that contain the words "standby" and "actor".`,
        ),
    limit: z.number()
        .optional()
        .default(5)
        .describe(`Maximum number of search results to return. Defaults to 5.
You can increase this limit if you need more results, but keep in mind that the search results are limited to the most relevant pages.`),
    offset: z.number()
        .optional()
        .default(0)
        .describe(`Offset for the search results. Defaults to 0.
Use this to paginate through the search results. For example, if you want to get the next 5 results, set the offset to 5 and limit to 5.`),
});

export const searchApifyDocsTool: ToolEntry = {
    type: 'internal',
    name: HelperTools.DOCS_SEARCH,
    description: `Search Apify documentation using full-text search.
You can use it to find relevant documentation based on keywords.
Apify documentation has information about Apify console, Actors (development
(actor.json, input schema, dataset schema, dockerfile), deployment, builds, runs),
schedules, storages (datasets, key-value store), Proxy, Integrations,
Apify Academy (crawling and webscraping with Crawlee),

The results will include the URL of the documentation page, a fragment identifier (if available),
and a limited piece of content that matches the search query.

Fetch the full content of the document using the ${HelperTools.DOCS_FETCH} tool by providing the URL.

USAGE:
- Use when user asks about Apify documentation, Actor development, Crawlee, or Apify platform.

USAGE EXAMPLES:
- query: How to use create Apify Actor?
- query: How to define Actor input schema?
- query: How scrape with Crawlee?`,
    inputSchema: z.toJSONSchema(searchApifyDocsToolArgsSchema) as ToolInputSchema,
    outputSchema: searchApifyDocsToolOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(searchApifyDocsToolArgsSchema)),
    annotations: {
        title: 'Search Apify docs',
        readOnlyHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args } = toolArgs;

        const parsed = searchApifyDocsToolArgsSchema.parse(args);
        const query = parsed.query.trim();

        const resultsRaw = await searchApifyDocsCached(query);
        const results = resultsRaw.slice(parsed.offset, parsed.offset + parsed.limit);

        if (results.length === 0) {
            const instructions = `No results found for the query "${query}" with limit ${parsed.limit} and offset ${parsed.offset}.
Try a different query with different keywords, or adjust the limit and offset parameters.
You can also try using more specific or alternative keywords related to your search topic.`;
            const structuredContent = {
                results: [],
                query,
                count: 0,
                instructions,
            };
            return buildMCPResponse({ texts: [instructions], structuredContent });
        }

        const instructions = `You can use the Apify docs fetch tool to retrieve the full content of a document by its URL. The document fragment refers to the section of the content containing the relevant part for the search result item.
Search results for "${query}":

${results.map((result) => `- Document URL: ${result.url}${result.fragment ? `\n  Document fragment: ${result.fragment}` : ''}
   Content: ${result.content}`).join('\n\n')}`;

        const structuredContent = {
            results: results.map((result) => ({
                url: result.url,
                fragment: result.fragment,
                content: result.content,
            })),
            query,
            count: results.length,
            instructions,
        };
        return buildMCPResponse({ texts: [instructions], structuredContent });
    },
} as const;
