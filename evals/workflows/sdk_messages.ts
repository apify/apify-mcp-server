/**
 * Reading the Claude Agent SDK's message stream.
 *
 * The SDK yields an `init` system message, one `assistant` message per model turn, `user`
 * messages carrying tool results, and a final `result` message. Both the judge and the run
 * summary read that stream directly, so the block shapes live here rather than in either.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * Block shapes we read. Every other type the SDK emits (images, redacted thinking, ...)
 * falls through the `switch`/`if` chains that consume this.
 */
export type ContentBlock =
    | { type: 'text'; text: string }
    | { type: 'thinking'; thinking: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
    | { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean };

/** SDK message content is `string | Block[]`; normalize to the blocks we care about. */
export function readBlocks(content: unknown): ContentBlock[] {
    return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

/** False for subagent (`Task` tool) activity, so only the main agent is read. */
export function isMainAgentMessage(message: SDKMessage): boolean {
    return (message.type !== 'assistant' && message.type !== 'user') || message.parent_tool_use_id === null;
}

/** The assistant text of one message, joined and trimmed. Empty when it had none. */
export function readText(blocks: ContentBlock[]): string {
    return blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();
}
