/**
 * The agent under test: Claude Code, driven headlessly through the Claude Agent SDK.
 *
 * Each run spawns its own Apify MCP server from `dist/stdio.js` (fresh state per test)
 * and drives it with Claude Code's own system prompt. The agent gets the server's tools and
 * no Claude Code built-ins (Bash, Read, WebFetch, ...): it reads Store listings, Actor output
 * and web pages that anyone can write, in a process that holds the CI secrets, so it must not
 * have a shell or file access. The SDK owns the MCP handshake and shuts the subprocess down
 * when the query ends.
 */

import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import type { HookCallbackMatcher, HookInput, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';

import { SEND_FEEDBACK_NUDGE } from '../../src/tools/dev/send_feedback.js';
import { isMcpToolName, MCP_SERVER_NAME, stripToolPrefix } from '../config.js';
import { LANGFUSE_ENV_VARS } from '../environment.js';
import type { AttemptedToolCall } from '../runner/tool_call_mode.js';
import { TOOL_CALL_DENY_REASON, TOOL_CALL_MAX_TURNS } from '../runner/tool_call_mode.js';
import type { AdaptedConversation } from './conversation_adapter.js';
import { adaptSdkConversation } from './conversation_adapter.js';

/**
 * Maximum number of conversation turns before the agent query stops
 * (mapped onto the Agent SDK's `maxTurns` option).
 */
export const MAX_CONVERSATION_TURNS = 10;

export type AgentRunOptions = {
    prompt: string;
    model: string;
    apifyToken: string;
    /** Tools to enable on the MCP server, e.g. ["actors", "docs"]. Server default when omitted. */
    tools?: string[];
    /** Tools the harness refuses via a PreToolUse deny with a failure message. See denyToolsHook(). */
    failTools?: string[];
    maxTurns?: number;
    toolTimeoutSeconds: number;
    /** No effect: the agent never gets Claude Code's built-in tools. Kept until the flag is removed. */
    mcpToolsOnly: boolean;
    /** `kind: "tool-call"` items: deny every tool call and record the attempts, nothing executes. */
    isToolCallMode?: boolean;
};

/** Folded conversation and attempted tool calls. */
export type AgentRunResult = AdaptedConversation & {
    /** Calls the deny-all hook recorded. Empty for a `kind: "agent"` item; only the tool-call hook records. */
    attemptedCalls: AttemptedToolCall[];
};

const STDIO_BIN_PATH = resolve(process.cwd(), 'dist/stdio.js');

/** Number of trailing non-empty stderr lines kept to append to a thrown error. */
const MAX_APPENDED_STDERR_LINES = 5;

/** Credentials only the eval runner uses (tracing and the judge). Neither subprocess gets them. */
const RUNNER_CREDENTIAL_ENV_KEYS: readonly string[] = [...LANGFUSE_ENV_VARS, 'OPENROUTER_API_KEY'];

/** Credentials the Claude Code CLI authenticates to the model with. The MCP server does not get them. */
const AGENT_CREDENTIAL_ENV_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];

/**
 * `process.env` without the named variables. This removes only the listed names; any other
 * variable, including a credential that is not listed above, still reaches the subprocess.
 */
function envWithout(keys: readonly string[]): Record<string, string> {
    return Object.fromEntries(
        Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined && !keys.includes(entry[0]),
        ),
    );
}

/** Throw with the fix if the MCP server has not been built yet. */
export function assertStdioBinExists(): void {
    if (!existsSync(STDIO_BIN_PATH)) {
        throw new Error(`MCP server binary not found at ${STDIO_BIN_PATH}. Run "pnpm run build" first.`);
    }
}

/** Creates a `PreToolUse` hook. A reason denies the call; `undefined` allows it. */
function preToolUseHook(decide: (toolName: string, toolInput: unknown) => string | undefined): HookCallbackMatcher[] {
    return [
        {
            hooks: [
                async (input: HookInput) => {
                    if (input.hook_event_name !== 'PreToolUse') return { continue: true };
                    const reason = decide(input.tool_name, input.tool_input);
                    if (reason === undefined) return { continue: true };

                    return {
                        hookSpecificOutput: {
                            hookEventName: 'PreToolUse',
                            permissionDecision: 'deny',
                            permissionDecisionReason: reason,
                        },
                    };
                },
            ],
        },
    ];
}

/**
 * Force-fails selected tools with the server's send-feedback nudge so error-path cases do
 * not depend on a live server failure.
 */
export function denyToolsHook(failTools: string[]): HookCallbackMatcher[] {
    const failing = new Set(failTools);

    return preToolUseHook((toolName) => {
        const stripped = stripToolPrefix(toolName);
        if (!failing.has(stripped)) return undefined;
        return `The ${stripped} tool failed with an internal error.\n\n${SEND_FEEDBACK_NUDGE}`;
    });
}

/** Denies and records every tool call in tool-call mode. The scorer skips `ToolSearch` later. */
function toolCallDenyAllHook(attemptedCalls: AttemptedToolCall[]): HookCallbackMatcher[] {
    return preToolUseHook((toolName, toolInput) => {
        attemptedCalls.push({ toolName, input: toolInput });
        return TOOL_CALL_DENY_REASON;
    });
}

/** Run one test case to completion and fold the whole SDK stream into the judge's shape. */
export async function runAgentConversation(options: AgentRunOptions): Promise<AgentRunResult> {
    const { prompt, model, apifyToken, tools, failTools, maxTurns, toolTimeoutSeconds, isToolCallMode } = options;

    const serverArgs = [STDIO_BIN_PATH];
    if (tools && tools.length > 0) {
        serverArgs.push(`--tools=${tools.join(',')}`);
    }

    // Tears down the Claude Code + MCP-server subprocesses.
    const abortController = new AbortController();

    const attemptedCalls: AttemptedToolCall[] = [];

    // Append recent stderr lines so opaque subprocess failures retain the CLI's message.
    const stderrLines: string[] = [];

    const sdkOptions: Options = {
        model,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        tools: [],
        env: envWithout([...RUNNER_CREDENTIAL_ENV_KEYS, 'APIFY_TOKEN']),
        mcpServers: {
            [MCP_SERVER_NAME]: {
                type: 'stdio',
                command: 'node',
                args: serverArgs,
                // The CLI merges its own env into the server's, so its credentials are blanked, not omitted.
                env: {
                    ...envWithout(RUNNER_CREDENTIAL_ENV_KEYS),
                    ...Object.fromEntries(AGENT_CREDENTIAL_ENV_KEYS.map((key) => [key, ''])),
                    APIFY_TOKEN: apifyToken,
                },
                timeout: toolTimeoutSeconds * 1000,
                // Keep the server's tools in the prompt instead of behind tool search, or the
                // eval measures tool search rather than our tool descriptions.
                alwaysLoad: true,
            },
        },
        // Answer every permission request so nothing prompts; `bypassPermissions` is not an option
        // because the CLI refuses it under root. Only the server's tools are allowed, in case the
        // CLI offers a built-in despite `tools: []`. A tool-call item's deny-all hook still fires before this.
        canUseTool: async (toolName, input) =>
            isMcpToolName(toolName)
                ? { behavior: 'allow', updatedInput: input }
                : { behavior: 'deny', message: `The ${toolName} tool is not available.` },
        // Isolation: ignore this repo's settings and .mcp.json; configure everything in code.
        settingSources: [],
        strictMcpConfig: true,
        maxTurns: isToolCallMode ? TOOL_CALL_MAX_TURNS : (maxTurns ?? MAX_CONVERSATION_TURNS),
        // Away from the repo, so the CLI does not pick up this checkout as its project.
        cwd: tmpdir(),
        abortController,
        stderr: (data: string) => {
            for (const line of data.split('\n')) {
                if (!line.trim()) continue;
                // eslint-disable-next-line no-console
                console.error(`[claude-stderr] ${line}`);
                stderrLines.push(line);
                if (stderrLines.length > MAX_APPENDED_STDERR_LINES) stderrLines.shift();
            }
        },
        ...(isToolCallMode
            ? { hooks: { PreToolUse: toolCallDenyAllHook(attemptedCalls) } }
            : failTools && failTools.length > 0
              ? { hooks: { PreToolUse: denyToolsHook(failTools) } }
              : {}),
    };

    const messages: SDKMessage[] = [];
    // Arrival times, so the tool spans have real durations. The SDK stream carries no
    // timestamps and the messages are only folded once the run is over.
    const receivedAt: number[] = [];
    try {
        for await (const message of query({ prompt, options: sdkOptions })) {
            // The CLI emits init before a slow server is up (`pending`); the first turn would then run without its tools.
            if (message.type === 'system' && message.subtype === 'init') {
                const status =
                    message.mcp_servers.find((server) => server.name === MCP_SERVER_NAME)?.status ?? 'missing';
                if (status !== 'connected') {
                    throw new Error(`MCP server "${MCP_SERVER_NAME}" not connected at init (status: ${status})`);
                }
            }
            messages.push(message);
            receivedAt.push(Date.now());
        }
        return { ...adaptSdkConversation(prompt, messages, receivedAt), attemptedCalls };
    } catch (error) {
        // On error_max_turns the CLI exits non-zero after streaming its result message, and
        // the SDK rethrows that exit as "Claude Code returned an error result". The run is
        // complete from the model's side, so fold what arrived: the adapter keeps a max-turns
        // result and still throws on any other error subtype.
        if (messages.some((message) => message.type === 'result')) {
            return { ...adaptSdkConversation(prompt, messages, receivedAt), attemptedCalls };
        }
        if (stderrLines.length === 0) throw error;
        const message = error instanceof Error ? error.message : String(error);
        const suffix = stderrLines.map((line) => `  [claude-stderr] ${line}`).join('\n');
        throw new Error(`${message}\n${suffix}`, { cause: error });
    } finally {
        abortController.abort();
    }
}
