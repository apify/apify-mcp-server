/*
 * Actor input processing.
 */
import { z } from 'zod';

import type { ToolCategory } from './types.js';
import { toolCategories } from './tools/index.js';

const toolCategoryKeys = Object.keys(toolCategories) as [ToolCategory];
const ToolCategoryEnum = z.enum(toolCategoryKeys);

const parseCommaSeparatedItems = (val: unknown): string[] => {
    if (typeof val === 'string') {
        return val.split(',').map(s => s.trim());
    }
    if (Array.isArray(val)) {
        return val.map(s => typeof s === 'string' ? s.trim() : '');
    }
    return [];
};

const parseBoolean = (val: unknown): boolean => {
    if (typeof val === 'boolean') return val;
    if (typeof val === 'string') return val.toLowerCase() === 'true';
    return false;
};

const mcpOptionsSchema = z.object({
    actors: z.preprocess(parseCommaSeparatedItems, z.array(z.string())),
    enableAddingActors: z.preprocess(parseBoolean, z.boolean().default(true)),
    tools: z.preprocess(parseCommaSeparatedItems, z.array(ToolCategoryEnum)),
    fullActorSchema: z.boolean().default(false),
});
export type McpOptions = z.infer<typeof mcpOptionsSchema>;

/**
 * Process input parameters, split Actors string into an array
 * @param originalInput
 * @returns McpOptions
 */
export const processInput = mcpOptionsSchema.parse;
