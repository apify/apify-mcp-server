/**
 * Adapts the Claude Agent SDK's message stream into the eval's `ConversationHistory`.
 *
 * The Agent SDK yields a stream of `SDKMessage`s (an `init` system message, one
 * `assistant` message per model turn, `user` messages carrying tool results, and a
 * final `result` message). The judge and the experiment scores were built against the
 * old hand-rolled loop's `ConversationHistory`, so this module reconstructs that exact
 * shape - leaving `types.ts`, `workflow_judge.ts`, and the evaluators untouched.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { stripToolPrefix } from './config.js';
import type { ConversationHistory, ConversationTurn, McpToolResult } from './types.js';

/** One paired tool call + result, logged as a tool span under the item's trace. */
export type ToolInvocation = {
    name: string;
    arguments: unknown;
    result: McpToolResult;
};

/** A compact record of agent narration + thinking, logged to the item's trace (never judged). */
export type TranscriptEntry = {
    role: 'assistant';
    text?: string;
    thinking?: string;
    toolCalls?: string[];
};

/** Per-case metrics reconstructed from the SDK stream. */
export type ConversationMetrics = {
    resultBytes: number;
    turns: number;
    promptTokens?: number;
    completionTokens?: number;
    totalCostUsd?: number;
    durationMs?: number;
};

export type AdaptedConversation = {
    conversation: ConversationHistory;
    toolInvocations: ToolInvocation[];
    metrics: ConversationMetrics;
    /** Claude Code runtime version from the `init` message. */
    claudeCodeVersion?: string;
    /** Agent narration + thinking, for the item's trace. Not shown to the judge. */
    transcript: TranscriptEntry[];
};

/**
 * Block shapes the adapter reads. Every other type the SDK emits (images, redacted
 * thinking, ...) lands in `unread` and is skipped.
 */
type ContentBlock =
    | { type: 'text'; text: string }
    | { type: 'thinking'; thinking: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
    | { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean }
    | { type: 'unread' };

/** SDK message content is `string | Block[]`; normalize to the blocks we care about. */
function blocksOf(content: unknown): ContentBlock[] {
    return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

/** Where a pending tool_use lives so its result can be attached to the right turn. */
type PendingToolUse = {
    turnIndex: number;
    name: string;
    arguments: unknown;
};

export function adaptSdkConversation(userPrompt: string, messages: SDKMessage[]): AdaptedConversation {
    const turns: ConversationTurn[] = [];
    const toolInvocations: ToolInvocation[] = [];
    const transcript: TranscriptEntry[] = [];
    const pendingToolUses = new Map<string, PendingToolUse>();
    let totalResultBytes = 0;
    let claudeCodeVersion: string | undefined;

    let numTurns: number | undefined;
    let usage: { promptTokens: number; completionTokens: number } | undefined;
    let totalCostUsd: number | undefined;
    let durationMs: number | undefined;
    let resultSubtype: string | undefined;
    let finalResultText = '';

    for (const message of messages) {
        // Ignore subagent activity so the transcript reflects the main agent.
        if ((message.type === 'assistant' || message.type === 'user') && message.parent_tool_use_id !== null) {
            continue;
        }

        if (message.type === 'system' && message.subtype === 'init') {
            claudeCodeVersion = message.claude_code_version;
            continue;
        }

        if (message.type === 'assistant') {
            const blocks = blocksOf(message.message.content);
            const textParts: string[] = [];
            const thinkingParts: string[] = [];
            const toolCalls: { name: string; arguments: Record<string, unknown> }[] = [];
            const turnIndex = turns.length;

            for (const block of blocks) {
                if (block.type === 'text') {
                    textParts.push(block.text);
                } else if (block.type === 'thinking') {
                    thinkingParts.push(block.thinking);
                } else if (block.type === 'tool_use') {
                    const name = stripToolPrefix(block.name);
                    toolCalls.push({ name, arguments: (block.input ?? {}) as Record<string, unknown> });
                    pendingToolUses.set(block.id, { turnIndex, name, arguments: block.input });
                }
            }

            const text = textParts.join('\n').trim();
            const turn: ConversationTurn = { turnNumber: turnIndex + 1, toolCalls, toolResults: [] };
            // Match the old harness: only a text-only turn exposes a finalResponse to the judge.
            if (toolCalls.length === 0 && text) {
                turn.finalResponse = text;
            }
            turns.push(turn);

            const entry: TranscriptEntry = { role: 'assistant' };
            if (text) entry.text = text;
            const thinking = thinkingParts.join('\n').trim();
            if (thinking) entry.thinking = thinking;
            if (toolCalls.length > 0) entry.toolCalls = toolCalls.map((toolCall) => toolCall.name);
            transcript.push(entry);
            continue;
        }

        if (message.type === 'user') {
            for (const block of blocksOf(message.message.content)) {
                if (block.type !== 'tool_result') continue;
                const pending = pendingToolUses.get(block.tool_use_id);
                if (!pending) continue;

                const serialized = JSON.stringify(block.content ?? null);
                const resultBytes = Buffer.byteLength(serialized, 'utf8');
                totalResultBytes += resultBytes;

                const success = block.is_error !== true;
                const result: McpToolResult = {
                    toolName: pending.name,
                    success,
                    result: success ? block.content : undefined,
                    error: success ? undefined : serialized,
                    resultBytes,
                };
                turns[pending.turnIndex]?.toolResults.push(result);
                toolInvocations.push({ name: pending.name, arguments: pending.arguments, result });
            }
            continue;
        }

        if (message.type === 'result') {
            resultSubtype = message.subtype;
            numTurns = message.num_turns;
            totalCostUsd = message.total_cost_usd;
            durationMs = message.duration_ms;
            // Cache reads and writes are prompt tokens the API reports separately. Left out,
            // a cached run reports a handful of prompt tokens and the total_tokens score stops
            // reflecting what the tool output actually costs.
            usage = {
                promptTokens:
                    message.usage.input_tokens +
                    (message.usage.cache_read_input_tokens ?? 0) +
                    (message.usage.cache_creation_input_tokens ?? 0),
                completionTokens: message.usage.output_tokens,
            };
            if (message.subtype === 'success') finalResultText = message.result.trim();
        }
    }

    const completed = resultSubtype === 'success';
    const hitMaxTurns = resultSubtype === 'error_max_turns';

    // Ensure the final answer is in the transcript exactly once. A text-only last turn
    // already carries it via finalResponse; otherwise append a terminal turn.
    const lastTurn = turns[turns.length - 1];
    if (completed && finalResultText && (!lastTurn || lastTurn.toolCalls.length > 0 || !lastTurn.finalResponse)) {
        turns.push({ turnNumber: turns.length + 1, toolCalls: [], toolResults: [], finalResponse: finalResultText });
    }

    const totalTurns = numTurns ?? turns.length;

    const conversation: ConversationHistory = {
        userPrompt,
        turns,
        completed,
        hitMaxTurns,
        totalTurns,
        promptTokens: usage?.promptTokens,
        completionTokens: usage?.completionTokens,
        totalTokens: usage ? usage.promptTokens + usage.completionTokens : undefined,
    };

    const metrics: ConversationMetrics = {
        resultBytes: totalResultBytes,
        turns: totalTurns,
        promptTokens: usage?.promptTokens,
        completionTokens: usage?.completionTokens,
        totalCostUsd,
        durationMs,
    };

    return { conversation, toolInvocations, metrics, claudeCodeVersion, transcript };
}
