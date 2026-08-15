/**
 * Summarizes one Claude Agent SDK run: token usage, tool invocations, and a debug transcript.
 *
 * The judge reads the SDK message stream directly (`formatSdkStreamForJudge`), so nothing
 * here reshapes the conversation. What is left is the accounting the stream does not give
 * you for free: usage totals including cache tokens, paired tool calls and results, and the
 * gate that tells a truncated harness run apart from a genuinely bad answer.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { stripToolPrefix } from './config.js';
import { isMainAgentMessage, readBlocks, readText } from './sdk_messages.js';

/** The result of one MCP tool execution. */
export type ToolResult = {
    toolName: string;
    success: boolean;
    /** Result data if successful. */
    result?: unknown;
    /** Serialized payload if the call failed. */
    error?: string;
    /** UTF-8 byte size of the serialized content the agent receives. */
    resultBytes: number;
};

/** One paired tool call + result. */
export type ToolInvocation = {
    name: string;
    arguments: unknown;
    result: ToolResult;
};

/** A compact record of agent narration + thinking. Debug view only, never judged. */
export type TranscriptEntry = {
    role: 'assistant';
    text?: string;
    thinking?: string;
    toolCalls?: string[];
};

/** Per-case metrics reconstructed from the SDK stream. */
export type RunMetrics = {
    resultBytes: number;
    turns: number;
    promptTokens?: number;
    completionTokens?: number;
    totalCostUsd?: number;
    durationMs?: number;
};

export type AgentRun = {
    /** Whether the SDK reported a `success` result. */
    completed: boolean;
    /** Whether the run stopped because it ran out of turns. */
    hitMaxTurns: boolean;
    /** Agent tokens across the run; undefined when the SDK never reported usage. */
    totalTokens?: number;
    toolInvocations: ToolInvocation[];
    metrics: RunMetrics;
    /** Claude Code runtime version from the `init` message. */
    claudeCodeVersion?: string;
    /** Agent narration + thinking. Not shown to the judge. */
    transcript: TranscriptEntry[];
};

/** Where a pending tool_use lives so its result can be paired with it. */
type PendingToolUse = { name: string; arguments: unknown };

export function buildAgentRun(messages: SDKMessage[]): AgentRun {
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
    let resultErrors: string[] = [];
    let assistantMessageCount = 0;

    for (const message of messages) {
        // Ignore subagent activity so the transcript reflects the main agent.
        if (!isMainAgentMessage(message)) continue;

        if (message.type === 'system' && message.subtype === 'init') {
            claudeCodeVersion = message.claude_code_version;
            continue;
        }

        if (message.type === 'assistant') {
            assistantMessageCount += 1;
            const blocks = readBlocks(message.message.content);
            const entry: TranscriptEntry = { role: 'assistant' };

            const text = readText(blocks);
            if (text) entry.text = text;

            const thinking = blocks
                .filter((block) => block.type === 'thinking')
                .map((block) => block.thinking)
                .join('\n')
                .trim();
            if (thinking) entry.thinking = thinking;

            const toolNames: string[] = [];
            for (const block of blocks) {
                if (block.type !== 'tool_use') continue;
                const name = stripToolPrefix(block.name);
                toolNames.push(name);
                pendingToolUses.set(block.id, { name, arguments: block.input });
            }
            if (toolNames.length > 0) entry.toolCalls = toolNames;

            transcript.push(entry);
            continue;
        }

        if (message.type === 'user') {
            for (const block of readBlocks(message.message.content)) {
                if (block.type !== 'tool_result') continue;
                const pending = pendingToolUses.get(block.tool_use_id);
                if (!pending) continue;

                const serialized = JSON.stringify(block.content ?? null);
                const resultBytes = Buffer.byteLength(serialized, 'utf8');
                totalResultBytes += resultBytes;

                const success = block.is_error !== true;
                toolInvocations.push({
                    name: pending.name,
                    arguments: pending.arguments,
                    result: {
                        toolName: pending.name,
                        success,
                        result: success ? block.content : undefined,
                        error: success ? undefined : serialized,
                        resultBytes,
                    },
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
            usage = {
                promptTokens:
                    message.usage.input_tokens +
                    (message.usage.cache_read_input_tokens ?? 0) +
                    (message.usage.cache_creation_input_tokens ?? 0),
                completionTokens: message.usage.output_tokens,
            };
            if (message.subtype !== 'success') resultErrors = message.errors;
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

    return {
        completed,
        hitMaxTurns,
        totalTokens: usage ? usage.promptTokens + usage.completionTokens : undefined,
        toolInvocations,
        metrics: {
            resultBytes: totalResultBytes,
            turns: numTurns ?? assistantMessageCount,
            promptTokens: usage?.promptTokens,
            completionTokens: usage?.completionTokens,
            totalCostUsd,
            durationMs,
        },
        claudeCodeVersion,
        transcript,
    };
}
