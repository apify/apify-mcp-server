import dedent from 'dedent';
import { z } from 'zod';

import { HelperTools } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema, fixZodSchemaRequired } from '../../utils/ajv.js';
import { buildMCPResponse } from '../../utils/mcp.js';
import { CODE_DOCS_PAGE_NAMES, CODE_DOCS_PAGES, type CodeDocsPage } from './code_docs_content.js';

const DEFAULT_PAGE: CodeDocsPage = 'overview';

const getCodeDocsArgs = z.object({
    page: z
        .enum(CODE_DOCS_PAGE_NAMES)
        .default(DEFAULT_PAGE)
        .optional()
        .describe(
            `Which guide page to return. One of: ${CODE_DOCS_PAGE_NAMES.join(', ')}. Defaults to "${DEFAULT_PAGE}".`,
        ),
});

const getCodeDocsInputSchema = fixZodSchemaRequired(z.toJSONSchema(getCodeDocsArgs)) as ToolInputSchema;

const getCodeDocsOutputSchema = {
    type: 'object' as const,
    properties: {
        page: { type: 'string', description: 'The guide page name that was returned' },
        content: { type: 'string', description: 'Markdown content of the guide page' },
    },
    required: ['page', 'content'],
};

const GET_CODE_DOCS_DESCRIPTION = dedent`
    Read the Code Mode guide for writing ${HelperTools.CODE_RUN} scripts. The guide is split into
    manpage-style pages; this tool returns one page at a time.

    Call this BEFORE ${HelperTools.CODE_RUN} to learn the \`apify\` binding and the orchestration
    patterns, then write your script.

    Pages (pass via \`page\`):
    - overview — runtime model, sandbox limits, and how results come back (the default page)
    - api      — the \`apify\` binding method reference
    - recipes  — worked examples: calling & chaining Actors, storages, local aggregation
`;

/** Code Mode `get-code-docs` — static, paginated guide. No token or network required. */
export const getCodeDocs: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HelperTools.CODE_DOCS,
    title: 'Get code docs',
    description: GET_CODE_DOCS_DESCRIPTION,
    inputSchema: getCodeDocsInputSchema,
    outputSchema: getCodeDocsOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(getCodeDocsArgs)),
    annotations: {
        title: 'Get code docs',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const parsed = getCodeDocsArgs.parse(toolArgs.args);
        const page = (parsed.page ?? DEFAULT_PAGE) as CodeDocsPage;
        const content = CODE_DOCS_PAGES[page];
        return buildMCPResponse({
            texts: [content],
            structuredContent: { page, content },
        });
    },
} as const);
