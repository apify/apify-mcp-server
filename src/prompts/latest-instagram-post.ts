import type { PromptArgument } from '@modelcontextprotocol/sdk/types.js';

import { fixedAjvCompile } from '../tools/utils.js';
import type { PromptBase } from '../types.js';
import { ajv } from '../utils/ajv.js';

/**
 * Prompt MCP arguments list.
 */
const args: PromptArgument[] = [
    {
        name: 'username',
        description: 'The Instagram username of the account to retrieve the latest post from.',
        required: true,
    },
];

/**
 * Prompt AJV arguments schema for validation.
 */
const argsSchema = fixedAjvCompile(ajv, {
    type: 'object',
    properties: {
        ...Object.fromEntries(args.map((arg) => [arg.name, {
            type: 'string',
            description: arg.description,
            default: arg.default,
            examples: arg.examples,
        }])),
    },
    required: [...args.filter((arg) => arg.required).map((arg) => arg.name)],
});

/**
 * Actual prompt definition.
 */
export const latestInstagramPostPrompt: PromptBase = {
    name: 'LatestInstagramPostPrompt',
    description: 'This prompt retrieves the latest Instagram post of a selected instagram account.',
    arguments: args,
    ajvValidate: argsSchema,
    render: ((data) => {
        return `I want you to retrieve description, total number of likes and comments of the 1 latest Instagram post of the account with username "${data.username}".
To accomplish this you need to:
1) Add "apify/instagram-scraper" Actor to this session if not already present using the Actor add tool.
2) Get details about the Actor and its input schema using the get Actor details tool.
3) Run the Actor for the given username.
`;
    }),
};
