/**
 * Type definitions for workflow evaluation system
 */

/**
 * Represents a tool call made to the MCP server
 */
export type McpToolCall = {
    /** Name of the tool being called */
    name: string;
    /** Arguments passed to the tool */
    arguments: Record<string, unknown>;
}

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
}

/**
 * MCP Tool definition from the server
 */
export type McpTool = {
    /** Tool name */
    name: string;
    /** Tool description */
    description?: string;
    /** JSON Schema for input parameters */
    inputSchema: {
        type: string;
        properties?: Record<string, unknown>;
        required?: string[];
        [key: string]: unknown;
    };
}

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
}

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
}
