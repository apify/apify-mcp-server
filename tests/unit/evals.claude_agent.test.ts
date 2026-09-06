import type * as ClaudeAgentSdk from '@anthropic-ai/claude-agent-sdk';
import type { Options, PreToolUseHookInput, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SELECTION_DENY_REASON, SELECTION_MAX_TURNS } from '../../evals/mcp_agent/selection_mode.js';
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
    it('denies a listed tool with the report-problem nudge', async () => {
        const [{ hooks }] = denyToolsHook(['call-actor']);
        const result = await hooks[0](preToolUseInput('mcp__apify__call-actor'), 'tool-1', {
            signal: new AbortController().signal,
        });
        expect(result).toEqual({
            hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: `The call-actor tool failed with an internal error.\n\n${REPORT_PROBLEM_NUDGE}`,
            },
        });
    });

    it('passes a non-listed tool through unchanged', async () => {
        const [{ hooks }] = denyToolsHook(['call-actor']);
        const result = await hooks[0](preToolUseInput('mcp__apify__search-actors'), 'tool-1', {
            signal: new AbortController().signal,
        });
        expect(result).toEqual({ continue: true });
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

    it('never sets bypassPermissions or allowDangerouslySkipPermissions', async () => {
        await runAgentConversation(baseOptions());
        expect(capturedOptions).toBeDefined();
        expect(capturedOptions).not.toHaveProperty('permissionMode', 'bypassPermissions');
        expect(capturedOptions).not.toHaveProperty('allowDangerouslySkipPermissions');
    });

    it('grants every tool call through canUseTool', async () => {
        await runAgentConversation(baseOptions());
        const result = await capturedOptions?.canUseTool?.('search-actors', { keywords: 'x' }, {
            signal: new AbortController().signal,
            requestId: 'r1',
        } as Parameters<NonNullable<Options['canUseTool']>>[2]);
        expect(result).toEqual({ behavior: 'allow', updatedInput: { keywords: 'x' } });
    });

    it('installs no hooks for a plain agent item', async () => {
        await runAgentConversation(baseOptions());
        expect(capturedOptions?.hooks).toBeUndefined();
    });

    it('installs denyToolsHook when failTools is set', async () => {
        await runAgentConversation(baseOptions({ failTools: ['call-actor'] }));
        expect(capturedOptions?.hooks?.PreToolUse).toBeDefined();
    });

    it('defaults maxTurns to the config constant for an agent item', async () => {
        await runAgentConversation(baseOptions());
        expect(capturedOptions?.maxTurns).toBe(10);
    });

    it('honors a per-item maxTurns override for an agent item', async () => {
        await runAgentConversation(baseOptions({ maxTurns: 4 }));
        expect(capturedOptions?.maxTurns).toBe(4);
    });

    it('fixes maxTurns at SELECTION_MAX_TURNS for a selection item, ignoring maxTurns', async () => {
        await runAgentConversation(baseOptions({ isSelectionMode: true, maxTurns: 9999 }));
        expect(capturedOptions?.maxTurns).toBe(SELECTION_MAX_TURNS);
        expect(capturedOptions?.maxTurns).not.toBe(9999);
    });

    it('installs a PreToolUse hook for a selection item that denies every call', async () => {
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
                yield resultMessage();
            })();
        });

        const result = await runAgentConversation(baseOptions({ isSelectionMode: true }));

        expect(hookResult).toEqual({
            hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: SELECTION_DENY_REASON,
            },
        });
        expect(result.attemptedCalls).toEqual([
            { toolName: 'mcp__apify__search-actors', input: { keywords: 'tiktok' } },
        ]);
    });

    it('records every attempted call across multiple denied attempts', async () => {
        mocks.query.mockImplementation(({ options }: { options: Options }) => {
            capturedOptions = options;
            return (async function* () {
                const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
                await hook?.(preToolUseInput('ToolSearch', { query: 'select:WebFetch' }), 'tool-1', {
                    signal: new AbortController().signal,
                });
                await hook?.(
                    preToolUseInput('mcp__apify__apify--web-fetch', { url: 'https://example.com' }),
                    'tool-2',
                    {
                        signal: new AbortController().signal,
                    },
                );
                yield resultMessage();
            })();
        });

        const result = await runAgentConversation(baseOptions({ isSelectionMode: true }));
        expect(result.attemptedCalls).toEqual([
            { toolName: 'ToolSearch', input: { query: 'select:WebFetch' } },
            { toolName: 'mcp__apify__apify--web-fetch', input: { url: 'https://example.com' } },
        ]);
    });

    it('returns an empty attemptedCalls array for a plain agent item', async () => {
        const result = await runAgentConversation(baseOptions());
        expect(result.attemptedCalls).toEqual([]);
    });

    it('forwards stderr lines to console.error with the [claude-stderr] prefix', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        mocks.query.mockImplementation(({ options }: { options: Options }) => {
            options.stderr?.('a permission refusal line\n');
            return fakeStream([resultMessage()]);
        });

        await runAgentConversation(baseOptions());

        expect(errorSpy).toHaveBeenCalledWith('[claude-stderr] a permission refusal line');
        errorSpy.mockRestore();
    });

    it('keeps only the last MAX_APPENDED_STDERR_LINES lines in the ring buffer', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        mocks.query.mockImplementation(({ options }: { options: Options }) => {
            // 8 lines, more than the 5-line cap: only the last 5 should survive the shift.
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

    it('appends the last stderr lines to the error thrown when the run fails', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        mocks.query.mockImplementation(({ options }: { options: Options }) => {
            options.stderr?.('--dangerously-skip-permissions cannot be used with root/sudo privileges\n');
            // eslint-disable-next-line require-yield
            return (async function* () {
                throw new Error('Claude Code process exited with code 1');
            })();
        });

        await expect(runAgentConversation(baseOptions())).rejects.toThrow(
            /Claude Code process exited with code 1[\s\S]*--dangerously-skip-permissions cannot be used with root\/sudo privileges/,
        );
        vi.restoreAllMocks();
    });
});
