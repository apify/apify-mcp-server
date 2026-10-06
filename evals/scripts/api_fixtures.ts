#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Fixtures for the `merge/api/*` items in the `mcp-server-evals-merge` dataset (Apify API tool evals).
 *
 * Deletes what previous runs left behind: datasets and Actors named `eval-api-*`, and webhooks that
 * call an `https://example.com/eval-api/` URL or watch a fixture Actor, the fixture webhook among
 * them. Then it creates the permanent fixtures if they are missing and resets their mutable state,
 * since an eval agent may have changed them, and creates the fixture webhook afresh. Dataset names
 * are unique per account, so the fixed-name create cases collide with leftovers on the next run
 * without this.
 *
 * The fixtures:
 * - `eval-api-actor`, read-only: version 0.0 alone, with EVAL_REGION (plain) and EVAL_API_KEY
 *   (secret), and one webhook on its failed runs. The read cases assert on these, so no case may
 *   modify them.
 * - `eval-api-actor-scratch`, edited by the write cases: version 0.0 alone, with only EVAL_MODE (plain).
 * - `eval-api-shared`, a dataset the access case opens to anyone with the link; reset to RESTRICTED.
 *
 * The two Actors are separate because items run concurrently against one account: a case that edits
 * an Actor must not edit the one a read case asserts on. Neither is ever built or run, so the fixture
 * webhook never fires on its own and nothing here costs compute.
 *
 * Usage: pnpm run evals:mcp-agent:api-fixtures [--dry-run]
 */

import 'dotenv/config';

import type { ActorEnvironmentVariable, ActorVersion } from 'apify-client';
import { ActorSourceType, ApifyClient } from 'apify-client';

import { findMissingEnvVars, sanitizeProcessEnv } from '../environment.js';

sanitizeProcessEnv();

/** Only datasets and Actors with this prefix are ever deleted. */
const EVAL_API_PREFIX = 'eval-api-';

/** The only version of both fixture Actors. */
const FIXTURE_VERSION_NUMBER = '0.0';

type FixtureEnvVar = { name: string; value: string; isSecret: boolean };
type FixtureActor = { name: string; envVars: FixtureEnvVar[] };
type FixtureActorKey = 'readOnly' | 'scratch';

/** Never deleted. `readOnly` is what the read cases assert on; `scratch` is what the write cases edit. */
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
        // The secret case must leave this one alone, which is how a version-wide envVars replace shows up.
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

/** Opened to anyone with the link by the access case, reset to RESTRICTED every run. */
const FIXTURE_DATASET_NAME = 'eval-api-shared';

/** `--dry-run` prints what the run would change and writes nothing. */
const IS_DRY_RUN = process.argv.includes('--dry-run');
/** Marks every line of a dry run, so its output cannot be read as changes that happened. */
const DRY = IS_DRY_RUN ? '[dry run] ' : '';

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
 * Deletes leftover `eval-api-*` Actors, creates a missing fixture Actor, and resets the variables of
 * an existing one. Returns the fixture Actor IDs; one is missing only on a dry run that would create it.
 */
async function prepareFixtureActors(client: ApifyClient): Promise<Partial<Record<FixtureActorKey, string>>> {
    // Read every page before deleting anything: offset paging skips entries when the
    // collection shrinks underneath it, and a missed leftover fails the next run.
    const actors = [];
    for await (const actor of client.actors().list({ my: true })) actors.push(actor);

    const fixtureNames = Object.values(FIXTURE_ACTORS).map((fixture) => fixture.name);
    for (const actor of actors) {
        if (fixtureNames.includes(actor.name) || !actor.name.startsWith(EVAL_API_PREFIX)) continue;
        if (!IS_DRY_RUN) await client.actor(actor.id).delete();
        console.log(`🗑️  ${DRY}Deleted leftover Actor "${actor.name}" (${actor.id})`);
    }

    const ids: Partial<Record<FixtureActorKey, string>> = {};
    for (const [key, fixture] of Object.entries(FIXTURE_ACTORS) as [FixtureActorKey, FixtureActor][]) {
        const existing = actors.find((actor) => actor.name === fixture.name);
        if (existing) {
            await resetFixtureVersion(client, existing.id, fixture);
            ids[key] = existing.id;
        } else if (IS_DRY_RUN) {
            console.log(`🌱 ${DRY}Created fixture Actor "${fixture.name}"`);
        } else {
            const actor = await client.actors().create({
                name: fixture.name,
                title: `Eval fixture (${key === 'readOnly' ? 'read-only' : 'editable'})`,
                description: `Permanent fixture for Apify API tool MCP agent evals. Never built or run. Do not delete; ${
                    key === 'readOnly' ? 'do not modify' : 'reset every run'
                }.`,
                isPublic: false,
                versions: [buildFixtureVersion(fixture)],
            });
            console.log(`🌱 Created fixture Actor "${actor.name}" (${actor.id})`);
            ids[key] = actor.id;
        }
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
 * Leaves version 0.0 as the only version, with exactly the fixture's variables: an eval agent may have
 * added, removed, or changed a variable, deleted the version, or added another one. The read cases
 * assert that the Actor has one version.
 */
async function resetFixtureVersion(client: ApifyClient, actorId: string, fixture: FixtureActor): Promise<void> {
    const actorClient = client.actor(actorId);
    const { items: versions } = await actorClient.versions().list();
    const hasFixtureVersion = versions.some((version) => version.versionNumber === FIXTURE_VERSION_NUMBER);
    // Created before the others are deleted, so the Actor always keeps at least one version.
    if (!hasFixtureVersion) {
        if (!IS_DRY_RUN) await actorClient.versions().create(buildFixtureVersion(fixture));
        console.log(`♻️  ${DRY}Recreated version ${FIXTURE_VERSION_NUMBER} of fixture Actor "${fixture.name}"`);
    }
    for (const { versionNumber } of versions) {
        if (versionNumber === FIXTURE_VERSION_NUMBER) continue;
        if (!IS_DRY_RUN) await actorClient.version(versionNumber).delete();
        console.log(`🗑️  ${DRY}Deleted version ${versionNumber} of fixture Actor "${fixture.name}"`);
    }
    // A recreated version already has exactly the fixture's variables.
    if (!hasFixtureVersion) return;

    const versionClient = actorClient.version(FIXTURE_VERSION_NUMBER);
    const { items: current } = await versionClient.envVars().list();
    const keptNames = new Set(
        fixture.envVars
            .filter((wanted) => current.some((envVar) => matchesFixtureEnvVar(envVar, wanted)))
            .map((wanted) => wanted.name),
    );
    for (const envVar of current) {
        if (!envVar.name || keptNames.has(envVar.name)) continue;
        // Deleted and recreated rather than updated: the platform may refuse to turn a secret plain.
        if (!IS_DRY_RUN) await versionClient.envVar(envVar.name).delete();
        console.log(`🗑️  ${DRY}Deleted variable ${envVar.name} of fixture Actor "${fixture.name}"`);
    }
    for (const wanted of fixture.envVars) {
        if (keptNames.has(wanted.name)) continue;
        if (!IS_DRY_RUN) await versionClient.envVars().create(wanted);
        console.log(`🌱 ${DRY}Set variable ${wanted.name} of fixture Actor "${fixture.name}"`);
    }
    console.log(`♻️  ${DRY}Reset fixture Actor "${fixture.name}" (${actorId})`);
}

/**
 * Deletes every webhook the cases may have created or changed, the fixture webhook among them, and
 * creates the fixture webhook on the read-only Actor afresh. Recreating it, rather than updating it,
 * also undoes an edit to a field an update would leave alone (payloadTemplate, headersTemplate,
 * doNotRetry, ignoreSslErrors), which would change the test case's delivery. No case depends on its ID.
 */
async function prepareWebhooks(client: ApifyClient, readOnlyActorId: string | undefined, actorIds: string[]) {
    const webhooks = [];
    for await (const webhook of client.webhooks().list()) webhooks.push(webhook);

    for (const webhook of webhooks) {
        const actorId = webhook.condition && 'actorId' in webhook.condition ? webhook.condition.actorId : undefined;
        const isEvalWebhook =
            webhook.requestUrl.startsWith(EVAL_WEBHOOK_URL_PREFIX) ||
            (actorId !== undefined && actorIds.includes(actorId));
        if (!isEvalWebhook) continue;
        if (!IS_DRY_RUN) await client.webhook(webhook.id).delete();
        console.log(`🗑️  ${DRY}Deleted webhook ${webhook.id} (${webhook.requestUrl})`);
    }

    // The Actor ID is missing only on a dry run that would create the Actor.
    if (IS_DRY_RUN || !readOnlyActorId) {
        console.log(`🌱 ${DRY}Created fixture webhook ${FIXTURE_WEBHOOK_URL}`);
        return;
    }
    const webhook = await client.webhooks().create({
        eventTypes: ['ACTOR.RUN.FAILED'],
        condition: { actorId: readOnlyActorId },
        requestUrl: FIXTURE_WEBHOOK_URL,
        description: 'Permanent fixture for Apify API tool MCP agent evals, recreated before every run. Do not modify.',
    });
    console.log(`🌱 Created fixture webhook ${webhook.id}`);
}

/** Deletes leftover `eval-api-*` datasets and resets the fixture dataset's access. */
async function prepareDatasets(client: ApifyClient) {
    // Owned only: a dataset shared with the account under an eval-api- name is someone else's.
    const datasets = [];
    for await (const dataset of client.datasets().list({ ownership: 'ownedByMe' })) datasets.push(dataset);

    let fixtureId: string | undefined;
    for (const dataset of datasets) {
        if (dataset.name === FIXTURE_DATASET_NAME) {
            fixtureId = dataset.id;
            continue;
        }
        if (!dataset.name?.startsWith(EVAL_API_PREFIX)) continue;
        if (!IS_DRY_RUN) await client.dataset(dataset.id).delete();
        console.log(`🗑️  ${DRY}Deleted leftover dataset "${dataset.name}" (${dataset.id})`);
    }

    if (IS_DRY_RUN) {
        console.log(
            `${fixtureId ? '♻️  [dry run] Reset' : '🌱 [dry run] Created'} fixture dataset "${FIXTURE_DATASET_NAME}"`,
        );
        return;
    }
    const id = fixtureId ?? (await client.datasets().getOrCreate(FIXTURE_DATASET_NAME)).id;
    await client.dataset(id).update({ generalAccess: 'RESTRICTED' });
    console.log(`${fixtureId ? '♻️  Reset' : '🌱 Created'} fixture dataset "${FIXTURE_DATASET_NAME}" (${id})`);
}

async function main() {
    const missing = findMissingEnvVars(['APIFY_TOKEN']);
    if (missing.length > 0) {
        console.error(`❌ Error: missing environment variable(s): ${missing.join(', ')}`);
        process.exit(1);
    }
    const client = new ApifyClient({ token: process.env.APIFY_TOKEN });

    // The deletes below hit whatever account APIFY_TOKEN points at, so name it first.
    console.log(`👤 ${DRY}Account: ${(await client.user('me').get()).username ?? 'unknown'}`);

    // The Actors first: the webhook cleanup matches on their IDs.
    const actorIds = await prepareFixtureActors(client);
    await prepareWebhooks(
        client,
        actorIds.readOnly,
        Object.values(actorIds).filter((id) => id !== undefined),
    );
    await prepareDatasets(client);

    console.log(IS_DRY_RUN ? '✅ Dry run complete, nothing changed' : '✅ API fixtures ready');
}

void main();
