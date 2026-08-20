/**
 * Folds the Claude Agent SDK's message stream into what the eval reads: the judge's
 * `ConversationHistory`, the tool invocations, the transcript, and the run metrics.
 *
 * The stream is an `init` system message, `assistant` messages (one frame per content
 * block, sharing `message.id` within a model turn), `user` messages carrying tool
 * results, and a final `result` message.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { isMcpToolName, stripToolPrefix } from './config.js';
import type { ConversationHistory, ConversationToolCall, ConversationTurn, McpToolResult } from './types.js';

/** One paired tool call + result, logged as a tool span under the item's trace. */
export type ToolInvocation = {
    name: string;
    arguments: unknown;
    result: McpToolResult;
    /** Epoch ms the call and its result were streamed, when the caller timed the stream */
    startedAt?: number;
    endedAt?: number;
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
    /** The share of promptTokens the API billed as cache reads / cache writes. */
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    totalCostUsd?: number;
    durationMs?: number;
};

export type AdaptedConversation = {
    conversation: ConversationHistory;
    toolInvocations: ToolInvocation[];
    metrics: ConversationMetrics;
    /**
     * Whether the run stopped on the turn limit instead of reaching a final answer. The
     * only non-success outcome that gets this far: every other subtype throws below.
     */
    hitMaxTurns: boolean;
    /**
     * Epoch ms the final model turn opened, when the caller timed the stream. The usage
     * generation is windowed to it rather than to the whole run.
     */
    finalTurnStartedAt?: number;
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

/**
 * Error text as the model saw it. A failed result is usually a string or text blocks;
 * `JSON.stringify` on those would quote and escape them, which is what Langfuse then shows
 * as one `\n`-riddled line instead of a readable message.
 */
function errorTextOf(content: unknown): string {
    if (typeof content === 'string') return content;

    const texts = blocksOf(content)
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text);

    return texts.length > 0 ? texts.join('\n') : JSON.stringify(content ?? null, null, 4);
}

/** A tool_use awaiting its result, so the two can be paired. */
type PendingToolUse = {
    name: string;
    arguments: unknown;
    startedAt?: number;
    /** The entry on the turn, so the result lands on the conversation the judge reads. */
    call: ConversationToolCall;
};

/**
 * `receivedAt` holds the epoch ms each message arrived, one per entry in `messages`. The
 * SDK stream carries no timestamps of its own, so this is the only way tool spans get a
 * real duration instead of collapsing to the moment the tree is emitted.
 */
export function adaptSdkConversation(
    userPrompt: string,
    messages: SDKMessage[],
    receivedAt?: readonly number[],
): AdaptedConversation {
    const turns: ConversationTurn[] = [];
    const toolInvocations: ToolInvocation[] = [];
    const transcript: TranscriptEntry[] = [];
    const pendingToolUses = new Map<string, PendingToolUse>();
    let totalResultBytes = 0;
    let claudeCodeVersion: string | undefined;
    let finalTurnStartedAt: number | undefined;

    let numTurns: number | undefined;
    let usage:
        | { promptTokens: number; completionTokens: number; cacheReadTokens: number; cacheCreationTokens: number }
        | undefined;
    let totalCostUsd: number | undefined;
    let durationMs: number | undefined;
    let resultSubtype: string | undefined;
    let resultErrors: string[] = [];
    let finalResultText = '';
    /**
     * The CLI splits every assistant turn into one wire frame per content block, all
     * sharing `message.id`, so consecutive frames with the same id fold into one turn.
     * Without this, narration that accompanies a tool call becomes its own text-only turn
     * and leaks to the judge as an AGENT: line, and turn counts inflate.
     */
    let openAssistantId: string | undefined;

    for (const [messageIndex, message] of messages.entries()) {
        const messageTime = receivedAt?.[messageIndex];

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
            const messageId = message.message.id;
            const merging = messageId !== undefined && messageId === openAssistantId;
            openAssistantId = messageId;

            const textParts: string[] = [];
            const thinkingParts: string[] = [];
            const toolCalls: ConversationToolCall[] = [];

            for (const block of blocks) {
                if (block.type === 'text') {
                    textParts.push(block.text);
                } else if (block.type === 'thinking') {
                    thinkingParts.push(block.thinking);
                } else if (block.type === 'tool_use') {
                    const name = stripToolPrefix(block.name);
                    const call: ConversationToolCall = {
                        name,
                        arguments: (block.input ?? {}) as Record<string, unknown>,
                        isMcpTool: isMcpToolName(block.name),
                    };
                    toolCalls.push(call);
                    pendingToolUses.set(block.id, { name, arguments: block.input, startedAt: messageTime, call });
                }
            }

            const text = textParts.join('\n').trim();
            const thinking = thinkingParts.join('\n').trim();

            let turn = merging ? turns[turns.length - 1] : undefined;
            let entry = merging ? transcript[transcript.length - 1] : undefined;
            if (!turn || !entry) {
                turn = { toolCalls: [] };
                turns.push(turn);
                entry = { role: 'assistant' };
                transcript.push(entry);
                finalTurnStartedAt = messageTime;
            }

            turn.toolCalls.push(...toolCalls);
            // Match the old harness: only a text-only turn exposes a finalResponse to the judge.
            if (text && turn.toolCalls.length === 0) {
                turn.finalResponse = turn.finalResponse ? `${turn.finalResponse}\n${text}` : text;
            } else if (turn.toolCalls.length > 0) {
                delete turn.finalResponse;
            }

            if (text) entry.text = entry.text ? `${entry.text}\n${text}` : text;
            if (thinking) entry.thinking = entry.thinking ? `${entry.thinking}\n${thinking}` : thinking;
            if (toolCalls.length > 0) {
                entry.toolCalls = [...(entry.toolCalls ?? []), ...toolCalls.map((toolCall) => toolCall.name)];
            }
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
                    error: success ? undefined : errorTextOf(block.content),
                    resultBytes,
                };
                // The judge reads the conversation, not the invocations, so the result is
                // attached to the call that produced it as well.
                pending.call.result = result;
                toolInvocations.push({
                    name: pending.name,
                    arguments: pending.arguments,
                    result,
                    ...(pending.startedAt === undefined ? {} : { startedAt: pending.startedAt }),
                    ...(messageTime === undefined ? {} : { endedAt: messageTime }),
                });
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
            const cacheReadTokens = message.usage.cache_read_input_tokens ?? 0;
            const cacheCreationTokens = message.usage.cache_creation_input_tokens ?? 0;
            usage = {
                promptTokens: message.usage.input_tokens + cacheReadTokens + cacheCreationTokens,
                completionTokens: message.usage.output_tokens,
                cacheReadTokens,
                cacheCreationTokens,
            };
            if (message.subtype === 'success') finalResultText = message.result.trim();
            else resultErrors = message.errors;
        }
    }

    const completed = resultSubtype === 'success';
    const hitMaxTurns = resultSubtype === 'error_max_turns';

    // Any other error subtype (API error, context overflow, budget) is a harness failure, not
    // a bad answer. Throw so the run fails on it instead of the judge scoring a truncated
    // conversation it cannot tell apart from a normal one.
    if (!completed && !hitMaxTurns) {
        const reason = resultSubtype ?? 'the stream ended without a result message';
        const details = resultErrors.length > 0 ? ` - ${resultErrors.join('; ')}` : '';
        throw new Error(`Agent run failed: ${reason}${details}`);
    }

    // Ensure the final answer is in the transcript exactly once. A text-only last turn
    // already carries it via finalResponse; otherwise append a terminal turn.
    const lastTurn = turns[turns.length - 1];
    if (completed && finalResultText && (!lastTurn || lastTurn.toolCalls.length > 0 || !lastTurn.finalResponse)) {
        turns.push({ toolCalls: [], finalResponse: finalResultText });
    }

    const conversation: ConversationHistory = {
        userPrompt,
        turns,
        totalTokens: usage ? usage.promptTokens + usage.completionTokens : undefined,
    };

    const metrics: ConversationMetrics = {
        resultBytes: totalResultBytes,
        turns: numTurns ?? turns.length,
        promptTokens: usage?.promptTokens,
        completionTokens: usage?.completionTokens,
        cacheReadTokens: usage?.cacheReadTokens,
        cacheCreationTokens: usage?.cacheCreationTokens,
        totalCostUsd,
        durationMs,
    };

    return {
        conversation,
        toolInvocations,
        metrics,
        hitMaxTurns,
        finalTurnStartedAt,
        claudeCodeVersion,
        transcript,
    };
}
