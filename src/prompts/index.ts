import type { PromptBase } from '../types.js';
import { latestNewsOnTopicPrompt } from './latest_news_on_topic.js';

/**
 * List of all enabled prompts.
 */
export const prompts: PromptBase[] = [
    latestNewsOnTopicPrompt,
];
