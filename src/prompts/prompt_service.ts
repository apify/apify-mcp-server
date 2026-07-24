import { InvalidParamsError } from '../mcp/errors.js';
import type { PromptBase } from '../types.js';

type PromptMessage = {
    role: 'user';
    content: {
        type: 'text';
        text: string;
    };
};

type GetPromptResult = {
    description?: string;
    messages: PromptMessage[];
};

type PromptService = {
    listPrompts: () => { prompts: PromptBase[] };
    getPrompt: (name: string, args?: Record<string, string>) => GetPromptResult;
};

/**
 * Prompt list/get logic, mirroring `createResourceService`'s factory + explicit-dependency shape.
 * Throws {@link InvalidParamsError} for an unknown prompt name or arguments that fail AJV validation;
 * the `server.ts` boundary maps that to the v1 InvalidParams JSON-RPC error at the wire seam.
 */
export function createPromptService(prompts: PromptBase[]): PromptService {
    const listPrompts = (): { prompts: PromptBase[] } => {
        return { prompts };
    };

    const getPrompt = (name: string, args?: Record<string, string>): GetPromptResult => {
        const prompt = prompts.find((p) => p.name === name);
        if (!prompt) {
            throw new InvalidParamsError(
                `Prompt ${name} not found. Available prompts: ${prompts.map((p) => p.name).join(', ')}`,
            );
        }
        if (!prompt.ajvValidate(args)) {
            throw new InvalidParamsError(
                `Invalid arguments for prompt ${name}: args: ${JSON.stringify(args)} error: ${JSON.stringify(prompt.ajvValidate.errors)}`,
            );
        }
        return {
            description: prompt.description,
            messages: [
                {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: prompt.render(args || {}),
                    },
                },
            ],
        };
    };

    return {
        listPrompts,
        getPrompt,
    };
}
