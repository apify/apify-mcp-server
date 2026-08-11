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
    /** Turn number (1-indexed) */
    turnNumber: number;
    /** Tool calls made in this turn (if any) */
    toolCalls: {
        name: string;
        arguments: Record<string, unknown>;
    }[];
    /** Tool results for this turn (if any) */
    toolResults: McpToolResult[];
    /** Final text response from agent (if no more tool calls) */
    finalResponse?: string;
};

/**
 * Complete conversation history
 */
export type ConversationHistory = {
    /** Initial user prompt */
    userPrompt: string;
    /** All turns in the conversation */
    turns: ConversationTurn[];
    /** Whether conversation completed successfully */
    completed: boolean;
    /** Whether conversation hit max turns limit */
    hitMaxTurns: boolean;
    /** Total number of turns */
    totalTurns: number;
    /** Prompt tokens billed across all agent LLM calls (sum over turns; judge calls excluded) */
    promptTokens?: number;
    /** Completion tokens billed across all agent LLM calls */
    completionTokens?: number;
    /** Total tokens billed across all agent LLM calls (prompt + completion) */
    totalTokens?: number;
};
