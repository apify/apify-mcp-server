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
 * One tool call the agent made, paired with what came back.
 */
export type ConversationToolCall = {
    /** Tool name, with the SDK's `mcp__<server>__` prefix stripped */
    name: string;
    arguments: Record<string, unknown>;
    /** Whether the call went to the Apify MCP server rather than a Claude Code built-in tool */
    isMcpTool: boolean;
    /** What the tool returned, set once the SDK streamed the result back */
    result?: McpToolResult;
};

/**
 * A single turn in the conversation (agent action)
 */
export type ConversationTurn = {
    toolCalls: ConversationToolCall[];
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
