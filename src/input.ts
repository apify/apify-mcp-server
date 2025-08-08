/*
 * Actor input processing.
 */
import { z } from 'zod';

import log from '@apify/log';

import { defaults } from './const.js';
import type { ToolCategory } from './types.js';

const parseCommaSeparatedItems = (val: unknown): string[] | undefined => {
    if (typeof val === 'string') {
        const items = val.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
        return items.length > 0 ? items : [];
    }
    if (Array.isArray(val)) {
        const items = val
            .map((s) => (typeof s === 'string' ? s.trim() : ''))
            .filter((s) => s.length > 0);
        return items.length > 0 ? items : [];
    }
    // If value is not provided or not a string/array, return undefined so schema optional() can keep it undefined
    return undefined;
};

const parseBoolean = (val: unknown): boolean | undefined => {
    if (typeof val === 'boolean') return val;
    if (typeof val === 'string') return val.toLowerCase() === 'true';
    // Preserve undefined so defaults can apply later
    return undefined;
};

const toolCategoriesArray = ['docs', 'runs', 'storage', 'preview'] as const;
const mcpOptionsSchema = z.preprocess((originalInput) => {
    if (typeof originalInput === 'object' && originalInput !== null) {
        const inputObject = { ...(originalInput as Record<string, unknown>) };
        // Backward compatibility: map deprecated enableActorAutoLoading to enableAddingActors
        if (
            typeof inputObject.enableAddingActors === 'undefined'
            && typeof inputObject.enableActorAutoLoading !== 'undefined'
        ) {
            inputObject.enableAddingActors = inputObject.enableActorAutoLoading;
        }
        return inputObject;
    }
    return originalInput;
}, z.object({
    actors: z.preprocess(parseCommaSeparatedItems, z.array(z.string()).default(defaults.actors)),
    enableAddingActors: z.preprocess(parseBoolean, z.boolean().default(true)),
    enableDefaultActors: z.preprocess(parseBoolean, z.boolean().default(false)),
    tools: z.preprocess((val) => {
        const items = parseCommaSeparatedItems(val);
        if (!items) return items;
        // Ignore invalid tool keys by filtering them out
        // const toolCategoriesArray = Object.keys(toolCategories) as [ToolCategory];
        const invalid = items.filter((s) => !toolCategoriesArray.includes(s as ToolCategory));
        if (invalid.length > 0) {
            log.warning(`Ignoring unknown tool categories: ${invalid.join(', ')}. Valid categories are: ${toolCategoriesArray.join(', ')}`);
        }
        return items.filter((s) => toolCategoriesArray.includes(s as ToolCategory));
    }, z.array(z.enum(toolCategoriesArray)).default([])),
    fullActorSchema: z.boolean().default(false),
}));

export type McpOptions = z.infer<typeof mcpOptionsSchema>;

/**
 * Process input parameters, split Actors string into an array
 * @param originalInput
 * @returns McpOptions
 */
export const processInput = mcpOptionsSchema.parse;
