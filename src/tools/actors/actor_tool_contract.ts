import {
    RAG_WEB_BROWSER,
    RAG_WEB_BROWSER_ADDITIONAL_DESC,
    RAG_WEB_BROWSER_WEB_FETCH_HINT,
    WEB_FETCH,
    WEB_FETCH_ADDITIONAL_DESC,
    WEB_FETCH_URL_SCHEME_NOTE,
} from '../../const.js';
import type { ActorInputSchema, ToolDescriptionContext } from '../../types.js';
import { actorNameToToolName } from '../actor_tool_naming.js';

type DirectActorPolicyConfig = {
    /** Sent with the run input when the caller omits the field; the served schema shows it as the default. */
    defaults?: Readonly<Record<string, unknown>>;
    /** Left out of the served schema and refused by the call engine when sent. */
    deniedInputs?: readonly string[];
    /** Why, as served to the agent in the description and the refusal. */
    deniedInputsReason?: string;
};

type ActorToolPolicyConfig = {
    /** Direct tools only; `call-actor` and the widgets keep the Actor's own contract. */
    directInput?: DirectActorPolicyConfig;
    /** Only these inputs are served; the others are hidden but still accepted and passed to the run. */
    exposedInputs?: readonly string[];
    inputDescriptionSuffixes?: Readonly<Record<string, string>>;
    buildDescription?: (context: ToolDescriptionContext) => string;
};

/** Presentation rules preserve existing generic-call behavior; directInput is direct-tool-only. */
const ACTOR_TOOL_POLICIES: Readonly<Record<string, ActorToolPolicyConfig>> = {
    'apify/website-content-crawler': {
        directInput: {
            defaults: { respectRobotsTxtFile: true },
            deniedInputs: ['pageFunction', 'initialCookies'],
            deniedInputsReason:
                'page code can act on the crawled sites and session cookies can give access to accounts, which a read-only tool must not allow',
        },
    },
    [RAG_WEB_BROWSER]: {
        exposedInputs: ['query', 'maxResults', 'outputFormats'],
        buildDescription: ({ hasTool }) => {
            let description = RAG_WEB_BROWSER_ADDITIONAL_DESC;
            if (hasTool(actorNameToToolName(WEB_FETCH))) description += `\n${RAG_WEB_BROWSER_WEB_FETCH_HINT}`;
            return description;
        },
    },
    [WEB_FETCH]: {
        inputDescriptionSuffixes: { url: WEB_FETCH_URL_SCHEME_NOTE },
        buildDescription: () => WEB_FETCH_ADDITIONAL_DESC,
    },
};

export function getActorToolPolicy(actorFullName: string): ActorToolPolicyConfig | undefined {
    return ACTOR_TOOL_POLICIES[actorFullName];
}

export function getDirectActorPolicy(actorFullName: string): DirectActorPolicyConfig | undefined {
    return getActorToolPolicy(actorFullName)?.directInput;
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
