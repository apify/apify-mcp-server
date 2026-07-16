/**
 * Configuration for workflow evaluation system
 * Includes model settings and prompts specific to workflow evaluations
 *
 * Note: Temperature is set to 0.15 for deterministic results (see llm-client.ts)
 */

import { sanitizeEnvValue } from '../shared/config.js';

// Re-export shared config for convenience
export { OPENROUTER_CONFIG, sanitizeEnvValue, sanitizeProcessEnv, validateEnvVars } from '../shared/config.js';

/**
 * Opik project and dataset names (self-hosted). Traces/experiments land in this project,
 * test cases are synced into this dataset.
 */
export const OPIK_PROJECT_NAME = 'workflow-evals';
export const OPIK_DATASET_NAME = 'workflow-evals';

/**
 * Default Opik base URL for the local self-hosted server. NEVER fall through to the SDK's
 * Comet-cloud default. Start Opik locally with:
 *   git clone https://github.com/comet-ml/opik.git && cd opik && ./opik.sh
 */
export const OPIK_DEFAULT_URL = 'http://localhost:5173/api';

/**
 * Opik connection config. URL is overridable via OPIK_URL_OVERRIDE; OPIK_API_KEY is respected
 * if set (not required locally). Workspace defaults to "default".
 */
export const OPIK_CONFIG = {
    apiUrl: sanitizeEnvValue(process.env.OPIK_URL_OVERRIDE) || OPIK_DEFAULT_URL,
    apiKey: sanitizeEnvValue(process.env.OPIK_API_KEY) || '',
    workspaceName: 'default',
    projectName: OPIK_PROJECT_NAME,
};

/**
 * Default model configuration for agent and judge
 * These can be overridden via CLI arguments:
 *   --agent-model <model>
 *   --judge-model <model>
 */
export const MODELS = {
    // Agent model - the AI that performs tasks using tools
    agent: 'anthropic/claude-haiku-4.5',

    // Judge model - evaluates conversation quality
    judge: 'deepseek/deepseek-v4-flash',
};

/**
 * System prompt for the agent
 * Note: MCP server instructions are automatically appended to this prompt if provided by the server
 */
export const AGENT_SYSTEM_PROMPT = `You are a helpful AI assistant with access to Apify tools for web scraping and automation.

Your goal is to help users accomplish their tasks using the available tools.

Guidelines:
- Use tools when needed to complete user requests
- Provide clear, concise responses
- If you need more information, ask the user
- After using tools, summarize the results for the user
- Be direct and efficient

Available tools will be provided to you automatically.`;

/**
 * Maximum number of conversation turns before timeout
 */
export const MAX_CONVERSATION_TURNS = 10;

/**
 * Default timeout for MCP tool calls (in seconds)
 * This is the maximum time to wait for a single tool call to complete.
 *
 * Note: Actor runs that take longer than this will timeout.
 * For long-running Actors, increase this value via CLI: --tool-timeout 600
 */
export const DEFAULT_TOOL_TIMEOUT_SECONDS = 60;

/**
 * Judge prompt template for evaluating conversations
 * Uses structured output (JSON schema) - no format instructions needed
 *
 * Variables:
 * - {{reference}}: The requirements the agent should meet
 * - {{conversation}}: The formatted conversation to evaluate
 */
export const JUDGE_PROMPT_TEMPLATE = `You are evaluating whether an AI agent successfully completed a user's task using available tools.

TASK REQUIREMENTS:
{{reference}}

AGENT CONVERSATION:
{{conversation}}

Your task is to evaluate if the agent met ALL the requirements listed above.

Evaluation criteria:
1. Did the agent use appropriate tools to accomplish the task?
2. Were the tool calls made with correct arguments?
3. Did the agent provide a clear, helpful final response to the user?
4. Did the agent fully address all requirements?

Important notes:
- Focus on whether requirements were met, not on writing style
- The agent may use different tools than expected if they accomplish the same goal
- Tool results are not shown (only tool calls and agent responses)
- Minor inefficiencies are acceptable if the task was completed

Provide your evaluation with a verdict (PASS or FAIL) and a brief explanation (1-2 sentences).`;
