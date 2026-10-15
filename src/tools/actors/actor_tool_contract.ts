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
    defaults?: Readonly<Record<string, unknown>>;
    deniedInputs?: readonly string[];
};

type ActorToolPolicyConfig = {
    directInput?: DirectActorPolicyConfig;
    exposedInputs?: readonly string[];
    inputDescriptionSuffixes?: Readonly<Record<string, string>>;
    buildDescription?: (context: ToolDescriptionContext) => string;
};

/** Presentation rules preserve existing generic-call behavior; directInput is direct-tool-only. */
const ACTOR_TOOL_POLICIES: Readonly<Record<string, ActorToolPolicyConfig>> = {
    'apify/website-content-crawler': {
        directInput: {
            defaults: { respectRobotsTxtFile: true },
            // Page code can submit forms; session cookies can grant access to external accounts (#1575).
            deniedInputs: ['pageFunction', 'initialCookies'],
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

    const effectiveInput = structuredClone(input) as ActorInputSchema & { allOf?: object[] };
    const deniedInputs = policy.deniedInputs ?? [];
    for (const name of deniedInputs) delete effectiveInput.properties[name];
    effectiveInput.required = effectiveInput.required?.filter((name) => !deniedInputs.includes(name));
    for (const [name, value] of Object.entries(policy.defaults ?? {})) {
        if (effectiveInput.properties[name]) effectiveInput.properties[name].default = value;
    }

    if (deniedInputs.length) {
        // Validate before the root's additionalProperties rule can strip a denied field.
        effectiveInput.allOf = [
            { properties: Object.fromEntries(deniedInputs.map((name) => [name, false])) },
            ...(effectiveInput.allOf ?? []),
        ];
    }
    return {
        input: effectiveInput,
        description: deniedInputs.length
            ? `This tool does not accept these Actor inputs: ${deniedInputs.map((name) => `"${name}"`).join(', ')}.`
            : '',
    };
}

/** AJV does not fill defaults, so the direct tool must send its overrides explicitly. */
export function buildDirectActorRunInput(
    actorFullName: string,
    input: Record<string, unknown>,
): Record<string, unknown> {
    return { ...getDirectActorPolicy(actorFullName)?.defaults, ...input };
}
