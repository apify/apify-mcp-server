/**
 * Configuration for workflow evaluations.
 *
 * Models, prompts, and constants shared by the in-container agent entrypoint
 * (run_single_trial.ts), the verifier (run_judge.ts), and the host-side
 * orchestrator (run_workflow_evals.ts). Opik itself is driven by the Python
 * `opik harbor run` wrapper; the constants here only tell the orchestrator
 * which env to hand that wrapper so it targets the local self-hosted server.
 */

// Re-export shared config for convenience.
export { OPENROUTER_CONFIG, sanitizeEnvValue } from '../shared/config.js';

/**
 * Opik project the Harbor traces land in. Set as OPIK_PROJECT_NAME for the
 * `opik harbor run` child so every trial trace is grouped here.
 */
export const OPIK_PROJECT_NAME = 'workflow-evals';

/** Opik workspace for the self-hosted server. Never the Comet-cloud default. */
export const OPIK_WORKSPACE = 'default';

/**
 * Local self-hosted Opik API URL. Overridable via OPIK_URL_OVERRIDE; the
 * orchestrator passes this to the child so the Python SDK never falls through
 * to Comet cloud.
 */
export const OPIK_LOCAL_API_URL = 'http://localhost:5173/api';

/** Prebuilt Docker image tag every generated task's environment references. */
export const DOCKER_IMAGE_TAG = 'apify-mcp-evals:local';

/**
 * Default model configuration for agent and judge. Overridable via CLI:
 *   --agent-model <model>
 *   --judge-model <model>
 */
export const MODELS = {
    // Agent model - the AI that performs tasks using tools.
    agent: 'anthropic/claude-haiku-4.5',
    // Judge model - evaluates conversation quality.
    judge: 'deepseek/deepseek-v4-flash',
};

/**
 * System prompt for the agent.
 * MCP server instructions are appended to this prompt when the server provides them.
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

/** Maximum number of conversation turns before timeout. */
export const MAX_CONVERSATION_TURNS = 10;

/**
 * Default timeout for MCP tool calls (in seconds). Maximum time to wait for a
 * single tool call. Long-running Actors need a higher value: --tool-timeout 600.
 */
export const DEFAULT_TOOL_TIMEOUT_SECONDS = 60;

/**
 * Judge prompt template for evaluating conversations. Uses structured output
 * (JSON schema), so no format instructions are needed.
 *
 * Variables:
 * - {{reference}}: the requirements the agent should meet
 * - {{conversation}}: the formatted conversation to evaluate
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
