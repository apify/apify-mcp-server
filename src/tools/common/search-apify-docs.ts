import { z } from 'zod';

import { DOCS_SOURCES, HelperTools } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { searchDocsBySourceCached } from '../../utils/apify-docs.js';
import { buildMCPResponse } from '../../utils/mcp.js';
import { searchApifyDocsToolOutputSchema } from '../structured-output-schemas.js';

/**
 * Build docSource parameter description dynamically from DOCS_SOURCES
 */
function buildDocSourceDescription(): string {
    const options = DOCS_SOURCES.map(
        (idx) => `• "${idx.id}" - ${idx.label}`,
    ).join('\n');
    return `Documentation source to search. Defaults to "apify".\n${options}`;
}

/**
 * Build tool description dynamically from DOCS_SOURCES
 */
function buildToolDescription(): string {
    const sources = DOCS_SOURCES.map(
        (idx) => `• docSource="${idx.id}" - ${idx.label}:\n  ${idx.description}`,
    ).join('\n\n');

    return `Search Apify and Crawlee documentation using full-text search.

You must explicitly select which documentation source to search using the docSource parameter:

${sources}

The results will include the URL of the documentation page (which may include an anchor),
and a limited piece of content that matches the search query.

Fetch the full content of the document using the ${HelperTools.DOCS_FETCH} tool by providing the URL.`;
}

const searchApifyDocsToolArgsSchema = z.object({
    docSource: z.enum(
        DOCS_SOURCES.map((source) => source.id) as [string, ...string[]],
    )
        .optional()
        .default('apify')
        .describe(buildDocSourceDescription()),
    query: z.string()
        .min(1)
        .describe(
            `Algolia full-text search query to find relevant documentation pages.
Use only keywords, do not use full sentences or questions.
For example, "standby actor" will return documentation pages that contain the words "standby" and "actor".`,
        ),
    limit: z.number()
        .min(1)
        .max(20) // Algolia does not return more than 20 results anyway
        .optional()
        .default(5)
        .describe(`Maximum number of search results to return. Defaults to 5. Maximum is 20.
You can increase this limit if you need more results, but keep in mind that the search results are limited to the most relevant pages.`),
    offset: z.number()
        .optional()
        .default(0)
        .describe(`Offset for the search results. Defaults to 0.
Use this to paginate through the search results. For example, if you want to get the next 5 results, set the offset to 5 and limit to 5.`),
});

export const searchApifyDocsTool: ToolEntry = Object.freeze({
    type: 'internal',
    name: HelperTools.DOCS_SEARCH,
    description: buildToolDescription(),
    inputSchema: z.toJSONSchema(searchApifyDocsToolArgsSchema) as ToolInputSchema,
    outputSchema: searchApifyDocsToolOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(searchApifyDocsToolArgsSchema)),
    annotations: {
        title: 'Search Apify docs',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args } = toolArgs;

        const parsed = searchApifyDocsToolArgsSchema.parse(args);

        const query = parsed.query.trim();
        const resultsRaw = await searchDocsBySourceCached(parsed.docSource, query);

        const results = resultsRaw.slice(parsed.offset, parsed.offset + parsed.limit);

        if (results.length === 0) {
            const instructions = `No results found for the query "${query}" in the "${parsed.docSource}" documentation source.
Please try a different query with different keywords, or adjust the limit and offset parameters.
You can also try using more specific or alternative keywords related to your search topic.`;
            const structuredContent = {
                results: [],
                query,
                count: 0,
                instructions,
            };
            return buildMCPResponse({ texts: [instructions], structuredContent });
        }

        // Instructions for LLM to use the docs fetch tool when retrieving full document content
        const instructions = 'You can use the Apify docs fetch tool to retrieve the full content of a document by its URL.';
        // Actual unstructured text result
        const textResult = `Search results for "${query}" in ${parsed.docSource}:

${results.map((result) => {
            let line = `- Document URL: ${result.url}`;
            if (result.content) {
                line += `\n  Content: ${result.content}`;
            }
            return line;
        }).join('\n\n')}`;

        const structuredContent = {
            results: results.map((result) => ({
                url: result.url,
                ...(result.content ? { content: result.content } : {}),
            })),
            query,
            count: results.length,
            instructions,
        };
        // We put the instructions at the end so that they are more likely to be acknowledged by the LLM
        return buildMCPResponse({ texts: [textResult, instructions], structuredContent });
    },
} as const);
