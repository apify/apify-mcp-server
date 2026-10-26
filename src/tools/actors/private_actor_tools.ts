import Ajv from 'ajv';
import type { Actor, Build } from 'apify-client';
import dedent from 'dedent';
import { z } from 'zod';

import type { ApifyClient } from '../../apify_client.js';
import { HELPER_TOOLS } from '../../const.js';
import { UserInputError } from '../../errors.js';
import type { HelperTool, InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { fixZodSchemaRequired } from '../../utils/ajv.js';
import { getConsoleLinkContext } from '../../utils/console_link.js';
import { respondAborted, respondOk, respondUserError, type ToolResponse } from '../../utils/mcp.js';
import { buildActor } from '../builds/build_actor.js';
import { getActorBuild } from '../builds/get_actor_build.js';
import { getActorBuildList } from '../builds/get_actor_build_list.js';
import { getActorBuildLog } from '../builds/get_actor_build_log.js';
import { buildGetActorRunResponse } from '../runs/get_actor_run.js';
import { actorRunOutputSchema, anyJsonObjectSchema } from '../structured_output_schemas.js';
import { createActor } from '../versions/create_actor.js';
import { createActorVersion } from '../versions/create_actor_version.js';
import { getActorVersion } from '../versions/get_actor_version.js';
import { fetchActor } from '../versions/source_helpers.js';
import { updateActorVersion } from '../versions/update_actor_version.js';
import { abortRunOnSignal, buildStartRunResponse, fetchActorRunData, type RunResponse } from './actor_run_response.js';

// Reject excluded fields before the shared handlers can strip them. These schemas are trusted,
// generated from our Zod schemas, and do not contain third-party regular expressions.
const PRIVATE_TOOLS_AJV = new Ajv({ strict: false });

export const PRIVATE_ACTOR_RUN_LIMITS = Object.freeze({
    timeoutSecs: { default: 60, max: 300 },
    memoryMbytes: { default: 1024, max: 4096 },
    maxTotalChargeUsd: { default: 1, max: 5 },
    waitSecs: { default: 30, max: 45 },
} as const);

/** A local authorization failure must not be treated as an ambiguous network write by source handlers. */
class PrivateActorAccessError extends UserInputError {
    readonly statusCode = 403;
}

const PRIVATE_BUILD_LOG_MAX_CHARACTERS = 64 * 1024;

/** Logging happens before schema validation; never pass through unknown keys or nested values. */
function redactPrivateArgs(args: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
    return Object.fromEntries(
        fields
            .filter((key) => key in args)
            .map((key) => [key, ['string', 'number', 'boolean'].includes(typeof args[key]) ? args[key] : '[REDACTED]']),
    );
}

/** Bind inherited client methods to their original resource, including its private state. */
function overrideClient<T extends object>(client: T, overrides: Partial<T>): T {
    return new Proxy(client, {
        get(target, key) {
            const value = Reflect.get(Object.hasOwn(overrides, key) ? overrides : target, key);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}

function validatePrivateActor(actor: Actor | undefined, userId: string, actorId?: string): asserts actor is Actor {
    if (!actor || !actor.id || !actor.name || !actor.username || (actorId !== undefined && actor.id !== actorId)) {
        throw new PrivateActorAccessError('The requested Actor could not be identified.');
    }
    if (actor.userId !== userId || actor.isPublic !== false) {
        throw new PrivateActorAccessError('This tool accepts only private Actors owned by the authenticated account.');
    }
}

async function fetchAccountId({ apifyClient, apifyToken, paymentProvider }: InternalToolArgs): Promise<string> {
    if (!apifyToken || paymentProvider) {
        throw new UserInputError('Private Actor development requires an authenticated Apify account.');
    }
    // Authorization uses a fresh read; the telemetry user cache is not an ownership boundary.
    const user = await apifyClient.user('me').get();
    if (!user?.id) throw new UserInputError('The authenticated account could not be confirmed.');
    return user.id;
}

async function fetchPrivateActor(client: ApifyClient, actorSelector: string, userId: string): Promise<Actor> {
    const { actor } = await fetchActor(client, actorSelector);
    validatePrivateActor(actor, userId);
    return actor;
}

async function fetchPrivateBuild(client: ApifyClient, buildId: string, userId: string): Promise<Build> {
    const build = await client.build(buildId).get();
    if (!build || build.id !== buildId || !build.actId) throw new UserInputError('The requested build was not found.');
    const actor = await client.actor(build.actId).get();
    validatePrivateActor(actor, userId, build.actId);
    return build;
}

/**
 * Shared source/build handlers retain their hashes, revision checks and response shapes. Every
 * source write and build start rechecks the pinned Actor ID immediately before the API call.
 * The API has no conditional ownership/private-state write, so a concurrent platform change after
 * that check remains possible; these checks are not an atomic transaction.
 */
function createPrivateClient(client: ApifyClient, userId: string, signal: AbortSignal, actorId?: string): ApifyClient {
    const checkCancellation = () => {
        if (signal.aborted) throw new PrivateActorAccessError('The request was cancelled before the write.');
    };
    const checkActor = async () => {
        if (!actorId) throw new UserInputError('No private Actor was selected.');
        const actor = await client.actor(actorId).get();
        validatePrivateActor(actor, userId, actorId);
        return actor;
    };
    return overrideClient(client, {
        actors: () => {
            const collection = client.actors();
            return overrideClient(collection, {
                create: async (options) => {
                    checkCancellation();
                    const created = await collection.create({
                        ...options,
                        isPublic: false,
                        actorPermissionLevel: 'LIMITED_PERMISSIONS',
                    });
                    validatePrivateActor(created, userId);
                    return created;
                },
            });
        },
        actor: (selectedId) => {
            if (selectedId !== actorId) throw new UserInputError('The Actor identity changed during this request.');
            const resource = client.actor(selectedId);
            return overrideClient(resource, {
                get: checkActor,
                version: (versionNumber) => {
                    const version = resource.version(versionNumber);
                    return overrideClient(version, {
                        update: async (options) => {
                            await checkActor();
                            checkCancellation();
                            return await version.update(options);
                        },
                    });
                },
                versions: () => {
                    const versions = resource.versions();
                    return overrideClient(versions, {
                        create: async (options) => {
                            await checkActor();
                            checkCancellation();
                            return await versions.create(options);
                        },
                    });
                },
                build: async (versionNumber, options) => {
                    await checkActor();
                    checkCancellation();
                    const build = await resource.build(versionNumber, options);
                    if (build.actId !== actorId)
                        throw new UserInputError('The returned build belongs to another Actor.');
                    return build;
                },
            });
        },
        build: (buildId) => {
            const resource = client.build(buildId);
            const checkBuild = async (options?: Parameters<typeof resource.get>[0]) => {
                const build = await resource.get(options);
                if (!build || build.id !== buildId || build.actId !== actorId) {
                    throw new UserInputError('The requested build does not belong to the selected private Actor.');
                }
                await checkActor();
                return build;
            };
            return overrideClient(resource, {
                get: checkBuild,
                log: () => {
                    const log = resource.log();
                    return overrideClient(log, {
                        get: async () => {
                            await checkBuild();
                            const text = await log.get();
                            // The upstream log endpoint returns the full log. Bound the tool's returned text,
                            // including a single exceptionally long line (at most 256 KiB in UTF-8).
                            return text?.slice(-PRIVATE_BUILD_LOG_MAX_CHARACTERS);
                        },
                    });
                },
            });
        },
    });
}

function getHelper(tool: ToolEntry): HelperTool {
    if (tool.type !== TOOL_TYPE.INTERNAL) throw new Error('Private aliases require an internal tool.');
    return tool;
}

/** Keep the existing Zod-generated field schemas, excluding operations this tool does not offer. */
function buildPrivateInputSchema(
    base: ToolEntry,
    fields: readonly string[],
    required: readonly string[] = [],
): ToolInputSchema {
    const schema = fixZodSchemaRequired(structuredClone(base.inputSchema)) as ToolInputSchema;
    schema.properties = Object.fromEntries(
        Object.entries(schema.properties ?? {}).filter(([name]) => fields.includes(name)),
    );
    schema.required = [...new Set([...(schema.required ?? []).filter((name) => fields.includes(name)), ...required])];
    schema.additionalProperties = false;
    if (base.name === HELPER_TOOLS.ACTOR_BUILD_LOG && schema.properties?.lines) {
        schema.properties.lines = {
            ...schema.properties.lines,
            minimum: 1,
            description: 'Last 1 to 50 log lines. Default: 10.',
        };
    }
    return schema;
}

type PrivateAliasOptions = {
    base: ToolEntry;
    name: string;
    title: string;
    description: string;
    fields: readonly string[];
    required?: readonly string[];
    target: 'create' | 'actor' | 'actorId' | 'buildId';
};

function createPrivateAlias({
    base,
    name,
    title,
    description,
    fields,
    required,
    target,
}: PrivateAliasOptions): HelperTool {
    const source = getHelper(base);
    const inputSchema = buildPrivateInputSchema(base, fields, required);
    const ajvValidate = PRIVATE_TOOLS_AJV.compile(inputSchema);
    return Object.freeze({
        ...source,
        name,
        title,
        description,
        buildDescription: undefined,
        inputSchema,
        ajvValidate,
        annotations: {
            ...source.annotations,
            title,
            openWorldHint: base.name === HELPER_TOOLS.ACTOR_BUILD,
            ...(base.name === HELPER_TOOLS.ACTOR_VERSION_CREATE && { destructiveHint: false }),
        },
        redactArgs: (args: Record<string, unknown>) =>
            source.redactArgs
                ? source.redactArgs(
                      Object.fromEntries(fields.filter((field) => field in args).map((field) => [field, args[field]])),
                  )
                : redactPrivateArgs(args, fields),
        call: async (toolArgs: InternalToolArgs) => {
            if (!ajvValidate(toolArgs.args))
                return respondUserError('The arguments do not match this private Actor tool schema.');
            if (toolArgs.signal.aborted) return respondAborted();
            try {
                const userId = await fetchAccountId(toolArgs);
                let actorId: string | undefined;
                const args = { ...toolArgs.args };
                if (target === 'buildId') {
                    actorId = (await fetchPrivateBuild(toolArgs.apifyClient, args.buildId as string, userId)).actId;
                } else if (target !== 'create') {
                    actorId = (await fetchPrivateActor(toolArgs.apifyClient, args[target] as string, userId)).id;
                    args[target] = actorId;
                }
                if (toolArgs.signal.aborted) return respondAborted();
                const response = await source.call({
                    ...toolArgs,
                    args,
                    apifyClient: createPrivateClient(toolArgs.apifyClient, userId, toolArgs.signal, actorId),
                });
                if (toolArgs.signal.aborted) return respondAborted();
                if (target === 'actorId' && !response.isError) {
                    const items = (response.structuredContent as { items?: { actorId?: string }[] } | undefined)?.items;
                    if (!items || items.some((item) => item.actorId !== actorId)) {
                        return respondUserError('The build list contains a build from another Actor.');
                    }
                }
                return response;
            } catch (error) {
                if (toolArgs.signal.aborted) return respondAborted();
                if (error instanceof UserInputError) return respondUserError(error.message);
                throw error;
            }
        },
    });
}

export const createPrivateActor = createPrivateAlias({
    base: createActor,
    name: HELPER_TOOLS.PRIVATE_ACTOR_CREATE,
    title: 'Create private Actor',
    description: dedent`
        Create a private Actor owned by the authenticated account from inline source files through the Apify Actors API,
        with limited permissions. No build is started. Environment variables, publishing, webhooks and permission overrides
        are not accepted.
    `,
    fields: ['name', 'title', 'description', 'files', 'versionNumber'],
    target: 'create',
});

export const getPrivateActorVersion = createPrivateAlias({
    base: getActorVersion,
    name: HELPER_TOOLS.PRIVATE_ACTOR_VERSION_GET,
    title: 'Get private Actor version',
    description: dedent`
        Read files, hashes and the revision of one private Actor owned by the authenticated account through the Apify Actor
        version API. Only inline source-file versions are supported. Named file contents are capped at 256 KiB.
    `,
    fields: ['actor', 'versionNumber', 'paths', 'startLine', 'lineCount'],
    target: 'actor',
});

export const updatePrivateActorVersion = createPrivateAlias({
    base: updateActorVersion,
    name: HELPER_TOOLS.PRIVATE_ACTOR_VERSION_UPDATE,
    title: 'Update private Actor version',
    description: dedent`
        Write, edit or delete files in one private Actor owned by the authenticated account through the Apify Actor version API.
        Preserves source hash and revision preconditions; no build is started. Does not change metadata, environment variables,
        permissions or publication status.
    `,
    fields: ['actor', 'versionNumber', 'operations', 'expectedRevision'],
    target: 'actor',
});

export const createPrivateActorVersion = createPrivateAlias({
    base: createActorVersion,
    name: HELPER_TOOLS.PRIVATE_ACTOR_VERSION_CREATE,
    title: 'Create private Actor version',
    description: dedent`
        Create a version from inline files in a private Actor owned by the authenticated account through the Apify Actor version
        API. Does not copy environment variables, assign a build tag, start a build or publish the Actor.
    `,
    fields: ['actor', 'versionNumber', 'files'],
    required: ['files'],
    target: 'actor',
});

export const buildPrivateActor = createPrivateAlias({
    base: buildActor,
    name: HELPER_TOOLS.PRIVATE_ACTOR_BUILD,
    title: 'Build private Actor',
    description: dedent`
        Build an explicit version of a private Actor owned by the authenticated account. Executes its build code and incurs
        platform usage. Waits at most 45 seconds; this bounds waiting, not build duration or cost. Uses the version's configured
        build tag and never publishes the Actor. Retrying can start another billed build.
    `,
    fields: ['actor', 'versionNumber', 'useCache', 'waitSecs'],
    required: ['versionNumber'],
    target: 'actor',
});

export const getPrivateActorBuild = createPrivateAlias({
    base: getActorBuild,
    name: HELPER_TOOLS.PRIVATE_ACTOR_BUILD_GET,
    title: 'Get private Actor build',
    description: dedent`
        Read the status and build number of a build belonging to a private Actor owned by the authenticated account.
        Waits at most 45 seconds for completion.
    `,
    fields: ['buildId', 'waitSecs'],
    target: 'buildId',
});

export const getPrivateActorBuildList = createPrivateAlias({
    base: getActorBuildList,
    name: HELPER_TOOLS.PRIVATE_ACTOR_BUILD_LIST_GET,
    title: 'Get private Actor build list',
    description: dedent`
        List up to 20 builds of a specified private Actor owned by the authenticated account.
        Does not list builds across the account.
    `,
    fields: ['actorId', 'offset', 'limit', 'desc'],
    required: ['actorId'],
    target: 'actorId',
});

export const getPrivateActorBuildLog = createPrivateAlias({
    base: getActorBuildLog,
    name: HELPER_TOOLS.PRIVATE_ACTOR_BUILD_LOG,
    title: 'Get private Actor build log',
    description: dedent`
        Read the last 1 to 50 log lines of a build belonging to a private Actor owned by the authenticated account.
        Returned text is capped at 256 KiB; the platform log endpoint still downloads the complete log.
    `,
    fields: ['buildId', 'lines'],
    target: 'buildId',
});

const runOwnedActorValidator = z.strictObject({
    actor: z.string().min(1).describe('Private Actor ID or name in the authenticated account.'),
    buildId: z
        .string()
        .min(1)
        .describe('ID of the successful build to execute, belonging to this Actor. Tags are not accepted.'),
    input: anyJsonObjectSchema.describe('JSON input for the private Actor. This is passed to customer code.'),
    timeoutSecs: z
        .number()
        .int()
        .min(1)
        .max(PRIVATE_ACTOR_RUN_LIMITS.timeoutSecs.max)
        .default(PRIVATE_ACTOR_RUN_LIMITS.timeoutSecs.default),
    memoryMbytes: z
        .union([z.literal(128), z.literal(256), z.literal(512), z.literal(1024), z.literal(2048), z.literal(4096)])
        .default(PRIVATE_ACTOR_RUN_LIMITS.memoryMbytes.default),
    maxTotalChargeUsd: z
        .number()
        .positive()
        .max(PRIVATE_ACTOR_RUN_LIMITS.maxTotalChargeUsd.max)
        .default(PRIVATE_ACTOR_RUN_LIMITS.maxTotalChargeUsd.default),
    waitSecs: z
        .number()
        .int()
        .min(0)
        .max(PRIVATE_ACTOR_RUN_LIMITS.waitSecs.max)
        .default(PRIVATE_ACTOR_RUN_LIMITS.waitSecs.default),
});
const RUN_OWNED_ACTOR_INPUT_SCHEMA = fixZodSchemaRequired(z.toJSONSchema(runOwnedActorValidator)) as ToolInputSchema;
const RUN_OWNED_ACTOR_VALIDATE = PRIVATE_TOOLS_AJV.compile(RUN_OWNED_ACTOR_INPUT_SCHEMA);

/** Run helpers can be selected alone, without the usual retrieval tools. */
function gateRunNextStep(response: ToolResponse, loadedToolNames: readonly string[]): ToolResponse {
    const content = response.structuredContent as RunResponse;
    const unavailable = [
        HELPER_TOOLS.ACTOR_RUNS_GET,
        HELPER_TOOLS.DATASET_GET_ITEMS,
        HELPER_TOOLS.KEY_VALUE_STORE_RECORD_GET,
    ].some((name) => content.nextStep.includes(name) && !loadedToolNames.includes(name));
    if (!unavailable) return response;
    const structuredContent = {
        ...content,
        nextStep: 'The response contains the run status and available storage identifiers.',
    };
    return respondOk(
        [JSON.stringify(structuredContent), `${structuredContent.summary}\n${structuredContent.nextStep}`],
        {
            structuredContent,
            meta: response._meta,
        },
    );
}

export const runOwnedActor: HelperTool = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.OWNED_ACTOR_RUN,
    title: 'Run owned private Actor',
    description: dedent`
        Execute a successful, explicitly selected build of a private Actor owned by the authenticated account.
        Runs customer code with forced limited Actor permissions. Limited permissions still allow calls to other
        limited-permission Actors; this is not a sandbox restricted to the curated Actor list.
        Defaults: 60 seconds, 1024 MiB, $1 maximum run charge, 30 seconds waiting.
        Maximums: 300 seconds, 4096 MiB, $5 maximum run charge, 45 seconds waiting.
        The charge cap applies to this run, not independently started child runs. Starting a run incurs usage and is not safe to retry blindly.
        No webhook, environment-variable, permission, build-tag or standby/MCP overrides are accepted.
    `,
    inputSchema: RUN_OWNED_ACTOR_INPUT_SCHEMA,
    outputSchema: actorRunOutputSchema,
    ajvValidate: RUN_OWNED_ACTOR_VALIDATE,
    paymentRequired: true,
    annotations: {
        title: 'Run owned private Actor',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
    },
    redactArgs: (args) => ({
        ...redactPrivateArgs(args, [
            'actor',
            'buildId',
            'timeoutSecs',
            'memoryMbytes',
            'maxTotalChargeUsd',
            'waitSecs',
        ]),
        input: '[REDACTED]',
    }),
    call: async (toolArgs) => {
        if (!RUN_OWNED_ACTOR_VALIDATE(toolArgs.args))
            return respondUserError('The arguments do not match this private Actor run schema.');
        const parsed = runOwnedActorValidator.parse(toolArgs.args);
        if (toolArgs.signal.aborted) return respondAborted();
        try {
            const userId = await fetchAccountId(toolArgs);
            const actor = await fetchPrivateActor(toolArgs.apifyClient, parsed.actor, userId);
            const build = await fetchPrivateBuild(toolArgs.apifyClient, parsed.buildId, userId);
            if (
                build.actId !== actor.id ||
                build.status !== 'SUCCEEDED' ||
                !/^\d+\.\d+\.\d+$/.test(build.buildNumber)
            ) {
                throw new UserInputError('The selected build must be successful and belong to this private Actor.');
            }
            // Pin the immutable Actor ID and exact build number, never a name or movable build tag.
            const currentActor = await toolArgs.apifyClient.actor(actor.id).get();
            validatePrivateActor(currentActor, userId, actor.id);
            if (toolArgs.signal.aborted) return respondAborted();
            const run = await toolArgs.apifyClient.actor(actor.id).start(parsed.input, {
                build: build.buildNumber,
                forcePermissionLevel: 'LIMITED_PERMISSIONS',
                timeout: parsed.timeoutSecs,
                memory: parsed.memoryMbytes,
                maxTotalChargeUsd: parsed.maxTotalChargeUsd,
                restartOnError: false,
            });
            if (run.actId !== actor.id || run.buildId !== build.id) {
                await abortRunOnSignal(run.id, toolArgs.apifyClient);
                throw new UserInputError(
                    'The platform returned a run for a different Actor or build; an abort was requested.',
                );
            }
            if (toolArgs.signal.aborted) {
                await abortRunOnSignal(run.id, toolArgs.apifyClient);
                return respondAborted();
            }
            const linkContext = await getConsoleLinkContext(toolArgs.apifyToken, toolArgs.apifyClient);
            const actorName = `${currentActor.username}/${currentActor.name}`;
            if (parsed.waitSecs === 0) {
                return gateRunNextStep(
                    buildStartRunResponse({ actorName, actorRun: run, linkContext }),
                    toolArgs.loadedToolNames,
                );
            }
            const fetched = await fetchActorRunData({
                runId: run.id,
                actorName,
                waitSecs: parsed.waitSecs,
                client: toolArgs.apifyClient,
                abortSignal: toolArgs.signal,
                progressTracker: toolArgs.progressTracker,
                onAbort: abortRunOnSignal,
            });
            if ('aborted' in fetched) return respondAborted();
            if ('error' in fetched) return fetched.error;
            return gateRunNextStep(
                buildGetActorRunResponse({ ...fetched.result, linkContext, hasCallActorTool: false }),
                toolArgs.loadedToolNames,
            );
        } catch (error) {
            if (error instanceof UserInputError) return respondUserError(error.message);
            throw error;
        }
    },
});

export const privateActorTools: readonly HelperTool[] = [
    createPrivateActor,
    getPrivateActorVersion,
    updatePrivateActorVersion,
    createPrivateActorVersion,
    buildPrivateActor,
    getPrivateActorBuild,
    getPrivateActorBuildList,
    getPrivateActorBuildLog,
    runOwnedActor,
];
