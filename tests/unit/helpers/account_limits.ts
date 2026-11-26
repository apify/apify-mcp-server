import type { ApifyClient } from '../../../src/apify_client.js';

export type AccountLimits = NonNullable<Awaited<ReturnType<ReturnType<ApifyClient['user']>['limits']>>>;

export const CYCLE_END_AT = new Date('2026-12-01T00:00:00.000Z');

/** A `GET /v2/users/me/limits` response with `usedUsd` of the monthly usage limit spent. */
export function limitsResponse(usedUsd: number, limitUsd = 5): AccountLimits {
    return {
        monthlyUsageCycle: { startAt: new Date('2026-11-01T00:00:00.000Z'), endAt: CYCLE_END_AT },
        limits: {
            maxMonthlyUsageUsd: limitUsd,
            maxMonthlyActorComputeUnits: 25,
            maxMonthlyExternalDataTransferGbytes: 10,
            maxMonthlyProxySerps: 0,
            maxMonthlyResidentialProxyGbytes: 0,
            maxActorMemoryGbytes: 8,
            maxActorCount: 100,
            maxActorTaskCount: 1000,
            maxConcurrentActorJobs: 25,
            maxTeamAccountSeatCount: 0,
            dataRetentionDays: 7,
        },
        current: {
            monthlyUsageUsd: usedUsd,
            monthlyActorComputeUnits: 10,
            monthlyExternalDataTransferGbytes: 0,
            monthlyProxySerps: 0,
            monthlyResidentialProxyGbytes: 0,
            actorMemoryGbytes: 0,
            actorCount: 2,
            actorTaskCount: 0,
            activeActorJobCount: 0,
            teamAccountSeatCount: 0,
        },
    };
}
