/**
 * Type definitions for MCP agent evaluation system
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
    toolCalls: {
        name: string;
        arguments: Record<string, unknown>;
    }[];
    /** Agent text, set only on a turn that made no tool calls */
    finalResponse?: string;
};

/**
 * The conversation as the judge and the scores read it
 */
export type ConversationHistory = {
    userPrompt: string;
    turns: ConversationTurn[];
    /** Agent tokens across the conversation (prompt + completion); scored in Langfuse */
    totalTokens?: number;
};
