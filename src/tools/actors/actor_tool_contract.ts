import { RAG_WEB_BROWSER, WEB_FETCH, WEB_SEARCH } from '../../const.js';
import type { ActorInputSchema, ToolDescriptionContext } from '../../types.js';
import { actorNameToToolName } from '../actor_tool_naming.js';

const RAG_WEB_BROWSER_ADDITIONAL_DESC = `Use this tool for generic web content: it searches the web by query and returns the text of the top results.
This tool scrapes the data itself - it does NOT just find tools.

Examples of when to use:
- General questions answered by web pages (e.g., "What's the weather in Prague?", "Latest news about the EU AI Act", "How does HTTP/3 work?")

For detailed data from a specific platform (e.g. Amazon products with prices, Instagram posts, Google Maps places with ratings), a specialized Actor from the Apify Store returns complete, structured results; this tool returns page text only.`;

/** Follows RAG_WEB_BROWSER_ADDITIONAL_DESC on its own line when the session serves the apify/web-fetch tool. */
const RAG_WEB_BROWSER_WEB_FETCH_HINT = `When the user provides one specific URL and wants that page's full or verbatim content, prefer the dedicated ${WEB_FETCH} tool - this tool is for searching and scraping by query.`;
/** Follows RAG_WEB_BROWSER_ADDITIONAL_DESC and any Web Fetch hint on its own line when the session serves the apify/web-search tool. */
const RAG_WEB_BROWSER_WEB_SEARCH_HINT = `When the user wants a list of search results (links, titles, snippets) rather than page text, prefer the dedicated ${WEB_SEARCH} tool.`;
/**
 * Appended to the `apify/web-fetch` Actor tool description. Client-agnostic on purpose:
 * no references to any specific client or its built-in tools, so the same text works
 * for every MCP client.
 */
const buildWebFetchDescription = ({
    hasTool,
}: ToolDescriptionContext) => `Use this tool to fetch a specific http(s) URL and return its complete content (one URL per call; http and https only).
It renders JavaScript and bypasses anti-bot protection, so it also retrieves pages where a plain HTTP fetch gets blocked, fails with an error such as 403 or 429, or returns incomplete content.
The page comes back verbatim - full content, no summarization - as Markdown, plain text, HTML, the raw response body, or the list of links on the page.

Examples of when to use:
- User provides a URL and wants its content, its data or links, or an answer that requires reading that page
- A previous attempt to fetch a page was blocked, returned an error or CAPTCHA, or came back incomplete because the page needs JavaScript rendering
- Verbatim page content is needed, e.g. for quoting, extraction, or archiving

This tool does not search the web - it needs a URL. ${
    hasTool(actorNameToToolName(WEB_SEARCH))
        ? `To find pages by query, the dedicated ${WEB_SEARCH} tool returns links and snippets.`
        : 'To find pages by query, use a web search tool instead.'
}
If the exact URL cannot be fetched (e.g. a non-http(s) scheme), say so rather than silently substituting a different URL.`;

/**
 * Appended to the `url` parameter description of the `apify/web-fetch` tool. Lives on the
 * parameter because that is what an agent reads while writing the argument: agents
 * silently rewrote ftp:// URLs to https:// instead of telling the user the scheme is
 * unsupported.
 */
const WEB_FETCH_URL_SCHEME_NOTE =
    'http(s) URLs only - for any other scheme (e.g. ftp:), tell the user this tool cannot fetch it rather than substituting a different URL.';

/** Appended to the `apify/web-search` Actor tool description. */
const WEB_SEARCH_ADDITIONAL_DESC = `Use this tool to search the web by query and get one page of organic results: title, URL, snippet and position (up to about 10 results; links and snippets only, no page content).
countryCode and languageCode set the locale, dateFrom and dateTo bound the publication date, allowedDomains and blockedDomains restrict or exclude sites.

Examples of when to use:
- The user wants links to choose from or to know which pages exist for a topic (e.g., "find the official docs for X", "recent articles about Y, with links")
- A question that a result title or snippet answers

This tool does not fetch page content.`;

/** Follow WEB_SEARCH_ADDITIONAL_DESC, each on its own line, when the session serves the named tool. */
const WEB_SEARCH_WEB_FETCH_HINT = `When the user needs the content of a page found here, the dedicated ${WEB_FETCH} tool returns one URL's full content.`;
const WEB_SEARCH_RAG_WEB_BROWSER_HINT = `When the user wants the text of the top results in one step rather than a list of links, prefer the dedicated ${RAG_WEB_BROWSER} tool.`;

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
            if (hasTool(actorNameToToolName(WEB_SEARCH))) description += `\n${RAG_WEB_BROWSER_WEB_SEARCH_HINT}`;
            return description;
        },
    },
    [WEB_FETCH]: {
        inputDescriptionSuffixes: { url: WEB_FETCH_URL_SCHEME_NOTE },
        buildDescription: buildWebFetchDescription,
    },
    [WEB_SEARCH]: {
        buildDescription: ({ hasTool }) => {
            let description = WEB_SEARCH_ADDITIONAL_DESC;
            if (hasTool(actorNameToToolName(WEB_FETCH))) description += `\n${WEB_SEARCH_WEB_FETCH_HINT}`;
            if (hasTool(actorNameToToolName(RAG_WEB_BROWSER))) description += `\n${WEB_SEARCH_RAG_WEB_BROWSER_HINT}`;
            return description;
        },
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
