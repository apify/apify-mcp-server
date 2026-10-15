import type { ActorInputSchema } from '../../types.js';

type DirectActorPolicyConfig = {
    defaults?: Readonly<Record<string, unknown>>;
    deniedInputs?: readonly string[];
    /** Why, as served to the agent in the description and the refusal. */
    deniedInputsReason?: string;
};

/** MCP-only contracts; the Actor's original API contract stays unchanged (#1574, #1575). */
const DIRECT_ACTOR_POLICIES: Readonly<Record<string, DirectActorPolicyConfig>> = {
    'apify/website-content-crawler': {
        defaults: { respectRobotsTxtFile: true },
        deniedInputs: ['pageFunction', 'initialCookies'],
        deniedInputsReason:
            'page code can act on the crawled sites and session cookies can give access to accounts, which a read-only tool must not allow',
    },
};

export function getDirectActorPolicy(actorFullName: string): DirectActorPolicyConfig | undefined {
    return DIRECT_ACTOR_POLICIES[actorFullName];
}

export function buildDirectActorContract(actorFullName: string, input: ActorInputSchema | undefined) {
    const policy = getDirectActorPolicy(actorFullName);
    if (!policy || !input) return { input, description: '' };

    const effectiveInput = structuredClone(input);
    const deniedInputs = policy.deniedInputs ?? [];
    for (const name of deniedInputs) delete effectiveInput.properties[name];
    effectiveInput.required = effectiveInput.required?.filter((name) => !deniedInputs.includes(name));
    for (const [name, value] of Object.entries(policy.defaults ?? {})) {
        if (effectiveInput.properties[name]) effectiveInput.properties[name].default = value;
    }

    return {
        input: effectiveInput,
        description: deniedInputs.length ? buildDeniedInputsNote(actorFullName, deniedInputs) : '',
    };
}

/** One sentence for the description and the refusal: what is off, that the Actor allows it, why, and the consequence. */
export function buildDeniedInputsNote(actorFullName: string, names: readonly string[]): string {
    const reason = getDirectActorPolicy(actorFullName)?.deniedInputsReason;
    const list = names.map((name) => `"${name}"`).join(' and ');
    const [verb, pronoun] = names.length > 1 ? ['are', 'them'] : ['is', 'it'];
    return `${list} ${verb} not accepted by this tool, although the Actor supports ${pronoun}${reason ? `: ${reason}` : ''}, so this tool rejects ${pronoun}.`;
}

/**
 * Denied inputs are absent from the served schema, but AJV keeps undeclared fields unless the Actor's
 * schema sets `additionalProperties: false`, in which case it strips them. Either way the run would
 * proceed, so the call is checked before validation.
 */
export function getDeniedDirectActorInputs(actorFullName: string, args: Record<string, unknown>): string[] {
    return (getDirectActorPolicy(actorFullName)?.deniedInputs ?? []).filter((name) => name in args);
}

/** AJV does not fill defaults, so the direct tool must send its overrides explicitly. */
export function buildDirectActorRunInput(
    actorFullName: string,
    input: Record<string, unknown>,
): Record<string, unknown> {
    return { ...getDirectActorPolicy(actorFullName)?.defaults, ...input };
}
