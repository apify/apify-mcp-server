/**
 * The agent under test: Claude Code, driven headlessly through the Claude Agent SDK.
 *
 * Each run spawns its own Apify MCP server from `dist/stdio.js` (fresh state per test)
 * and drives it with Claude Code's own system prompt and tool set, so the eval exercises
 * the server the way a real Claude Code user does. The SDK owns the MCP handshake and
 * shuts the subprocess down when the query ends.
 */

import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import type { HookCallbackMatcher, HookInput, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';

import { REPORT_PROBLEM_NUDGE } from '../../src/tools/dev/report_problem.js';
import { MAX_CONVERSATION_TURNS, MCP_SERVER_NAME, stripToolPrefix } from './config.js';
import type { AdaptedConversation } from './sdk_conversation_adapter.js';
import { adaptSdkConversation } from './sdk_conversation_adapter.js';
import type { AttemptedToolCall } from './tool_call_mode.js';
import { TOOL_CALL_DENY_REASON, TOOL_CALL_MAX_TURNS } from './tool_call_mode.js';

export type AgentRunOptions = {
    prompt: string;
    model: string;
    apifyToken: string;
    /** Tools to enable on the MCP server, e.g. ["actors", "docs"]. Server default when omitted. */
    tools?: string[];
    /** Tools the harness force-fails with a synthetic INTERNAL_ERROR. See denyToolsHook(). */
    failTools?: string[];
    maxTurns?: number;
    toolTimeoutSeconds: number;
    /** Restrict the agent to MCP tools only, dropping Claude Code's built-in toolset. */
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
 * Force-fails selected tools with the server's report-problem nudge so error-path cases do
 * not depend on a live server failure.
 */
export function denyToolsHook(failTools: string[]): HookCallbackMatcher[] {
    const failing = new Set(failTools);

    return preToolUseHook((toolName) => {
        const stripped = stripToolPrefix(toolName);
        if (!failing.has(stripped)) return undefined;
        return `The ${stripped} tool failed with an internal error.\n\n${REPORT_PROBLEM_NUDGE}`;
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
    const { prompt, model, apifyToken, tools, failTools, maxTurns, toolTimeoutSeconds, mcpToolsOnly, isToolCallMode } =
        options;

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
        tools: mcpToolsOnly ? [] : { type: 'preset', preset: 'claude_code' },
        mcpServers: {
            [MCP_SERVER_NAME]: {
                type: 'stdio',
                command: 'node',
                args: serverArgs,
                env: { ...process.env, APIFY_TOKEN: apifyToken },
                timeout: toolTimeoutSeconds * 1000,
                // Keep the server's tools in the prompt instead of behind tool search, or the
                // eval measures tool search rather than our tool descriptions.
                alwaysLoad: true,
            },
        },
        // Allow every call so nothing prompts; `bypassPermissions` is not an option because the
        // CLI refuses it under root. A tool-call item's deny-all hook still fires before this.
        canUseTool: async (_toolName, input) => ({ behavior: 'allow', updatedInput: input }),
        // Isolation: ignore this repo's settings and .mcp.json; configure everything in code.
        settingSources: [],
        strictMcpConfig: true,
        maxTurns: isToolCallMode ? TOOL_CALL_MAX_TURNS : (maxTurns ?? MAX_CONVERSATION_TURNS),
        // Away from the repo: the built-in tools must not read or write this checkout.
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
