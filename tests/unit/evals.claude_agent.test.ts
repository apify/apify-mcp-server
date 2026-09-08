import type * as ClaudeAgentSdk from '@anthropic-ai/claude-agent-sdk';
import type { Options, PreToolUseHookInput, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TOOL_CALL_DENY_REASON, TOOL_CALL_MAX_TURNS } from '../../evals/mcp_agent/tool_call_mode.js';
import { REPORT_PROBLEM_NUDGE } from '../../src/tools/dev/report_problem.js';

// The SDK spawns a real Claude Code subprocess; capture what runAgentConversation builds
// instead of ever calling it for real.
const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('@anthropic-ai/claude-agent-sdk', async () => {
    const actual = await vi.importActual<typeof ClaudeAgentSdk>('@anthropic-ai/claude-agent-sdk');
    return { ...actual, query: mocks.query };
});

// Imported after the mock so the module under test picks up the mocked `query`.
const { denyToolsHook, runAgentConversation } = await import('../../evals/mcp_agent/claude_agent.js');

/** A full PreToolUseHookInput, only the fields the hooks under test read vary by call. */
function preToolUseInput(toolName: string, toolInput: unknown = {}): PreToolUseHookInput {
    return {
        hook_event_name: 'PreToolUse',
        tool_name: toolName,
        tool_input: toolInput,
        tool_use_id: 'tool-1',
    } as PreToolUseHookInput;
}

function resultMessage(overrides: Record<string, unknown> = {}): SDKMessage {
    return {
        type: 'result',
        subtype: 'success',
        result: 'done',
        num_turns: 1,
        total_cost_usd: 0,
        duration_ms: 10,
        usage: { input_tokens: 1, output_tokens: 1 },
        ...overrides,
    } as unknown as SDKMessage;
}

/** A minimal SDK stream a mocked `query()` can yield to let the adapter succeed. */
async function* fakeStream(messages: SDKMessage[]): AsyncGenerator<SDKMessage> {
    for (const message of messages) yield message;
}

function baseOptions(overrides: Partial<Parameters<typeof runAgentConversation>[0]> = {}) {
    return {
        prompt: 'hello',
        model: 'agent-model',
        apifyToken: 'token',
        toolTimeoutSeconds: 5,
        mcpToolsOnly: false,
        ...overrides,
    };
}

describe('denyToolsHook()', () => {
    it('denies only listed tools with the report-problem nudge', async () => {
        const [{ hooks }] = denyToolsHook(['call-actor']);
        const context = {
            signal: new AbortController().signal,
        };
        await expect(hooks[0](preToolUseInput('mcp__apify__call-actor'), 'tool-1', context)).resolves.toEqual({
            hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: `The call-actor tool failed with an internal error.\n\n${REPORT_PROBLEM_NUDGE}`,
            },
        });
        await expect(hooks[0](preToolUseInput('mcp__apify__search-actors'), 'tool-2', context)).resolves.toEqual({
            continue: true,
        });
    });
});

describe('runAgentConversation()', () => {
    let capturedOptions: Options | undefined;

    beforeEach(() => {
        mocks.query.mockReset();
        mocks.query.mockImplementation(({ options }: { options: Options }) => {
            capturedOptions = options;
            return fakeStream([resultMessage()]);
        });
    });

    it('uses canUseTool instead of root-incompatible permission flags', async () => {
        const run = await runAgentConversation(baseOptions());
        expect(capturedOptions).toBeDefined();
        expect(capturedOptions).not.toHaveProperty('permissionMode', 'bypassPermissions');
        expect(capturedOptions).not.toHaveProperty('allowDangerouslySkipPermissions');
        const result = await capturedOptions?.canUseTool?.('search-actors', { keywords: 'x' }, {
            signal: new AbortController().signal,
            requestId: 'r1',
        } as Parameters<NonNullable<Options['canUseTool']>>[2]);
        expect(result).toEqual({ behavior: 'allow', updatedInput: { keywords: 'x' } });
        expect(run.attemptedCalls).toEqual([]);
    });

    it('denies and records tool-call attempts with the fixed turn limit', async () => {
        let hookResult: unknown;
        mocks.query.mockImplementation(({ options }: { options: Options }) => {
            capturedOptions = options;
            return (async function* () {
                const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
                hookResult = await hook?.(
                    preToolUseInput('mcp__apify__search-actors', { keywords: 'tiktok' }),
                    'tool-1',
                    {
                        signal: new AbortController().signal,
                    },
                );
                await hook?.(preToolUseInput('ToolSearch', { query: 'select:WebFetch' }), 'tool-2', {
                    signal: new AbortController().signal,
                });
                yield resultMessage();
            })();
        });

        const result = await runAgentConversation(baseOptions({ isToolCallMode: true, maxTurns: 9999 }));

        expect(capturedOptions?.maxTurns).toBe(TOOL_CALL_MAX_TURNS);
        expect(hookResult).toEqual({
            hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: TOOL_CALL_DENY_REASON,
            },
        });
        expect(result.attemptedCalls).toEqual([
            { toolName: 'mcp__apify__search-actors', input: { keywords: 'tiktok' } },
            { toolName: 'ToolSearch', input: { query: 'select:WebFetch' } },
        ]);
    });

    it('keeps the recorded attempts when the SDK throws after a max-turns result', async () => {
        // The CLI exits non-zero on error_max_turns, and the SDK rewraps that exit as a thrown
        // error after it has already streamed the result message. The attempts the hook
        // recorded up to then are the tool-call score; they must not be lost with the throw.
        mocks.query.mockImplementation(({ options }: { options: Options }) => {
            return (async function* () {
                const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
                await hook?.(preToolUseInput('mcp__apify__publish-actor-task', { taskId: 'insta-daily' }), 'tool-1', {
                    signal: new AbortController().signal,
                });
                yield resultMessage({ subtype: 'error_max_turns', result: undefined, errors: [], num_turns: 2 });
                throw new Error('Claude Code returned an error result: Reached maximum number of turns (2)');
            })();
        });

        const result = await runAgentConversation(baseOptions({ isToolCallMode: true }));

        expect(result.hitMaxTurns).toBe(true);
        expect(result.attemptedCalls).toEqual([
            { toolName: 'mcp__apify__publish-actor-task', input: { taskId: 'insta-daily' } },
        ]);
    });

    it('forwards stderr and appends only its last five lines to a thrown error', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        mocks.query.mockImplementation(({ options }: { options: Options }) => {
            for (let i = 1; i <= 8; i++) options.stderr?.(`line ${i}\n`);
            // eslint-disable-next-line require-yield
            return (async function* () {
                throw new Error('Claude Code process exited with code 1');
            })();
        });

        let caught: unknown;
        try {
            await runAgentConversation(baseOptions());
        } catch (error) {
            caught = error;
        }

        const message = caught instanceof Error ? caught.message : String(caught);
        expect(errorSpy).toHaveBeenCalledWith('[claude-stderr] line 1');
        expect(message).toMatch(/line 4[\s\S]*line 5[\s\S]*line 6[\s\S]*line 7[\s\S]*line 8/);
        expect(message).not.toContain('line 1');
        expect(message).not.toContain('line 2');
        expect(message).not.toContain('line 3');
        vi.restoreAllMocks();
    });

    it('rethrows the original error unwrapped when the run fails with no stderr captured', async () => {
        const originalError = new Error('Claude Code process exited with code 1');
        mocks.query.mockImplementation(() => {
            // eslint-disable-next-line require-yield
            return (async function* () {
                throw originalError;
            })();
        });

        await expect(runAgentConversation(baseOptions())).rejects.toBe(originalError);
    });
});
