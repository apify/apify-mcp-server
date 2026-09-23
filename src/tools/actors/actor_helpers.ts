import type { Actor, ActorClient } from 'apify-client';

import { ACTOR_NAME, USERNAME } from '@apify/consts';

import type { ApifyClient } from '../../apify_client.js';
import { UserInputError } from '../../errors.js';

export type ActorNameParts = { ownerPrefix: string | undefined; bareName: string };

/** The `username/name` form the API and the responses use. */
export function formatActorFullName(username: string, bareName: string): string {
    return `${username}/${bareName}`;
}

/**
 * Splits `username/name` or `username~name` (the separator the Apify API uses) into its parts; a bare
 * name has no `ownerPrefix`.
 */
function parseActorName(actorName: string): ActorNameParts {
    const separatorIndex = actorName.search(/[/~]/);
    if (separatorIndex === -1) return { ownerPrefix: undefined, bareName: actorName };
    return { ownerPrefix: actorName.slice(0, separatorIndex), bareName: actorName.slice(separatorIndex + 1) };
}

// `APIFY_ID_REGEX` in `@apify/consts` is unanchored, so the shape is spelled out here.
const ACTOR_ID_SHAPE_REGEX = /^[a-zA-Z0-9]{17}$/;

const ACTOR_NAME_RULE_TEXT = `Actor name must be ${ACTOR_NAME.MIN_LENGTH} to ${ACTOR_NAME.MAX_LENGTH} characters: letters, digits and dashes, not starting or ending with a dash.`;

const USERNAME_PREFIX_RULE_TEXT = `Username prefix must be ${USERNAME.MIN_LENGTH} to ${USERNAME.MAX_LENGTH} letters, digits, dots, underscores or dashes.`;

/**
 * The name split into its parts, checked with the platform's own rules (`@apify/consts`, the ones the
 * API applies) so a bad name is rejected before any API call; throws `UserInputError` for the first problem.
 */
export function resolveActorNameInput(actorName: string): ActorNameParts {
    const parts = parseActorName(actorName);
    const { ownerPrefix, bareName } = parts;
    const isBareNameValid =
        bareName.length >= ACTOR_NAME.MIN_LENGTH &&
        bareName.length <= ACTOR_NAME.MAX_LENGTH &&
        ACTOR_NAME.REGEX.test(bareName);
    if (!isBareNameValid) throw new UserInputError(ACTOR_NAME_RULE_TEXT);
    if (ownerPrefix !== undefined && !USERNAME.REGEX.test(ownerPrefix)) {
        throw new UserInputError(USERNAME_PREFIX_RULE_TEXT);
    }
    return parts;
}

export type TargetActor = {
    actorClient: ActorClient;
    /** The account the Actor lives in, in the platform's spelling. */
    username: string;
    bareName: string;
    /** Undefined when the Actor does not exist yet. */
    actor: Actor | undefined;
};

/** Throws `UserInputError` when the Actor the API returned lives in another account than the caller's. */
function validateActorOwner(actor: Actor, username: string, bareName: string): void {
    if (actor.username.toLowerCase() === username.toLowerCase()) return;
    throw new UserInputError(
        `This tool works only with Actors of your own account (${username}); Actor ${bareName} belongs to ${actor.username}.`,
    );
}

/**
 * Looks up the caller's username and the Actor. A `username/` or `username~` prefix must name the caller's
 * own account. A bare value that no Actor is named after and that has the shape of an Actor ID, the value
 * the build and run tools hand out, is looked up once as an ID and must be the caller's Actor. `actor` is
 * undefined when nothing matches: `push-actor` then creates an Actor of that name, the other tools report
 * it as not found; an ID never creates one.
 */
export async function resolveTargetActor(
    client: ApifyClient,
    { ownerPrefix, bareName }: ActorNameParts,
): Promise<TargetActor> {
    const { username } = await client.user('me').get();
    if (ownerPrefix !== undefined && ownerPrefix.toLowerCase() !== username.toLowerCase()) {
        throw new UserInputError(
            `This tool works only with Actors of your own account (${username}); '${ownerPrefix}' names another account.`,
        );
    }
    const actorClient = client.actor(formatActorFullName(username, bareName));
    const actor = await actorClient.get();
    // The platform resolves the old `username~name` of an Actor moved to another account to that Actor.
    if (actor) validateActorOwner(actor, username, bareName);
    const canBeId = actor === undefined && ownerPrefix === undefined && ACTOR_ID_SHAPE_REGEX.test(bareName);
    if (!canBeId) return { actorClient, username, bareName, actor };
    const actorById = await client.actor(bareName).get();
    if (!actorById) return { actorClient, username, bareName, actor: undefined };
    validateActorOwner(actorById, username, bareName);
    return { actorClient: client.actor(actorById.id), username, bareName: actorById.name, actor: actorById };
}
