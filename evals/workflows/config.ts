/**
 * Configuration for workflow evaluation system
 * Includes OpenRouter API config, model settings, and prompts
 */

/**
 * OpenRouter API configuration
 */
export const OPENROUTER_CONFIG = {
    baseURL: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY || '',
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
    judge: 'x-ai/grok-4.1-fast',
};

/**
 * System prompt for the agent
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
 * 
 * Variables:
 * - {{requirements}}: The requirements the agent should meet
 * - {{conversation}}: The formatted conversation to evaluate
 */
export const JUDGE_PROMPT_TEMPLATE = `You are evaluating whether an AI agent successfully completed a user's task using available tools.

TASK REQUIREMENTS:
{{requirements}}

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

Respond with EXACTLY this format:

VERDICT: [PASS or FAIL]
REASON: [Brief explanation in 1-2 sentences explaining why the agent passed or failed]

Do not include any other text before or after this format.`;

