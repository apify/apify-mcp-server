import type { Actor, ActorCollectionCreateOptions, ActorVersion, ActorVersionSourceFile } from 'apify-client';
import { ActorSourceType, ApifyApiError } from 'apify-client';
import dedent from 'dedent';
import { z } from 'zod';

import type { ApifyClient } from '../../apify_client.js';
import { HELPER_TOOLS } from '../../const.js';
import { UserInputError } from '../../errors.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { compileSchema, fixZodSchemaRequired } from '../../utils/ajv.js';
import { getConsoleLinkContext } from '../../utils/console_link.js';
import { respondAborted } from '../../utils/mcp.js';
import { buildNextStepForBuild, respondWithBuild, toBuildResult } from '../builds/build_helpers.js';
import { createActorToolOutputSchema } from '../structured_output_schemas.js';
import { buildFilesRevision, buildUrlRevision, parseStoredPath } from './source_files.js';
import type { BuildAfterWriteResult } from './source_helpers.js';
import {
    ACTOR_CONFIG_PATH,
    buildFilesManifest,
    formatBuildLaterHint,
    formatBuildStartFailure,
    buildSentFilesWarnings,
    formatUrlWithoutSecrets,
    getSourceFileEntryBytes,
    isFolderEntry,
    MAX_WRITE_FILES,
    parseInputFiles,
    respondToSourceToolError,
    sourceFileArgs,
    startBuildAfterWrite,
    validateActorName,
    validateNewFilesCallSize,
    validateSessionToken,
} from './source_helpers.js';

/** `apify push` starts a new Actor at this version. */
const DEFAULT_VERSION_NUMBER = '0.0';

/** `apify push` uses this tag too, because the platform expects an Actor to have a `latest` build. */
const DEFAULT_BUILD_TAG = 'latest';

/**
 * The error types the platform returns when the account already has an Actor with the name: the first from its
 * lookup before the insert, the second from the unique index when two creates race past that lookup.
 */
const ACTOR_NAME_TAKEN_ERROR_TYPES: ReadonlySet<string> = new Set(['actor-name-not-unique', 'name-not-unique']);

const createActorArgs = z.object({
    name: z
        .string()
        .min(1)
        .describe(
            'Name of the new Actor, without a username, for example my-scraper: 3 to 63 letters, digits, and dashes. It is created in your own account.',
        ),
    title: z.string().min(1).optional().describe('Display title, for example My Scraper.'),
    description: z.string().optional().describe('A short description of what the Actor does.'),
    files: z
        .array(sourceFileArgs)
        .min(1)
        .max(MAX_WRITE_FILES)
        .optional()
        .describe(
            `The Actor's files, 1 to ${MAX_WRITE_FILES}; they must include ${ACTOR_CONFIG_PATH}. Give exactly one of files or gitRepoUrl.`,
        ),
    gitRepoUrl: z
        .string()
        .min(1)
        .optional()
        .describe(
            'Build the Actor from this Git repository instead, as repository#branch:directory (branch and directory are optional).',
        ),
    versionNumber: z
        .string()
        .default(DEFAULT_VERSION_NUMBER)
        .describe(`Number of the first version in MAJOR.MINOR form. Default: ${DEFAULT_VERSION_NUMBER}.`),
    buildTag: z
        .string()
        .min(1)
        .default(DEFAULT_BUILD_TAG)
        .describe(`Tag that builds of the version get. Default: ${DEFAULT_BUILD_TAG}.`),
    autoBuild: z
        .boolean()
        .default(false)
        .describe('Start a build of the version after creating the Actor, and return without waiting. Default: false.'),
});

type CreateActorArgs = z.infer<typeof createActorArgs>;

type PreparedSource = { kind: 'files'; entries: ActorVersionSourceFile[] } | { kind: 'git'; gitRepoUrl: string };

/** Checks the input without any API call; throws `UserInputError` for the first problem. */
function parseCreateRequest(args: CreateActorArgs, loadedToolNames: readonly string[]): PreparedSource {
    validateActorName(args.name);
    if ((args.files === undefined) === (args.gitRepoUrl === undefined)) {
        throw new UserInputError('Give exactly one of files or gitRepoUrl.');
    }
    if (args.gitRepoUrl !== undefined) return { kind: 'git', gitRepoUrl: args.gitRepoUrl };
    const files = args.files ?? [];
    validateNewFilesCallSize(files, { subject: 'Actor', loadedToolNames });
    return { kind: 'files', entries: parseInputFiles(files) };
}

function buildFilesWarnings(
    sentEntries: readonly ActorVersionSourceFile[],
    storedEntries: readonly ActorVersionSourceFile[] | undefined,
): string[] {
    const sentConfig = sentEntries.find(({ name }) => name === ACTOR_CONFIG_PATH);
    const storedConfig = storedEntries?.findLast(({ name }) => parseStoredPath(name) === ACTOR_CONFIG_PATH);
    const isConfigRewritten =
        sentConfig !== undefined &&
        storedConfig !== undefined &&
        !getSourceFileEntryBytes(sentConfig).equals(getSourceFileEntryBytes(storedConfig));
    const rewrittenWarning =
        `The platform set the name field of ${ACTOR_CONFIG_PATH} to the Actor name, so the stored file differs ` +
        'from the one sent; its hash in files, and the revision, are those of the stored file.';
    return [...buildSentFilesWarnings(sentEntries), ...(isConfigRewritten ? [rewrittenWarning] : [])];
}

/**
 * The files the platform stored, from the created Actor's version; undefined when the response has none. The platform
 * rewrites the name in `.actor/actor.json` on create, so these, not the sent ones, match a later read.
 */
function extractStoredEntries(created: Actor, versionNumber: string): ActorVersionSourceFile[] | undefined {
    const version = (created.versions as ActorVersion[] | undefined)?.find(
        (candidate) => candidate.versionNumber === versionNumber,
    );
    const sourceFiles = version?.sourceType === ActorSourceType.SourceFiles ? version.sourceFiles : undefined;
    return Array.isArray(sourceFiles) ? sourceFiles.filter((entry) => !isFolderEntry(entry)) : undefined;
}

function buildVersion(args: CreateActorArgs, source: PreparedSource): ActorVersion {
    const common = { versionNumber: args.versionNumber, buildTag: args.buildTag };
    if (source.kind === 'git') return { ...common, sourceType: ActorSourceType.GitRepo, gitRepoUrl: source.gitRepoUrl };
    return { ...common, sourceType: ActorSourceType.SourceFiles, sourceFiles: source.entries };
}

/** The caller's username, so the name-taken text can give the full name update-actor-version takes. */
async function fetchUsername(client: ApifyClient): Promise<string | undefined> {
    try {
        const user = await client.user('me').get();
        return typeof user?.username === 'string' && user.username !== '' ? user.username : undefined;
    } catch {
        return undefined;
    }
}

function formatNameTakenText(params: {
    name: string;
    username: string | undefined;
    loadedToolNames: readonly string[];
}): string {
    const { name, username, loadedToolNames } = params;
    const fullName = username === undefined ? name : `${username}/${name}`;
    const selectorText = username === undefined ? ' with actor set to your username/name' : ` with actor ${fullName}`;
    const hint = loadedToolNames.includes(HELPER_TOOLS.ACTOR_VERSION_UPDATE)
        ? ` To change its source, use ${HELPER_TOOLS.ACTOR_VERSION_UPDATE}${selectorText}.`
        : ' Pick another name, or change the existing Actor instead.';
    return `Your account already has an Actor named ${fullName}, and this tool never changes an existing Actor.${hint}`;
}

function formatNextStep(buildResult: BuildAfterWriteResult | undefined, loadedToolNames: readonly string[]): string {
    if (buildResult?.build) return buildNextStepForBuild(buildResult.build, { loadedToolNames });
    if (buildResult?.buildErrMessage !== undefined) {
        return formatBuildStartFailure('The Actor was created', buildResult.buildErrMessage, loadedToolNames);
    }
    return `The Actor has no build yet, so it cannot run until this version is built.${formatBuildLaterHint(loadedToolNames)}`;
}

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    const existingNote = hasTool(HELPER_TOOLS.ACTOR_VERSION_UPDATE)
        ? ` To change an existing Actor, use ${HELPER_TOOLS.ACTOR_VERSION_UPDATE}.`
        : '';
    const waitNote = hasTool(HELPER_TOOLS.ACTOR_BUILD_GET)
        ? ` Follow the build with ${HELPER_TOOLS.ACTOR_BUILD_GET}.`
        : '';
    return dedent`
        Create a new private Actor in your own account, with one version holding its source: files, or a Git repository to build from.
        It never changes an existing Actor: a name your account already uses is refused.${existingNote}
        - files: every file with its path and content; they must include ${ACTOR_CONFIG_PATH}. Without a Dockerfile (at the root, in .actor/, or named by ${ACTOR_CONFIG_PATH}) the build uses the platform's default Node.js one. Binary files take base64 content with encoding base64; files with a binary extension such as .png default to it.
        - gitRepoUrl: repository#branch:directory, with the branch and directory optional.
        Limits: ${MAX_WRITE_FILES} files and 2 MiB of content. The result lists each file's hash and the version's revision.
        autoBuild starts a build after creating the Actor and returns without waiting.${waitNote} The version is ${DEFAULT_VERSION_NUMBER} with build tag ${DEFAULT_BUILD_TAG} unless you set versionNumber and buildTag.

        USAGE:
        - Use to publish new Actor code to the Apify platform for the first time.

        USAGE EXAMPLES:
        - user_input: Create an Actor called hacker-news-scraper from these files
        - user_input: Deploy my Actor from https://github.com/john/my-actor.git and build it`;
}

/**
 * https://docs.apify.com/api/v2/actors-post
 *  /v2/actors
 *
 * One POST creates the Actor and its version together, so a failed call leaves nothing behind. The platform creates
 * it private and in the token's account.
 */
export const createActor: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_CREATE,
    title: 'Create Actor',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
    // `fixZodSchemaRequired` strips `versionNumber`, `buildTag`, and `autoBuild` from `required` because they have defaults.
    inputSchema: fixZodSchemaRequired(z.toJSONSchema(createActorArgs)) as ToolInputSchema,
    outputSchema: createActorToolOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(createActorArgs)),
    annotations: {
        title: 'Create Actor',
        readOnlyHint: false,
        destructiveHint: false,
        // A second call with the same name is refused rather than repeated.
        idempotentHint: false,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client, apifyToken, loadedToolNames, signal } = toolArgs;
        const parsed = createActorArgs.parse(args);
        try {
            const source = parseCreateRequest(parsed, loadedToolNames);
            validateSessionToken(apifyToken, 'Creating an Actor');
            // A cancel before the POST creates nothing; per the MCP spec the cancelled request gets no response.
            if (signal?.aborted) return respondAborted();
            let created;
            try {
                created = await client.actors().create({
                    name: parsed.name,
                    ...(parsed.title !== undefined && { title: parsed.title }),
                    ...(parsed.description !== undefined && { description: parsed.description }),
                    versions: [buildVersion(parsed, source)],
                } satisfies ActorCollectionCreateOptions);
            } catch (error) {
                if (error instanceof ApifyApiError && ACTOR_NAME_TAKEN_ERROR_TYPES.has(error.type ?? '')) {
                    const username = await fetchUsername(client);
                    throw new UserInputError(formatNameTakenText({ name: parsed.name, username, loadedToolNames }));
                }
                throw error;
            }
            // Per the MCP spec a cancelled request gets no response; the Actor stands, and no build is started.
            if (signal?.aborted) return respondAborted();
            const buildResult = parsed.autoBuild
                ? await startBuildAfterWrite(client, created.id, parsed.versionNumber)
                : undefined;
            const linkContext = buildResult?.build ? await getConsoleLinkContext(apifyToken, client) : undefined;
            const storedEntries =
                source.kind === 'files' ? extractStoredEntries(created, parsed.versionNumber) : undefined;
            const files = source.kind === 'files' ? buildFilesManifest(storedEntries ?? source.entries) : [];
            const revision =
                source.kind === 'files'
                    ? buildFilesRevision(files)
                    : buildUrlRevision(ActorSourceType.GitRepo, formatUrlWithoutSecrets(source.gitRepoUrl));
            const fullName = `${created.username}/${created.name}`;
            const structuredContent = {
                actorId: created.id,
                fullName,
                versionNumber: parsed.versionNumber,
                sourceType: source.kind === 'files' ? ActorSourceType.SourceFiles : ActorSourceType.GitRepo,
                buildTag: parsed.buildTag,
                revision,
                files: files.map(({ path, sizeBytes, hash, format }) => ({ path, sizeBytes, hash, format })),
                warnings: source.kind === 'files' ? buildFilesWarnings(source.entries, storedEntries) : [],
                ...(buildResult?.build && { build: toBuildResult(buildResult.build, linkContext) }),
                ...(buildResult?.buildErrMessage !== undefined && { buildError: buildResult.buildErrMessage }),
            };
            const sourceText =
                source.kind === 'files'
                    ? `${files.length} ${files.length === 1 ? 'file' : 'files'}`
                    : `the Git repository ${formatUrlWithoutSecrets(source.gitRepoUrl)}`;
            const warningNote = structuredContent.warnings.length > 0 ? ` ${structuredContent.warnings.join(' ')}` : '';
            const summary =
                `Created the private Actor ${fullName} (ID ${created.id}) with version ${parsed.versionNumber} ` +
                `from ${sourceText}, build tag ${parsed.buildTag}, revision ${revision}.${warningNote}`;
            return respondWithBuild({
                structuredContent,
                summary,
                nextStep: formatNextStep(buildResult, loadedToolNames),
            });
        } catch (error) {
            return respondToSourceToolError(error);
        }
    },
} as const);
