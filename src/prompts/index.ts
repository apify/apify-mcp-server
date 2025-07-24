import type { PromptBase } from '../types.js';
import { latestNewsOnTopicPrompt } from './latest-news-on-topic.js';

/**
 * List of all enabled prompts.
 */
export const prompts: PromptBase[] = [
    latestNewsOnTopicPrompt,
];
