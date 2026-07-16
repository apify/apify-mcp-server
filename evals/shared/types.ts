/**
 * Shared type definitions for evaluation systems
 */

/**
 * Base test case interface - common fields for all test types
 */
export type BaseTestCase = {
    /** Unique test case ID */
    id: string;
    /** Category for grouping (e.g., "search-actors", "call-actor", "fetch-actor-details") */
    category: string;
    /** User query/prompt */
    query: string;
    /** Reference instructions or requirements */
    reference?: string;
};

/**
 * Test case for tool selection evaluation (Phoenix-based)
 * Used in: evals/run-evaluation.ts, evals/create-dataset.ts
 */
export type ToolSelectionTestCase = {
    /** Expected tools that should be called */
    expectedTools?: string[];
    /** Conversation context (for multi-turn scenarios) */
    context?:
        | string
        | {
              role: string;
              content: string;
              tool?: string;
              input?: Record<string, unknown>;
          }[];
} & BaseTestCase;

/**
 * Test case for workflow evaluation (multi-turn agent conversations)
 * Used in: evals/workflows/
 */
export const WORKFLOW_EVAL_ARM = {
    STANDARD: 'standard',
    CODE_MODE: 'code-mode',
} as const;
export type WorkflowEvalArm = (typeof WORKFLOW_EVAL_ARM)[keyof typeof WORKFLOW_EVAL_ARM];

export type WorkflowTestCase = {
    /** Maximum number of turns allowed (optional, defaults to config value) */
    maxTurns?: number;
    /** Tools to enable for this test (optional, e.g., ["actors", "docs", "apify/rag-web-browser"]) */
    tools?: string[];
    /** Enabled tools to hide from the agent and reject if called. */
    disallowedTools?: string[];
    /** Actor IDs the generic call-actor tool may run. */
    allowedCallActorTargets?: string[];
    /** Actor IDs the generic call-actor tool may not run. */
    disallowedCallActorTargets?: string[];
    /** Evaluation-only instructions appended to the agent system prompt. */
    agentInstructions?: string;
    /** Groups variants of the same task. */
    pairId?: string;
    /** Strategy variant for paired evaluations. */
    arm?: WorkflowEvalArm;
} & BaseTestCase;

/**
 * Test data structure wrapping test cases with version
 */
export type TestData = {
    /** Version of the test cases */
    version: string;
    /** Array of test cases */
    testCases: BaseTestCase[];
};

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
};
