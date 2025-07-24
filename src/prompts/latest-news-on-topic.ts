import type { PromptArgument } from '@modelcontextprotocol/sdk/types.js';

import { fixedAjvCompile } from '../tools/utils.js';
import type { PromptBase } from '../types.js';
import { ajv } from '../utils/ajv.js';

/**
 * Prompt MCP arguments list.
 */
const args: PromptArgument[] = [
    {
        name: 'topic',
        description: 'The topic to retrieve the latest news on.',
        required: true,
    },
    {
        name: 'timespan',
        description: 'The timespan for which to retrieve news articles. Defaults to "7 days". For example "1 day", "3 days", "7 days", "1 month", etc.',
        required: false,
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
export const latestNewsOnTopicPrompt: PromptBase = {
    name: 'GetLatestNewsOnTopic',
    description: 'This prompt retrieves the latest news articles on a selected topic.',
    arguments: args,
    ajvValidate: argsSchema,
    render: (data) => {
        const currentDateUtc = new Date().toISOString().split('T')[0];
        const timespan = data.timespan && data.timespan.trim() !== '' ? data.timespan : '7 days';
        return `I want you to use the RAG web browser to search the web for the latest news on the "${data.topic}" topic. Retrieve news from the last ${timespan}. The RAG web browser accepts a query parameter that supports all Google input, including filters and flags—be sure to use them to accomplish my goal. Today is ${currentDateUtc} UTC.`;
    },
};
