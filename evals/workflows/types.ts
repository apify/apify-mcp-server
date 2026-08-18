/**
 * Type definitions for workflow evaluation system
 */

/**
 * Represents the result of an MCP tool execution
 */
export type McpToolResult = {
    /** Name of the tool that was called */
    toolName: string;
    /** Whether the tool execution succeeded */
    success: boolean;
    /** Result data if successful, error message if failed */
    result?: unknown;
    /** Error message if execution failed */
    error?: string;
    /** UTF-8 byte size of the serialized content the agent receives (set when the result is fed to the LLM) */
    resultBytes?: number;
};

/**
 * A single turn in the conversation (agent action)
 */
export type ConversationTurn = {
    /** Tool calls made in this turn (if any) */
    toolCalls: {
        name: string;
        arguments: Record<string, unknown>;
    }[];
    /** Final text response from agent (if no more tool calls) */
    finalResponse?: string;
};

/**
 * The conversation as the judge and the scores read it - nothing else.
 *
 * Everything the SDK stream reports beyond this (tool results, per-turn numbering, turn
 * count, prompt/completion split, the result subtype) is on `ToolInvocation`,
 * `ConversationMetrics`, or handled where the stream is read.
 */
export type ConversationHistory = {
    /** Initial user prompt */
    userPrompt: string;
    /** All turns in the conversation */
    turns: ConversationTurn[];
    /** Total tokens billed across all agent LLM calls (prompt + completion); scored in Langfuse */
    totalTokens?: number;
};
