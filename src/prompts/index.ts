import type { PromptBase } from '../types.js';
import { latestInstagramPostPrompt } from './latest-instagram-post.js';

/**
 * List of all enabled prompts.
 */
export const prompts: PromptBase[] = [
    latestInstagramPostPrompt,
];
