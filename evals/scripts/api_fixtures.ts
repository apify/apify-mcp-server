#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Fixtures for the `merge/api/*` items in the `mcp-server-evals-merge` dataset (Apify API tool evals).
 *
 * Seeds the permanent fixtures when they are missing, deletes what a run created, and sweeps what runs
 * left behind. It never resets or deletes a fixture: several runs share the eval account, and another
 * run may be reading it.
 *
 * The fixtures, which no case may modify:
 * - `eval-api-actor`: version 0.0 with EVAL_REGION (plain) and EVAL_API_KEY (secret), and one webhook
 *   on its failed runs. The read cases assert on these.
 * - `eval-api-actor-scratch`: version 0.0 with EVAL_MODE (plain). The write cases add their own
 *   variables and webhooks to it and remove them again.
 *
 * The two are separate so that a variable a write case adds never shows up in a read case's answer.
 * Neither is ever built or run, so the fixture webhook never fires on its own and nothing here costs
 * compute.
 *
 * Every name a case creates ends in `-<runId>-t<trial>`, which the runner writes in place of the item's
 * `{{uniq}}`: datasets, webhook URLs, and variables on the fixture Actors. `--run-id <id>` deletes that
 * run's names at any age. Anything else under the eval names survives until it is older than 6 hours,
 * so a run in flight never loses a resource it is using.
 *
 * Usage: pnpm run evals:mcp-agent:api-fixtures [--run-id <id>] [--dry-run]
 */

import 'dotenv/config';

import type { ActorEnvironmentVariable, ActorVersion } from 'apify-client';
import { ActorSourceType, ApifyClient } from 'apify-client';

import { findMissingEnvVars, sanitizeProcessEnv } from '../environment.js';

sanitizeProcessEnv();

// TODO(#1423): import isNameFromRun and parseRunIdArg from evals/run_id.ts, and LEFTOVER_MAX_AGE_MS
// from evals/scripts/schedules_sweep.ts, once it merges. Copied verbatim until then, so the names the
// runner builds match here exactly.

const RUN_ID_PATTERN = /^[a-z0-9-]+$/;

const RUN_ID_FLAG = '--run-id';

/**
 * Matched as a delimited token, because a bare `includes('35014680476-1')` also matches attempt
 * 12's `…-35014680476-12-t1`.
 */
function isNameFromRun(name: string, runId: string): boolean {
    return name.includes(`-${runId}-t`);
}

/** Throws when a `--run-id` would build a name the platform rejects. */
function validateRunId(value: string): void {
    if (!RUN_ID_PATTERN.test(value)) {
        throw new Error(`--run-id must be lowercase letters, digits and dashes, got "${value}"`);
    }
}

/**
 * A value starting with `--` is an error, not an id: `--run-id --dry-run` would otherwise swallow
 * the next flag, and `--dry-run` matches the id pattern.
 */
function parseRunIdArg(argv: string[]): string | undefined {
    const index = argv.findIndex((arg) => arg === RUN_ID_FLAG || arg.startsWith(`${RUN_ID_FLAG}=`));
    if (index === -1) return undefined;
    const arg = argv[index];
    const value = arg === RUN_ID_FLAG ? argv[index + 1] : arg.slice(`${RUN_ID_FLAG}=`.length);
    if (!value || value.startsWith('--')) throw new Error(`${RUN_ID_FLAG} needs a value`);
    validateRunId(value);
    return value;
}

/**
 * How old an unmatched leftover must be before the sweep deletes it. Four times the workflow's
 * 90-minute timeout, so a run in flight never loses a resource it is using.
 */
const LEFTOVER_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** A run's own name goes at any age; anything else only once it is older than the age limit. */
function isSweepable(name: string, createdAt: Date | string, runId: string | undefined, now: number): boolean {
    if (runId && isNameFromRun(name, runId)) return true;
    return now - new Date(createdAt).getTime() >= LEFTOVER_MAX_AGE_MS;
}

/** Only datasets with this prefix are ever deleted. None is a fixture. */
const EVAL_API_PREFIX = 'eval-api-';

/** The only version of both fixture Actors. */
const FIXTURE_VERSION_NUMBER = '0.0';

type FixtureEnvVar = { name: string; value: string; isSecret: boolean };
type FixtureActor = { name: string; envVars: FixtureEnvVar[] };
type FixtureActorKey = 'readOnly' | 'scratch';

/** Never deleted, never reset. */
const FIXTURE_ACTORS: Record<FixtureActorKey, FixtureActor> = {
    readOnly: {
        name: 'eval-api-actor',
        envVars: [
            { name: 'EVAL_REGION', value: 'eu-central-1', isSecret: false },
            { name: 'EVAL_API_KEY', value: 'eval-fixture-not-a-real-key', isSecret: true },
        ],
    },
    scratch: {
        name: 'eval-api-actor-scratch',
        // The secret case adds its own variable next to this one and must leave this one alone.
        envVars: [{ name: 'EVAL_MODE', value: 'scratch', isSecret: false }],
    },
};

/**
 * The webhooks the cases create call URLs under this prefix. example.com is reserved by IANA, so a
 * test delivery reaches no third party.
 */
const EVAL_WEBHOOK_URL_PREFIX = 'https://example.com/eval-api/';

/** Watches failed runs of the read-only Actor, which never runs. The list and test cases find it by this URL. */
const FIXTURE_WEBHOOK_URL = `${EVAL_WEBHOOK_URL_PREFIX}run-failed`;

/** `--dry-run` prints what the run would change and writes nothing. */
const IS_DRY_RUN = process.argv.includes('--dry-run');
/** Marks every line of a dry run, so its output cannot be read as changes that happened. */
const DRY = IS_DRY_RUN ? '[dry run] ' : '';

type FixtureActorIds = Partial<Record<FixtureActorKey, string>>;

/** A minimal Node.js Actor. Only the source has to be valid, since nothing builds it. */
function buildFixtureVersion(fixture: FixtureActor): ActorVersion {
    return {
        versionNumber: FIXTURE_VERSION_NUMBER,
        sourceType: ActorSourceType.SourceFiles,
        buildTag: 'latest',
        envVars: fixture.envVars,
        sourceFiles: [
            {
                name: '.actor/actor.json',
                format: 'TEXT',
                content: JSON.stringify({ actorSpecification: 1, name: fixture.name, version: FIXTURE_VERSION_NUMBER }),
            },
            {
                name: 'Dockerfile',
                format: 'TEXT',
                content: 'FROM apify/actor-node:22\nCOPY . ./\nCMD ["node", "main.js"]\n',
            },
            { name: 'main.js', format: 'TEXT', content: "console.log('Eval fixture, never meant to run.');\n" },
        ],
    };
}

/**
 * Creates a missing fixture Actor and prepares the version of an existing one. Returns the fixture
 * Actor IDs; one is missing only on a dry run that would create it.
 */
async function prepareFixtureActors(
    client: ApifyClient,
    runId: string | undefined,
    now: number,
): Promise<FixtureActorIds> {
    const actors = [];
    for await (const actor of client.actors().list({ my: true })) actors.push(actor);

    const ids: FixtureActorIds = {};
    for (const [key, fixture] of Object.entries(FIXTURE_ACTORS) as [FixtureActorKey, FixtureActor][]) {
        const existing = actors.find((actor) => actor.name === fixture.name);
        if (existing) {
            await prepareFixtureVersion(client, existing.id, fixture, runId, now);
            ids[key] = existing.id;
            continue;
        }
        if (IS_DRY_RUN) {
            console.log(`🌱 ${DRY}Created fixture Actor "${fixture.name}"`);
            continue;
        }
        const actor = await client.actors().create({
            name: fixture.name,
            title: `Eval fixture (${key === 'readOnly' ? 'read-only' : 'write target'})`,
            description:
                'Permanent fixture for Apify API tool MCP agent evals. Never built or run. Do not delete or modify.',
            isPublic: false,
            versions: [buildFixtureVersion(fixture)],
        });
        console.log(`🌱 Created fixture Actor "${actor.name}" (${actor.id})`);
        ids[key] = actor.id;
    }
    return ids;
}

/** A secret's value cannot be read back, so a variable that is still secret matches on its name alone. */
function matchesFixtureEnvVar(envVar: ActorEnvironmentVariable, wanted: FixtureEnvVar): boolean {
    return (
        envVar.name === wanted.name &&
        Boolean(envVar.isSecret) === wanted.isSecret &&
        (wanted.isSecret || envVar.value === wanted.value)
    );
}

/**
 * Creates a missing version 0.0 or fixture variable, and deletes the variables runs added. Something
 * that drifted from the fixture only gets a warning: changing it back would change what another run
 * is reading.
 */
async function prepareFixtureVersion(
    client: ApifyClient,
    actorId: string,
    fixture: FixtureActor,
    runId: string | undefined,
    now: number,
): Promise<void> {
    const actorClient = client.actor(actorId);
    const { items: versions } = await actorClient.versions().list();
    if (!versions.some((version) => version.versionNumber === FIXTURE_VERSION_NUMBER)) {
        if (!IS_DRY_RUN) await actorClient.versions().create(buildFixtureVersion(fixture));
        console.log(`🌱 ${DRY}Created version ${FIXTURE_VERSION_NUMBER} of fixture Actor "${fixture.name}"`);
        return;
    }
    const otherVersionNumbers = versions
        .map((version) => version.versionNumber)
        .filter((versionNumber) => versionNumber !== FIXTURE_VERSION_NUMBER);
    if (otherVersionNumbers.length > 0) {
        console.warn(
            `⚠️  Fixture Actor "${fixture.name}" also has version ${otherVersionNumbers.join(', ')}, ` +
                `and the read cases expect ${FIXTURE_VERSION_NUMBER} alone. Delete it by hand while no run is in flight.`,
        );
    }

    const versionClient = actorClient.version(FIXTURE_VERSION_NUMBER);
    const { items: envVars } = await versionClient.envVars().list();
    // A variable has no timestamp. Every variable write updates the Actor's modifiedAt, read here
    // after the list, so no listed variable is newer than it.
    const actor = await actorClient.get();
    if (!actor) return;

    for (const wanted of fixture.envVars) {
        const envVar = envVars.find((candidate) => candidate.name === wanted.name);
        if (envVar) {
            if (!matchesFixtureEnvVar(envVar, wanted)) {
                console.warn(
                    `⚠️  Variable ${wanted.name} of fixture Actor "${fixture.name}" differs from the fixture. ` +
                        'Fix it by hand while no run is in flight.',
                );
            }
            continue;
        }
        if (!IS_DRY_RUN) await versionClient.envVars().create(wanted);
        console.log(`🌱 ${DRY}Set variable ${wanted.name} of fixture Actor "${fixture.name}"`);
    }

    const fixtureNames = fixture.envVars.map((wanted) => wanted.name);
    for (const { name } of envVars) {
        if (!name || fixtureNames.includes(name) || !isSweepable(name, actor.modifiedAt, runId, now)) continue;
        if (!IS_DRY_RUN) await versionClient.envVar(name).delete();
        console.log(`🗑️  ${DRY}Deleted variable ${name} of fixture Actor "${fixture.name}"`);
    }
}

/**
 * Deletes the webhooks runs created, and creates the fixture webhook on the read-only Actor if it is
 * missing. A webhook has no name, so the run token is matched in its URL.
 */
async function prepareWebhooks(client: ApifyClient, actorIds: FixtureActorIds, runId: string | undefined, now: number) {
    // Read every page before deleting anything: offset paging skips entries when the
    // collection shrinks underneath it.
    const webhooks = [];
    for await (const webhook of client.webhooks().list()) webhooks.push(webhook);

    const fixtureActorIds = Object.values(actorIds);
    let fixtureWebhookCount = 0;
    for (const webhook of webhooks) {
        const actorId = webhook.condition && 'actorId' in webhook.condition ? webhook.condition.actorId : undefined;
        if (webhook.requestUrl === FIXTURE_WEBHOOK_URL && actorId === actorIds.readOnly) {
            fixtureWebhookCount += 1;
            continue;
        }
        // A webhook on a fixture Actor with another URL can only come from an agent that went wrong.
        const isEvalWebhook =
            webhook.requestUrl.startsWith(EVAL_WEBHOOK_URL_PREFIX) ||
            (actorId !== undefined && fixtureActorIds.includes(actorId));
        if (!isEvalWebhook || !isSweepable(webhook.requestUrl, webhook.createdAt, runId, now)) continue;
        if (!IS_DRY_RUN) await client.webhook(webhook.id).delete();
        console.log(`🗑️  ${DRY}Deleted webhook ${webhook.id} (${webhook.requestUrl})`);
    }

    if (fixtureWebhookCount > 1) {
        console.warn(
            `⚠️  ${fixtureWebhookCount} webhooks call ${FIXTURE_WEBHOOK_URL}, and the test case expects one. ` +
                'Delete the extra ones by hand while no run is in flight.',
        );
    }
    if (fixtureWebhookCount > 0) return;
    // The Actor ID is missing only on a dry run that would create the Actor.
    if (IS_DRY_RUN || !actorIds.readOnly) {
        console.log(`🌱 ${DRY}Created fixture webhook ${FIXTURE_WEBHOOK_URL}`);
        return;
    }
    const webhook = await client.webhooks().create({
        eventTypes: ['ACTOR.RUN.FAILED'],
        condition: { actorId: actorIds.readOnly },
        requestUrl: FIXTURE_WEBHOOK_URL,
        description: 'Permanent fixture for Apify API tool MCP agent evals. Do not delete or modify.',
    });
    console.log(`🌱 Created fixture webhook ${webhook.id}`);
}

/** Deletes the `eval-api-*` datasets runs created. */
async function sweepDatasets(client: ApifyClient, runId: string | undefined, now: number) {
    // Owned only: a dataset shared with the account under an eval-api- name is someone else's.
    const datasets = [];
    for await (const dataset of client.datasets().list({ ownership: 'ownedByMe' })) datasets.push(dataset);

    for (const dataset of datasets) {
        if (!dataset.name?.startsWith(EVAL_API_PREFIX)) continue;
        if (!isSweepable(dataset.name, dataset.createdAt, runId, now)) continue;
        if (!IS_DRY_RUN) await client.dataset(dataset.id).delete();
        console.log(`🗑️  ${DRY}Deleted dataset "${dataset.name}" (${dataset.id})`);
    }
}

async function main() {
    let runId: string | undefined;
    try {
        runId = parseRunIdArg(process.argv);
    } catch (error) {
        console.error(`❌ Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
    const missing = findMissingEnvVars(['APIFY_TOKEN']);
    if (missing.length > 0) {
        console.error(`❌ Error: missing environment variable(s): ${missing.join(', ')}`);
        process.exit(1);
    }
    const client = new ApifyClient({ token: process.env.APIFY_TOKEN });

    // The deletes below hit whatever account APIFY_TOKEN points at, so name it first.
    console.log(`👤 ${DRY}Account: ${(await client.user('me').get()).username ?? 'unknown'}`);
    if (runId) console.log(`🧹 ${DRY}Tearing down run "${runId}" plus leftovers older than 6h`);

    const now = Date.now();
    // The Actors first: the webhook sweep matches on their IDs.
    const actorIds = await prepareFixtureActors(client, runId, now);
    await prepareWebhooks(client, actorIds, runId, now);
    await sweepDatasets(client, runId, now);

    console.log(IS_DRY_RUN ? '✅ Dry run complete, nothing changed' : '✅ API fixtures ready');
}

void main();
