/**
 * Pure helpers for summarizing evaluation output.
 */

import type { ConversationHistory } from './types.js';

/**
 * Sum the byte size of all tool results returned to the agent across a conversation.
 * This is the data volume returned by the tools, independent of the model's own output.
 */
export function sumResultBytes(conversation: ConversationHistory): number {
    let total = 0;
    for (const turn of conversation.turns) {
        for (const toolResult of turn.toolResults) {
            total += toolResult.resultBytes ?? 0;
        }
    }
    return total;
}
