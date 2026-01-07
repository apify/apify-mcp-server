/**
 * Shared type definitions for evaluation systems
 */

/**
 * Base test case interface - common fields for all test types
 */
export interface BaseTestCase {
    /** Unique test case ID */
    id: string;
    /** Category for grouping (e.g., "search-actors", "call-actor", "fetch-actor-details") */
    category: string;
    /** User query/prompt */
    query: string;
    /** Reference instructions or requirements */
    reference?: string;
}

/**
 * Test case for tool selection evaluation (Phoenix-based)
 * Used in: evals/run-evaluation.ts, evals/create-dataset.ts
 */
export interface ToolSelectionTestCase extends BaseTestCase {
    /** Expected tools that should be called */
    expectedTools?: string[];
    /** Conversation context (for multi-turn scenarios) */
    context?: string | Array<{
        role: string;
        content: string;
        tool?: string;
        input?: Record<string, unknown>;
    }>;
}

/**
 * Test case for workflow evaluation (multi-turn agent conversations)
 * Used in: evals/workflows/
 */
export interface WorkflowTestCase extends BaseTestCase {
    /** Maximum number of turns allowed (optional, defaults to config value) */
    maxTurns?: number;
    /** Tools to enable for this test (optional, e.g., ["actors", "docs", "apify/rag-web-browser"]) */
    tools?: string[];
}

/**
 * Test data structure wrapping test cases with version
 */
export interface TestData {
    /** Version of the test cases */
    version: string;
    /** Array of test cases */
    testCases: BaseTestCase[];
}

/**
 * MCP Tool definition from the server
 */
export interface McpTool {
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
