/**
 * Configuration for MCP agent evaluation system.
 *
 * The agent's system prompt and tools come from the SDK's `claude_code` presets, so
 * nothing here defines them. The judge runs on OpenRouter (temperature 0.15, see
 * llm_client.ts) by default, or on the Claude Agent SDK with `--claude-judge` (see
 * claude_judge_client.ts).
 */

// Re-export shared config for convenience
export { OPENROUTER_CONFIG, sanitizeProcessEnv } from '../shared/config.js';

/** Name the Claude Agent SDK registers the Apify MCP server under. */
export const MCP_SERVER_NAME = 'apify';

const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/** Whether the SDK tool name belongs to the Apify MCP server rather than Claude Code's built-ins. */
export function isMcpToolName(name: string): boolean {
    return name.startsWith(MCP_TOOL_PREFIX);
}

/** Strip the SDK's `mcp__<server>__` prefix; built-in tool names pass through unchanged. */
export function stripToolPrefix(name: string): string {
    return isMcpToolName(name) ? name.slice(MCP_TOOL_PREFIX.length) : name;
}

/**
 * Default model configuration for agent and judge
 * These can be overridden via CLI arguments:
 *   --agent-model <model>
 *   --judge-model <model>
 */
export const MODELS = {
    // Agent model - an Anthropic model ID for the Claude Agent SDK. A weaker model on
    // purpose: it is a more sensitive probe of tool descriptions.
    agent: 'claude-haiku-4-5',

    // Judge model - evaluates conversation quality
    judge: 'deepseek/deepseek-v4-flash',

    // Judge model when the judge runs on the Claude Agent SDK (--claude-judge).
    claudeJudge: 'claude-sonnet-5',
};

/**
 * Maximum number of conversation turns before the agent query stops
 * (mapped onto the Agent SDK's `maxTurns` option).
 */
export const MAX_CONVERSATION_TURNS = 10;

/**
 * Minimum aggregate pass rate the `pr` tier must clear, calibrated from 3 consecutive
 * `claude-haiku-4-5 --tier pr` runs (apify/ai-team#240) after a clean `claude-opus-5 --tier pr`
 * run. Not wired as `run_mcp_agent_evals.ts`'s `--pass-threshold` CLI default (that default
 * applies to every tier and every run; repointing it here would silently change behavior for
 * `full`-tier and non-CI runs) — read explicitly by whatever consumes it (apify/ai-team#261's CI
 * workflow). See README.md's "The `pr` tier" section for the 3 run URLs and rates.
 *
 * PROVISIONAL: calibrated in a sandbox whose TLS proxy dropped 9-14% of trials per run
 * ("Self-signed certificate detected" against api.anthropic.com, unrelated to case quality —
 * see the README and .shepherd/iter-1/claim.md). The 3 runs' raw pass rates (0.83, 0.82, 0.89)
 * are dominated by that drop noise, so this is instead the floor of the *completed-only* rate
 * (passed / (requested - dropped): 0.96, 0.93, 0.98) rounded down to 2 decimals. Confirm on the
 * first CI run (apify/ai-team#261) and re-pin once measured in an environment without this fault.
 */
export const PR_TIER_PASS_THRESHOLD = 0.93;

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
