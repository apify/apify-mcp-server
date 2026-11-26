import { createHash } from 'node:crypto';

import log from '@apify/log';

import type { ApifyClient } from '../apify_client.js';
import { HELPER_TOOLS } from '../const.js';
import type { McpClientContext } from '../mcp/client_context.js';
import { trackUsageThresholdCrossed } from '../telemetry.js';
import {
    type ActorsMcpServerOptions,
    type TelemetryEnv,
    TOOL_TYPE,
    type ToolEntry,
    type UsageNoticePlanType,
    type UsageThreshold,
    type UsageThresholdCrossing,
    type UsageThresholdDecision,
} from '../types.js';
import { getToolFullName } from './tools.js';
import { TTLLRUCache } from './ttl_lru.js';
import { getUserInfoCached } from './userid_cache.js';

// Warns the agent when the account nears its monthly usage limit, so it tells the user while they can still upgrade
// or raise the limit. The host decides through `onUsageThresholdCrossed`.

/** Where a Free plan user upgrades. */
const UPGRADE_URL = 'https://console.apify.com/billing/subscription';
/** Where a paid plan's owner raises the monthly usage limit. */
const LIMITS_URL = 'https://console.apify.com/billing/limits?openMonthlyUsageLimitsModal=1';

/** Highest first: a usage reading reports the highest threshold it reached. */
const USAGE_THRESHOLDS: readonly UsageThreshold[] = [0.95, 0.8];

/** Tool types whose every call runs an Actor. */
const ACTOR_RUNNING_TOOL_TYPES = new Set<string>([TOOL_TYPE.ACTOR, TOOL_TYPE.ACTOR_MCP]);

/** Internal tools that run an Actor. */
const ACTOR_RUNNING_INTERNAL_TOOLS = new Set<string>([
    HELPER_TOOLS.ACTOR_CALL,
    HELPER_TOOLS.ACTOR_CALL_WIDGET,
    HELPER_TOOLS.ACTOR_MCP_TOOL_CALL,
]);

/** How many tokens' usage readings are cached at once. */
const USAGE_CACHE_MAX_SIZE = 200;
/** How long one usage reading per token is reused. */
const USAGE_CACHE_TTL_SECS = 5 * 60;
/** How long a finished tool call waits for a usage reading still in flight; after that it returns without a notice. */
const USAGE_READING_TIMEOUT_MS = 2_000;
/**
 * How long a tool result waits for the host's decision. A host stuck on its claim store must not hold every Actor
 * call of an account over 80%; a decision that comes later still sends its event, without the notice.
 */
const HOST_DECISION_TIMEOUT_MS = 2_000;

/** What {@link awaitWithin} returns when the promise doesn't settle in time. */
const TIMED_OUT = Symbol('timed out');

type AccountUsage = Pick<UsageThresholdCrossing, 'usedUsd' | 'limitUsd' | 'cycleStartAt' | 'cycleEndAt'>;

type UsageReading = { usage: AccountUsage; userId: string; isOrganization: boolean };

export type UsageNoticeOptions = {
    onUsageThresholdCrossed: NonNullable<ActorsMcpServerOptions['onUsageThresholdCrossed']>;
    telemetryEnv: TelemetryEnv;
    mcpClientName: string;
};

/** A usage reading started alongside a tool call, with what {@link appendUsageNotice} needs to finish it. */
export type UsageCheck = UsageNoticeOptions & {
    reading: Promise<UsageReading | null>;
    toolName: string;
    mcpSessionId: string | undefined;
    signal: AbortSignal;
};

const usageCache = new TTLLRUCache<AccountUsage>(USAGE_CACHE_MAX_SIZE, USAGE_CACHE_TTL_SECS);

/**
 * The usage notice options for one request. Undefined when the host set no `onUsageThresholdCrossed`, or when
 * telemetry is off: every crossing the host decides must also send its event.
 */
export function getUsageNoticeOptions(
    host: { options: ActorsMcpServerOptions; telemetryEnabled: boolean; telemetryEnv: TelemetryEnv },
    clientContext: McpClientContext | undefined,
): UsageNoticeOptions | undefined {
    const { onUsageThresholdCrossed } = host.options;
    if (!onUsageThresholdCrossed || !host.telemetryEnabled) return undefined;
    return {
        onUsageThresholdCrossed,
        telemetryEnv: host.telemetryEnv,
        mcpClientName: clientContext?.clientInfo?.name ?? '',
    };
}

/** The account's monthly usage and limit, cached per token. Null when the API call fails; failures are not cached. */
async function getAccountUsageCached(token: string, apifyClient: ApifyClient): Promise<AccountUsage | null> {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const cached = usageCache.get(tokenHash);
    if (cached) return cached;

    try {
        const limits = await apifyClient.user('me').limits();
        if (!limits) return null;
        const usage: AccountUsage = {
            usedUsd: limits.current.monthlyUsageUsd,
            limitUsd: limits.limits.maxMonthlyUsageUsd,
            cycleStartAt: new Date(limits.monthlyUsageCycle.startAt),
            cycleEndAt: new Date(limits.monthlyUsageCycle.endAt),
        };
        usageCache.set(tokenHash, usage);
        return usage;
    } catch (error) {
        log.softFail('Failed to read account usage for the usage notice', {
            errMessage: error instanceof Error ? error.message : String(error),
        });
        return null;
    }
}

async function readUsage(token: string, apifyClient: ApifyClient): Promise<UsageReading | null> {
    // A token that can't read `users/me` (a scoped token) can't read the limits either, so it skips that call.
    const userInfo = await getUserInfoCached(token, apifyClient);
    if (!userInfo.userId) return null;
    const usage = await getAccountUsageCached(token, apifyClient);
    if (!usage) return null;
    return { usage, userId: userInfo.userId, isOrganization: userInfo.isOrganization };
}

/**
 * Starts reading the account's usage alongside a tool call that runs an Actor: `call-actor`, an Actor tool or an
 * Actor-MCP tool. Null when there are no options (the host set no `onUsageThresholdCrossed`), no token, or another
 * tool, Actor server tools and `send-server-actor-request` included.
 */
export function startUsageCheck(params: {
    options: UsageNoticeOptions | undefined;
    tool: ToolEntry;
    apifyToken: string | undefined;
    apifyClient: ApifyClient;
    mcpSessionId: string | undefined;
    signal: AbortSignal;
}): UsageCheck | null {
    const { options, tool, apifyToken, apifyClient, mcpSessionId, signal } = params;
    if (!options || !apifyToken) return null;
    if (!ACTOR_RUNNING_TOOL_TYPES.has(tool.type) && !ACTOR_RUNNING_INTERNAL_TOOLS.has(tool.name)) return null;
    return {
        ...options,
        reading: readUsage(apifyToken, apifyClient),
        toolName: getToolFullName(tool),
        mcpSessionId,
        signal,
    };
}

/**
 * The highest threshold the usage reached. Null below 80%, without a limit, and at 100% or more, where the API
 * blocks the run and its error says why.
 */
export function getReachedThreshold(usage: Pick<AccountUsage, 'usedUsd' | 'limitUsd'>): UsageThreshold | null {
    if (!(usage.limitUsd > 0)) return null;
    const ratio = usage.usedUsd / usage.limitUsd;
    if (ratio >= 1) return null;
    return USAGE_THRESHOLDS.find((threshold) => ratio >= threshold) ?? null;
}

function formatUsd(value: number): string {
    return `$${value.toFixed(2)}`;
}

/** The notice the agent gets, worded for the account's plan. */
export function buildUsageNoticeText(
    planType: UsageNoticePlanType,
    threshold: UsageThreshold,
    usage: Pick<AccountUsage, 'usedUsd' | 'limitUsd' | 'cycleEndAt'>,
): string {
    const used = formatUsd(usage.usedUsd);
    const limit = formatUsd(usage.limitUsd);
    // The epsilon absorbs float error: 4.35 / 5 * 100 is 86.99999999999999.
    const percent = Math.floor((usage.usedUsd / usage.limitUsd) * 100 + 1e-9);
    // The cycle ends on its last millisecond; the next one starts a millisecond later.
    const resetDate = new Date(usage.cycleEndAt.getTime() + 1).toISOString().slice(0, 10);
    const limitText =
        planType === 'FREE'
            ? `the ${limit} monthly usage included in the Free plan`
            : `its ${limit} monthly usage limit`;
    const usedText =
        threshold === 0.95
            ? `almost all of ${limitText} (${used}, ${percent}%)`
            : `${used} of ${limitText} (${percent}%)`;
    const opening =
        `**Apify account notice:** This account has used ${usedText}. ` +
        `At ${limit}, Apify blocks all Actor runs until the usage cycle resets on ${resetDate}.`;

    switch (planType) {
        case 'FREE':
            return (
                `${opening} Tell the user now, before starting more runs, so they can decide how to continue. ` +
                `The Free plan limit can't be raised. To keep working without interruption, the user can upgrade ` +
                `at ${UPGRADE_URL}.`
            );
        case 'PAID':
            return (
                `${opening} Tell the user now, before starting more runs. The account owner can raise the limit at ` +
                `${LIMITS_URL}. Don't change the limit without asking the user. If they can't change it, they should ` +
                `ask their organization admin.`
            );
        case 'HIGH_TOUCH':
            return (
                `${opening} Tell the user now, before starting more runs, and suggest they contact their Apify ` +
                `account manager or organization admin to raise the limit.`
            );
        default:
            throw new Error(`Unknown usage notice plan type: ${planType satisfies never}`);
    }
}

/** The promise's value, or {@link TIMED_OUT} when it doesn't settle within `timeoutMs`. */
async function awaitWithin<TValue>(promise: Promise<TValue>, timeoutMs: number): Promise<TValue | typeof TIMED_OUT> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

function logHostFailure(error: unknown): void {
    log.error('Failed to add the usage notice', {
        errMessage: error instanceof Error ? error.message : String(error),
    });
}

function trackDecision({
    check,
    reading,
    threshold,
    decision,
    isNoticeShown,
}: {
    check: UsageCheck;
    reading: UsageReading;
    threshold: UsageThreshold;
    decision: UsageThresholdDecision;
    isNoticeShown: boolean;
}): void {
    trackUsageThresholdCrossed(reading.userId, check.telemetryEnv, {
        threshold,
        variant: decision.variant,
        notice_shown: isNoticeShown,
        plan_tier: decision.planType,
        is_organization: reading.isOrganization,
        used_usd: reading.usage.usedUsd,
        limit_usd: reading.usage.limitUsd,
        tool_name: check.toolName,
        mcp_client_name: check.mcpClientName,
    });
}

/**
 * Finishes a usage check. When the usage reached a threshold, asks the host, sends the event on a decision, and
 * appends the notice as the last content item when the decision shows it. Any failure returns the result unchanged.
 */
export async function appendUsageNotice(
    result: Record<string, unknown>,
    check: UsageCheck | null,
): Promise<Record<string, unknown>> {
    if (!check) return result;
    const content = (result.content as { type?: unknown }[] | undefined) ?? [];
    // Without a text item, the SDK adds non-object structured content as text, and an added notice would stop that.
    if (!content.some((item) => item.type === 'text')) return result;

    try {
        const reading = await awaitWithin(check.reading, USAGE_READING_TIMEOUT_MS);
        if (!reading || reading === TIMED_OUT) return result;
        const { usage, userId } = reading;
        const threshold = getReachedThreshold(usage);
        // A cancelled call's result reaches no one, so it must not use up the crossing.
        if (!threshold || check.signal.aborted) return result;

        const pendingDecision = check.onUsageThresholdCrossed({
            userId,
            threshold,
            ...usage,
            mcpSessionId: check.mcpSessionId,
            toolName: check.toolName,
        });
        const decision = await awaitWithin(pendingDecision, HOST_DECISION_TIMEOUT_MS);
        if (decision === TIMED_OUT) {
            log.softFail('The host did not decide on the usage threshold crossing in time', {
                toolName: check.toolName,
                threshold,
                mcpSessionId: check.mcpSessionId,
            });
            // The host can still claim the crossing after this. Its event goes out then, without the notice: the
            // result has left.
            void pendingDecision.then((late) => {
                if (late) trackDecision({ check, reading, threshold, decision: late, isNoticeShown: false });
            }, logHostFailure);
            return result;
        }
        if (!decision) return result;

        const text = decision.isNoticeShown ? buildUsageNoticeText(decision.planType, threshold, usage) : null;
        trackDecision({ check, reading, threshold, decision, isNoticeShown: decision.isNoticeShown });
        if (!text) return result;
        return { ...result, content: [...content, { type: 'text', text }] };
    } catch (error) {
        logHostFailure(error);
        return result;
    }
}
