/**
 * Configuration shared across the eval harness's responsibilities.
 *
 * The agent's system prompt and tools come from the SDK's `claude_code` presets, so
 * nothing here defines them. The judge runs on OpenRouter (temperature 0.15, see
 * judge/openrouter_client.ts) by default, or on the Claude Agent SDK with
 * `--claude-judge` (see judge/claude_client.ts).
 */

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
