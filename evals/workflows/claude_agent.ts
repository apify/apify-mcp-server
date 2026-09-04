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

import type { HookCallbackMatcher, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';

import { REPORT_PROBLEM_NUDGE } from '../../src/tools/dev/report_problem.js';
import { MAX_CONVERSATION_TURNS, MCP_SERVER_NAME, stripToolPrefix } from './config.js';
import type { AdaptedConversation } from './sdk_conversation_adapter.js';
import { adaptSdkConversation } from './sdk_conversation_adapter.js';

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
};

const STDIO_BIN_PATH = resolve(process.cwd(), 'dist/stdio.js');

/** Throw with the fix if the MCP server has not been built yet. */
export function assertStdioBinExists(): void {
    if (!existsSync(STDIO_BIN_PATH)) {
        throw new Error(`MCP server binary not found at ${STDIO_BIN_PATH}. Run "pnpm run build" first.`);
    }
}

/**
 * Force-fail the listed tools with the real server nudge, so evals for error-driven
 * behavior (e.g. report-problem) do not depend on the live server erroring on demand.
 *
 * A PreToolUse deny is the injection point that survives `bypassPermissions`, which
 * short-circuits the `canUseTool` callback. The agent receives it as a refusal rather
 * than an INTERNAL_ERROR tool result.
 */
export function denyToolsHook(failTools: string[]): HookCallbackMatcher[] {
    const failing = new Set(failTools);

    return [
        {
            hooks: [
                async (input) => {
                    if (input.hook_event_name !== 'PreToolUse') return { continue: true };
                    const toolName = stripToolPrefix(input.tool_name);
                    if (!failing.has(toolName)) return { continue: true };

                    return {
                        hookSpecificOutput: {
                            hookEventName: 'PreToolUse',
                            permissionDecision: 'deny',
                            permissionDecisionReason: `The ${toolName} tool failed with an internal error.\n\n${REPORT_PROBLEM_NUDGE}`,
                        },
                    };
                },
            ],
        },
    ];
}

/** Run one test case to completion and fold the whole SDK stream into the judge's shape. */
export async function runAgentConversation(options: AgentRunOptions): Promise<AdaptedConversation> {
    const { prompt, model, apifyToken, tools, failTools, maxTurns, toolTimeoutSeconds, mcpToolsOnly } = options;

    const serverArgs = [STDIO_BIN_PATH];
    if (tools && tools.length > 0) {
        serverArgs.push(`--tools=${tools.join(',')}`);
    }

    // Tears down the Claude Code + MCP-server subprocesses.
    const abortController = new AbortController();

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
                // The server under test must be in the prompt. Left deferred behind tool
                // search (the default once built-in tools are on), the agent never sees the
                // Apify tools and answers from memory or Bash instead - the eval would then
                // measure tool search, not our tool descriptions.
                alwaysLoad: true,
            },
        },
        // Headless: never prompt for tool permission. The SDK requires both flags.
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        // Isolation: ignore this repo's settings and .mcp.json; configure everything in code.
        settingSources: [],
        strictMcpConfig: true,
        maxTurns: maxTurns ?? MAX_CONVERSATION_TURNS,
        // Away from the repo: the built-in tools must not read or write this checkout.
        cwd: tmpdir(),
        abortController,
        ...(failTools && failTools.length > 0 ? { hooks: { PreToolUse: denyToolsHook(failTools) } } : {}),
    };

    try {
        const messages: SDKMessage[] = [];
        // Arrival times, so the tool spans have real durations. The SDK stream carries no
        // timestamps and the messages are only folded once the run is over.
        const receivedAt: number[] = [];
        for await (const message of query({ prompt, options: sdkOptions })) {
            messages.push(message);
            receivedAt.push(Date.now());
        }
        return adaptSdkConversation(prompt, messages, receivedAt);
    } finally {
        abortController.abort();
    }
}
