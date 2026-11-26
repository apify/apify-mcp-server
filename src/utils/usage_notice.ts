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
} from '../types.js';
import { TTLLRUCache } from './ttl_lru.js';
import { getUserInfoCached } from './userid_cache.js';

// Warns the agent when the account nears its monthly usage limit, so it tells the user while they can still upgrade
// or raise the limit (apify/apify-core#32338). The host decides through `onUsageThresholdCrossed`.

const UPGRADE_URL = 'https://console.apify.com/billing/subscription';
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

const USAGE_CACHE_MAX_SIZE = 200;
/** How long one usage reading per token is reused. */
const USAGE_CACHE_TTL_SECS = 5 * 60;
/** How long a finished tool call waits for a usage reading still in flight; after that it returns without a notice. */
const USAGE_READING_TIMEOUT_MS = 2_000;

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
    const [usage, userInfo] = await Promise.all([
        getAccountUsageCached(token, apifyClient),
        getUserInfoCached(token, apifyClient),
    ]);
    if (!usage || !userInfo.userId) return null;
    return { usage, userId: userInfo.userId, isOrganization: userInfo.isOrganization };
}

/**
 * Starts reading the account's usage alongside a tool call that runs an Actor: `call-actor`, an Actor tool or an
 * Actor-MCP tool, as apify/apify-core#32338 lists. Null when there are no options (the host set no
 * `onUsageThresholdCrossed`), no token, or another tool, Actor server tools and `send-server-actor-request` included.
 */
export function startUsageCheck(params: {
    options: UsageNoticeOptions | undefined;
    tool: ToolEntry;
    toolName: string;
    apifyToken: string | undefined;
    apifyClient: ApifyClient;
    mcpSessionId: string | undefined;
    signal: AbortSignal;
}): UsageCheck | null {
    const { options, tool, toolName, apifyToken, apifyClient, mcpSessionId, signal } = params;
    if (!options || !apifyToken) return null;
    if (!ACTOR_RUNNING_TOOL_TYPES.has(tool.type) && !ACTOR_RUNNING_INTERNAL_TOOLS.has(tool.name)) return null;
    return { ...options, reading: readUsage(apifyToken, apifyClient), toolName, mcpSessionId, signal };
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
    const percent = Math.floor((usage.usedUsd / usage.limitUsd) * 100);
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

/** The reading, or null when it is not ready within {@link USAGE_READING_TIMEOUT_MS}. */
async function awaitReading(reading: Promise<UsageReading | null>): Promise<UsageReading | null> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), USAGE_READING_TIMEOUT_MS);
    });
    try {
        return await Promise.race([reading, timeout]);
    } finally {
        clearTimeout(timer);
    }
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
        const reading = await awaitReading(check.reading);
        if (!reading) return result;
        const { usage, userId, isOrganization } = reading;
        const threshold = getReachedThreshold(usage);
        // A cancelled call's result reaches no one, so it must not use up the crossing.
        if (!threshold || check.signal.aborted) return result;

        const decision = await check.onUsageThresholdCrossed({
            userId,
            threshold,
            ...usage,
            mcpSessionId: check.mcpSessionId,
            toolName: check.toolName,
        });
        if (!decision) return result;

        const text = decision.isNoticeShown ? buildUsageNoticeText(decision.planType, threshold, usage) : null;
        trackUsageThresholdCrossed(userId, check.telemetryEnv, {
            threshold,
            variant: decision.variant,
            notice_shown: decision.isNoticeShown,
            plan_tier: decision.planType,
            is_organization: isOrganization,
            used_usd: usage.usedUsd,
            limit_usd: usage.limitUsd,
            tool_name: check.toolName,
            mcp_client_name: check.mcpClientName,
        });
        if (!text) return result;
        return { ...result, content: [...content, { type: 'text', text }] };
    } catch (error) {
        log.error('Failed to add the usage notice', {
            errMessage: error instanceof Error ? error.message : String(error),
        });
        return result;
    }
}
