/**
 * Configuration for workflow evaluation system
 * Includes model settings and prompts specific to workflow evaluations
 *
 * Note: Temperature is set to 0.15 for deterministic results (see llm-client.ts)
 */

// Re-export shared config for convenience
export { OPENROUTER_CONFIG, sanitizeEnvValue, sanitizeProcessEnv, validateEnvVars } from '../shared/config.js';

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
export const JUDGE_PROMPT_TEMPLATE = `You are evaluating an AI agent that used tools to complete a user's task.

Evaluate the agent's conversation against these 6 dimensions. Score each independently —
do not let a strong result on one dimension excuse a weak result on another. Give each a
verdict (PASS or FAIL) and a brief explanation (1-2 sentences).

1. toolSelection: Did the agent call appropriate tool(s) for the task (right tools, no
   unnecessary or missing calls)? A different tool than expected is fine if it accomplishes
   the same goal. [Note: for some test cases this is overridden by a deterministic check
   after your response — score it anyway, your answer may be discarded.]
2. argumentCorrectness: Were tool call arguments semantically correct and complete for
   the task (right IDs, filters, values) — not just schema-valid?
3. resultUtilization: Did the agent correctly read and use what each tool actually
   returned — not ignore an error, not misreport data, not claim something the result
   didn't say?
4. taskCompletion: Did the final response fully satisfy the requirements below? Judge the
   requirements, not the writing style.
5. errorRecovery: When a tool call failed or returned something unexpected, did the
   agent respond sensibly (retry, use an alternative, explain to the user) rather than
   stall or hallucinate? PASS when nothing went wrong and there was nothing to recover from.
6. planEfficiency: Was the path to the answer reasonably direct — no redundant calls,
   no excessive turns? Minor inefficiencies are acceptable.

TASK REQUIREMENTS:
{{reference}}

AGENT CONVERSATION (includes tool results):
{{conversation}}`;
