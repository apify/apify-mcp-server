/**
 * Configuration for workflow evaluation system.
 *
 * The agent's system prompt and tools come from the SDK's `claude_code` presets, so
 * nothing here defines them. The judge runs on OpenRouter (temperature 0.15, see
 * llm_client.ts).
 */

// Re-export shared config for convenience
export { OPENROUTER_CONFIG, sanitizeProcessEnv } from '../shared/config.js';

/** Name the Claude Agent SDK registers the Apify MCP server under. */
export const MCP_SERVER_NAME = 'apify';

const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/** Strip the SDK's `mcp__<server>__` prefix; built-in tool names pass through unchanged. */
export function stripToolPrefix(name: string): string {
    return name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : name;
}

/** Whether an SDK tool name belongs to the Apify MCP server rather than a Claude Code built-in. */
export function isMcpToolName(name: string): boolean {
    return name.startsWith(MCP_TOOL_PREFIX);
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
};

/**
 * Maximum number of conversation turns before the agent query stops
 * (mapped onto the Agent SDK's `maxTurns` option).
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
 * Six fixed dimensions, so a failing run says which capability regressed instead of
 * returning one opaque verdict. `toolSelection` is overridden by a deterministic check
 * when the test case sets `expectedTools`; the judge still scores it, because most cases
 * leave that field unset on purpose.
 *
 * Variables:
 * - {{reference}}: The requirements the agent should meet
 * - {{conversation}}: The formatted conversation to evaluate, including tool results
 */
export const JUDGE_PROMPT_TEMPLATE = `You are evaluating how an AI agent used its tools to carry out a user's task.

Score each of these 6 dimensions independently. Do not let a strong result on one
dimension excuse a weak one on another: an agent that reaches the right answer down a
wasteful path fails planEfficiency and passes taskCompletion.

1. toolSelection: Did the agent call the appropriate tool(s) - no missing calls, no
   unnecessary ones? A different tool than the requirements name is fine if it
   accomplishes the same goal. [For some test cases this dimension is replaced by a
   deterministic check after your response; score it anyway.]
2. argumentCorrectness: Were the arguments semantically correct and complete for the task
   (right IDs, filters, limits, values)? Judge the meaning, not the schema: an argument
   the tool accepted can still be the wrong value.
3. resultUtilization: Did the agent read and use what each tool actually returned? FAIL if
   it ignored an error, misreported data, or claimed anything the results do not support.
4. taskCompletion: Did the final response fully satisfy the requirements below?
5. errorRecovery: When a call failed or returned something unexpected, did the agent
   respond sensibly - retry, use an alternative, or explain the blocker to the user -
   rather than stall or invent the answer? PASS when nothing failed.
6. planEfficiency: Was the path reasonably direct? Minor inefficiencies are acceptable;
   FAIL on repeated identical calls, abandoned detours, or turns spent going nowhere.

TASK REQUIREMENTS:
{{reference}}

AGENT CONVERSATION (tool results are truncated):
{{conversation}}

For every dimension give a verdict (PASS or FAIL) and a one-sentence reason.`;
