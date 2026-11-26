import { afterEach, describe, expect, it, vi } from 'vitest';

import log from '@apify/log';

import type { ApifyClient } from '../../src/apify_client.js';
import { HELPER_TOOLS } from '../../src/const.js';
import * as telemetry from '../../src/telemetry.js';
import type { ToolEntry, UsageThresholdCrossing, UsageThresholdDecision } from '../../src/types.js';
import { TOOL_TYPE } from '../../src/types.js';
import {
    appendUsageNotice,
    buildUsageNoticeText,
    getReachedThreshold,
    getUsageNoticeOptions,
    startUsageCheck,
    type UsageNoticeOptions,
} from '../../src/utils/usage_notice.js';
import { type AccountLimits, CYCLE_END_AT, limitsResponse } from './helpers/account_limits.js';
import { makeActorTool, makeArgsRecorderTool } from './helpers/mcp_server.js';
import { mockApifyClient } from './helpers/tool_context.js';

function stubClient(limits: () => Promise<AccountLimits>): ApifyClient {
    return mockApifyClient({
        user: vi.fn(() => ({ limits, get: async () => ({ id: 'user-1', plan: { tier: 'FREE' } }) })),
    });
}

/** A fresh token per test: the usage and user caches are keyed by token. */
function uniqueToken(): string {
    return `token-${Math.random()}`;
}

function usageNoticeOptions(decision: UsageThresholdDecision | null): UsageNoticeOptions {
    return {
        onUsageThresholdCrossed: vi.fn(async () => decision),
        telemetryEnv: 'DEV',
        mcpClientName: 'claude-code',
    };
}

const SHOWN: UsageThresholdDecision = { variant: 'notice', planType: 'FREE', isNoticeShown: true };
const TOOL_RESULT = { content: [{ type: 'text', text: 'Run finished.' }], structuredContent: { runId: 'run-1' } };

/** Runs one Actor tool call's usage check against `usedUsd` of a $5 limit. */
async function runUsageCheck(params: {
    usedUsd: number;
    options: UsageNoticeOptions;
    limits?: () => Promise<AccountLimits>;
    result?: Record<string, unknown>;
    signal?: AbortSignal;
}) {
    const {
        usedUsd,
        options,
        limits = async () => limitsResponse(usedUsd),
        result = TOOL_RESULT,
        signal = new AbortController().signal,
    } = params;
    const check = startUsageCheck({
        options,
        tool: makeActorTool(),
        toolName: 'apify--instagram-scraper',
        apifyToken: uniqueToken(),
        apifyClient: stubClient(limits),
        mcpSessionId: 'session-1',
        signal,
    });
    return await appendUsageNotice(result, check);
}

describe('usage thresholds', () => {
    it.each([
        [3.99, null],
        [4, 0.8],
        [4.74, 0.8],
        [4.75, 0.95],
        [4.99, 0.95],
        // At the limit the API blocks the run and its error says why.
        [5, null],
    ])('$%s of $5 reaches %s', (usedUsd, expected) => {
        expect(getReachedThreshold({ usedUsd, limitUsd: 5 })).toBe(expected);
    });

    it('reaches no threshold without a limit', () => {
        expect(getReachedThreshold({ usedUsd: 3, limitUsd: 0 })).toBeNull();
    });
});

describe('usage notice copy', () => {
    const usage = { usedUsd: 4.1, limitUsd: 5, cycleEndAt: CYCLE_END_AT };

    it('offers the Free plan an upgrade', () => {
        const text = buildUsageNoticeText('FREE', 0.8, usage);
        expect(text).toContain('$4.10 of the $5.00 monthly usage included in the Free plan (82%)');
        expect(text).toContain('resets on 2026-12-01');
        expect(text).toContain('https://console.apify.com/billing/subscription');
    });

    it('points a paid plan to the limits page', () => {
        expect(buildUsageNoticeText('PAID', 0.8, usage)).toContain(
            'https://console.apify.com/billing/limits?openMonthlyUsageLimitsModal=1',
        );
    });

    it('points a high-touch account to its account manager', () => {
        expect(buildUsageNoticeText('HIGH_TOUCH', 0.8, usage)).toContain('account manager or organization admin');
    });

    it('says almost all at 95%', () => {
        expect(buildUsageNoticeText('PAID', 0.95, { ...usage, usedUsd: 4.8 })).toContain(
            'almost all of its $5.00 monthly usage limit ($4.80, 96%)',
        );
    });
});

describe('which tool calls check usage', () => {
    const base = {
        apifyToken: 'token',
        apifyClient: stubClient(async () => limitsResponse(1)),
        mcpSessionId: 's',
        signal: new AbortController().signal,
    };

    it.each([
        ['an Actor tool', makeActorTool()],
        ['call-actor', makeArgsRecorderTool(HELPER_TOOLS.ACTOR_CALL).tool],
    ])('checks %s', (_label, tool) => {
        expect(
            startUsageCheck({ ...base, tool, toolName: tool.name, options: usageNoticeOptions(SHOWN) }),
        ).not.toBeNull();
    });

    it.each([
        ['an internal tool that runs no Actor', makeArgsRecorderTool(HELPER_TOOLS.DATASET_GET_ITEMS).tool],
        ['send-server-actor-request', makeArgsRecorderTool(HELPER_TOOLS.ACTOR_SERVER_REQUEST).tool],
        ['an Actor server tool', { ...makeActorTool(), type: TOOL_TYPE.ACTOR_SERVER } as ToolEntry],
    ])('skips %s', (_label, tool) => {
        expect(startUsageCheck({ ...base, tool, toolName: tool.name, options: usageNoticeOptions(SHOWN) })).toBeNull();
    });

    it('skips a call without a token', () => {
        const tool = makeActorTool();
        const params = {
            ...base,
            tool,
            toolName: tool.name,
            apifyToken: undefined,
            options: usageNoticeOptions(SHOWN),
        };
        expect(startUsageCheck(params)).toBeNull();
    });
});

describe('when the server checks usage at all', () => {
    const handler = async () => null;

    it('checks when the host set a handler and telemetry is on', () => {
        const host = {
            options: { onUsageThresholdCrossed: handler },
            telemetryEnabled: true,
            telemetryEnv: 'DEV' as const,
        };
        expect(getUsageNoticeOptions(host, undefined)).toBeDefined();
    });

    it('does not check without a handler', () => {
        expect(
            getUsageNoticeOptions({ options: {}, telemetryEnabled: true, telemetryEnv: 'DEV' }, undefined),
        ).toBeUndefined();
    });

    it('does not check with telemetry off, so no crossing goes without its event', () => {
        const host = {
            options: { onUsageThresholdCrossed: handler },
            telemetryEnabled: false,
            telemetryEnv: 'DEV' as const,
        };
        expect(getUsageNoticeOptions(host, undefined)).toBeUndefined();
    });
});

describe('usage notice on a tool result', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('asks the host about the crossing, sends the event and appends the notice last', async () => {
        const trackSpy = vi.spyOn(telemetry, 'trackUsageThresholdCrossed').mockImplementation(() => {});
        const options = usageNoticeOptions(SHOWN);

        const result = await runUsageCheck({ usedUsd: 4.1, options });

        expect(options.onUsageThresholdCrossed).toHaveBeenCalledWith({
            userId: 'user-1',
            threshold: 0.8,
            usedUsd: 4.1,
            limitUsd: 5,
            cycleStartAt: new Date('2026-11-01T00:00:00.000Z'),
            cycleEndAt: CYCLE_END_AT,
            mcpSessionId: 'session-1',
            toolName: 'apify--instagram-scraper',
        } satisfies UsageThresholdCrossing);
        expect(trackSpy).toHaveBeenCalledWith(
            'user-1',
            'DEV',
            expect.objectContaining({ threshold: 0.8, variant: 'notice', notice_shown: true, plan_tier: 'FREE' }),
        );
        expect(result.structuredContent).toBe(TOOL_RESULT.structuredContent);
        expect(result.content).toEqual([
            ...TOOL_RESULT.content,
            {
                type: 'text',
                text: buildUsageNoticeText('FREE', 0.8, { usedUsd: 4.1, limitUsd: 5, cycleEndAt: CYCLE_END_AT }),
            },
        ]);
    });

    it('sends the event without the notice in the control arm', async () => {
        const trackSpy = vi.spyOn(telemetry, 'trackUsageThresholdCrossed').mockImplementation(() => {});

        const result = await runUsageCheck({
            usedUsd: 4.1,
            options: usageNoticeOptions({ ...SHOWN, isNoticeShown: false }),
        });

        expect(trackSpy).toHaveBeenCalledWith('user-1', 'DEV', expect.objectContaining({ notice_shown: false }));
        expect(result).toBe(TOOL_RESULT);
    });

    it('does nothing when the host already handled the crossing', async () => {
        const trackSpy = vi.spyOn(telemetry, 'trackUsageThresholdCrossed').mockImplementation(() => {});

        const result = await runUsageCheck({ usedUsd: 4.1, options: usageNoticeOptions(null) });

        expect(trackSpy).not.toHaveBeenCalled();
        expect(result).toBe(TOOL_RESULT);
    });

    it('does not ask the host for a cancelled call', async () => {
        const options = usageNoticeOptions(SHOWN);
        const controller = new AbortController();
        controller.abort();

        expect(await runUsageCheck({ usedUsd: 4.1, options, signal: controller.signal })).toBe(TOOL_RESULT);
        expect(options.onUsageThresholdCrossed).not.toHaveBeenCalled();
    });

    it('does not ask the host below 80%', async () => {
        const options = usageNoticeOptions(SHOWN);

        const result = await runUsageCheck({ usedUsd: 3, options });

        expect(options.onUsageThresholdCrossed).not.toHaveBeenCalled();
        expect(result).toBe(TOOL_RESULT);
    });

    it('does not ask the host for a result without text', async () => {
        // The SDK adds non-object structured content as text only when the result has no text item.
        const options = usageNoticeOptions(SHOWN);
        const result = { content: [], structuredContent: ['item-1'] };

        expect(await runUsageCheck({ usedUsd: 4.1, options, result })).toBe(result);
        expect(options.onUsageThresholdCrossed).not.toHaveBeenCalled();
    });

    it('returns the result unchanged when the usage cannot be read', async () => {
        vi.spyOn(log, 'softFail').mockImplementation(() => log);
        const options = usageNoticeOptions(SHOWN);
        const limits = async () => {
            throw new Error('API unavailable');
        };

        expect(await runUsageCheck({ usedUsd: 4.1, options, limits })).toBe(TOOL_RESULT);
        expect(options.onUsageThresholdCrossed).not.toHaveBeenCalled();
    });

    it('returns the result unchanged when the host fails', async () => {
        vi.spyOn(log, 'error').mockImplementation(() => log);
        const options: UsageNoticeOptions = {
            ...usageNoticeOptions(SHOWN),
            onUsageThresholdCrossed: async () => {
                throw new Error('Redis unavailable');
            },
        };

        expect(await runUsageCheck({ usedUsd: 4.1, options })).toBe(TOOL_RESULT);
    });

    it('returns the result without waiting for a slow usage reading', async () => {
        vi.useFakeTimers();
        try {
            const options = usageNoticeOptions(SHOWN);
            const limits = () => new Promise<AccountLimits>(() => {});

            const pending = runUsageCheck({ usedUsd: 4.1, options, limits });
            await vi.runAllTimersAsync();

            expect(await pending).toBe(TOOL_RESULT);
            expect(options.onUsageThresholdCrossed).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('reuses one usage reading per token', async () => {
        vi.spyOn(telemetry, 'trackUsageThresholdCrossed').mockImplementation(() => {});
        const limits = vi.fn(async () => limitsResponse(4.1));
        const apifyClient = stubClient(limits);
        const tool = makeActorTool();
        const params = {
            options: usageNoticeOptions(SHOWN),
            tool,
            toolName: tool.name,
            apifyClient,
            mcpSessionId: 's',
            signal: new AbortController().signal,
        };
        const apifyToken = uniqueToken();

        await appendUsageNotice(TOOL_RESULT, startUsageCheck({ ...params, apifyToken }));
        await appendUsageNotice(TOOL_RESULT, startUsageCheck({ ...params, apifyToken }));

        expect(limits).toHaveBeenCalledTimes(1);
    });
});
