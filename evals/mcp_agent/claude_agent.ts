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
import type { AttemptedToolCall } from './selection_mode.js';
import { SELECTION_DENY_REASON, SELECTION_MAX_TURNS } from './selection_mode.js';

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
    /** `kind: "selection"` items: deny every tool call and record the attempts, nothing executes. */
    isSelectionMode?: boolean;
};

/** What `runAgentConversation` returns: the folded conversation plus every attempted tool call. */
export type AgentRunResult = AdaptedConversation & {
    /** Calls the deny-all hook recorded. Empty for a non-selection item, which installs no hook. */
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

/**
 * Build a `PreToolUse` hook from a decision callback: return a deny reason to refuse the
 * call, or `undefined` to let it through. The one hook shape both `denyToolsHook()` and the
 * selection-mode deny-all hook sit on.
 */
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
 * Force-fail the listed tools with the real server nudge, so evals for error-driven
 * behavior (e.g. report-problem) do not depend on the live server erroring on demand.
 *
 * A PreToolUse deny is the injection point that survives a denying `canUseTool`: the SDK
 * fires this hook first regardless of what `canUseTool` would decide. The agent receives it
 * as a refusal rather than an INTERNAL_ERROR tool result.
 */
export function denyToolsHook(failTools: string[]): HookCallbackMatcher[] {
    const failing = new Set(failTools);

    return preToolUseHook((toolName) => {
        const stripped = stripToolPrefix(toolName);
        if (!failing.has(stripped)) return undefined;
        return `The ${stripped} tool failed with an internal error.\n\n${REPORT_PROBLEM_NUDGE}`;
    });
}

/**
 * Selection mode's deny-all hook: refuses every call with `SELECTION_DENY_REASON` and
 * records `{ toolName, input }` for each attempt into `attemptedCalls`, so the measurement
 * (`resolveFirstToolMatch()` in `selection_mode.ts`) has the full attempt sequence to read,
 * `ToolSearch` captures included.
 */
function selectionDenyAllHook(attemptedCalls: AttemptedToolCall[]): HookCallbackMatcher[] {
    return preToolUseHook((toolName, toolInput) => {
        attemptedCalls.push({ toolName, input: toolInput });
        return SELECTION_DENY_REASON;
    });
}

/** Run one test case to completion and fold the whole SDK stream into the judge's shape. */
export async function runAgentConversation(options: AgentRunOptions): Promise<AgentRunResult> {
    const { prompt, model, apifyToken, tools, failTools, maxTurns, toolTimeoutSeconds, mcpToolsOnly, isSelectionMode } =
        options;

    const serverArgs = [STDIO_BIN_PATH];
    if (tools && tools.length > 0) {
        serverArgs.push(`--tools=${tools.join(',')}`);
    }

    // Tears down the Claude Code + MCP-server subprocesses.
    const abortController = new AbortController();

    const attemptedCalls: AttemptedToolCall[] = [];

    // Last few non-empty stderr lines, appended to a thrown error so a bare "process exited
    // with code 1" (e.g. a root-sandbox permission refusal) carries the CLI's own message.
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
                // The server under test must be in the prompt. Left deferred behind tool
                // search (the default once built-in tools are on), the agent never sees the
                // Apify tools and answers from memory or Bash instead - the eval would then
                // measure tool search, not our tool descriptions.
                alwaysLoad: true,
            },
        },
        // Headless: never prompt for tool permission. Root refuses bypassPermissions +
        // allowDangerouslySkipPermissions outright ("cannot be used with root/sudo
        // privileges"), so every call is allowed here instead; a selection item's deny-all
        // PreToolUse hook (below) still fires first and denies before this is ever reached.
        canUseTool: async (_toolName, input) => ({ behavior: 'allow', updatedInput: input }),
        // Isolation: ignore this repo's settings and .mcp.json; configure everything in code.
        settingSources: [],
        strictMcpConfig: true,
        maxTurns: isSelectionMode ? SELECTION_MAX_TURNS : (maxTurns ?? MAX_CONVERSATION_TURNS),
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
        ...(isSelectionMode
            ? { hooks: { PreToolUse: selectionDenyAllHook(attemptedCalls) } }
            : failTools && failTools.length > 0
              ? { hooks: { PreToolUse: denyToolsHook(failTools) } }
              : {}),
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
        return { ...adaptSdkConversation(prompt, messages, receivedAt), attemptedCalls };
    } catch (error) {
        if (stderrLines.length === 0) throw error;
        const message = error instanceof Error ? error.message : String(error);
        const suffix = stderrLines.map((line) => `  [claude-stderr] ${line}`).join('\n');
        throw new Error(`${message}\n${suffix}`, { cause: error });
    } finally {
        abortController.abort();
    }
}
