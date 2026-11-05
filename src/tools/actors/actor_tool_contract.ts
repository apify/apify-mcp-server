import { RAG_WEB_BROWSER, WEB_FETCH, WEB_SEARCH } from '../../const.js';
import type { ActorInputSchema, ToolDescriptionContext } from '../../types.js';
import { actorNameToToolName } from '../actor_tool_naming.js';

/** Appended to the `apify/rag-web-browser` tool description, a Server Actor tool (`GET /search`). */
const RAG_WEB_BROWSER_ADDITIONAL_DESC = `Use this tool for generic web content: it searches the web by query and returns the text of the top results.
This tool scrapes the data itself - it does NOT just find tools.
Example: {"method":"GET","path":"/search","query":{"query":"latest AI agent payment protocols","maxResults":3}}
If query is a URL, the tool fetches that page instead of searching.

Examples of when to use:
- General questions answered by web pages (e.g., "What's the weather in Prague?", "Latest news about the EU AI Act", "How does HTTP/3 work?")

For detailed data from a specific platform (e.g. Amazon products with prices, Instagram posts, Google Maps places with ratings), a specialized Actor from the Apify Store returns complete, structured results; this tool returns page text only.`;

// The `apify/web-fetch` and `apify/web-search` tool descriptions, Server Actor tools (`GET /` and `POST /`), share
// one shape: what the tool returns, the parameters that change what it returns, when it fits, what it does not do,
// and an example call. The facts are the Actors' own API schemas. Client-agnostic on purpose: no references to any
// specific client or its built-in tools, so the same text works for every MCP client; the sibling web tool is named
// only when the session serves it.

/** The `apify/web-fetch` tool description. */
const buildWebFetchDescription = ({ hasTool }: ToolDescriptionContext): string => {
    const webSearchTool = actorNameToToolName(WEB_SEARCH);
    return `Fetches one URL and returns its content as a JSON object with a field per requested format, plus metadata such as the final URL, HTTP status, content type and page title.
formats selects markdown, html, text, links (a deduplicated list) or raw (the original bytes); when omitted, an HTML or PDF page comes back as markdown, other text as text and binary content as raw.
The page is fetched without running JavaScript unless wait is set, which renders it in a real browser and waits the given milliseconds for late-loaded content; a rendered request is slower. The Actor handles common bot protection and rate limits, so it also retrieves pages where a plain HTTP fetch is blocked.
Use it when the user gives a URL and wants its content, data or links, or an answer that requires reading that page.
It does not search the web; it needs a URL.${hasTool(webSearchTool) ? ` To find pages by query, use ${webSearchTool}.` : ''}
Example: {"method":"GET","path":"/","query":{"url":"https://example.com","formats":["markdown"]}}`;
};

/** The `apify/web-search` tool description. */
const buildWebSearchDescription = ({ hasTool }: ToolDescriptionContext): string => {
    const webFetchTool = actorNameToToolName(WEB_FETCH);
    return `Runs one web search and returns one page of organic results as JSON: title, URL, snippet and position of each result, with publication date, publisher and sublinks when the search engine provides them.
provider picks google (the default) or duckduckgo; maxResults caps the results, and omitting it returns the whole page, about 10; countryCode and languageCode localize the ranking; dateFrom and dateTo (YYYY-MM-DD) bound the publication date; allowedDomains and blockedDomains (up to 10 hostnames each, subdomains included) restrict or exclude sites.
Use it when the user wants links to choose from, wants to know which pages exist for a topic, or asks a question that a result title or snippet answers.
It does not fetch page content; it returns links and snippets only.${hasTool(webFetchTool) ? ` To read a result page, use ${webFetchTool}.` : ''}
Example: {"method":"GET","path":"/","query":{"query":"latest AI agent payment protocols","maxResults":5}}`;
};

/**
 * The input descriptions of the two tools: `path`, and `query` listing every parameter of `GET /`. The url scheme
 * rule lives on the input because that is what an agent reads while writing the argument: agents silently rewrote
 * ftp:// URLs to https:// instead of telling the user the scheme is unsupported.
 */
const WEB_FETCH_INPUT_DESCRIPTIONS = {
    path: 'Always "/".',
    query:
        'url (required; http(s) only - for any other scheme, such as ftp:, tell the user this tool cannot fetch it ' +
        'rather than substituting a different URL), formats (array of markdown, html, text, links, raw), unwrap ' +
        '(boolean; returns the first producible format as the response body instead of a JSON object), headers ' +
        '(extra request headers as a JSON string), wait (milliseconds, 1 to 60000; renders the page in a real ' +
        'browser and waits for late-loaded content).',
};

const WEB_SEARCH_INPUT_DESCRIPTIONS = {
    path: 'Always "/".',
    query:
        'query (required; operators such as site: pass through unchecked), provider (google, the default, or ' +
        'duckduckgo), maxResults (integer; omitted returns the whole page), languageCode (ISO 639-1, such as en or ' +
        'pt-BR), countryCode (ISO 3166-1 alpha-2, such as US or CZ), location (a place name, google only), dateFrom ' +
        'and dateTo (YYYY-MM-DD), allowedDomains and blockedDomains (arrays of up to 10 hostnames).',
};

type DirectActorPolicyConfig = {
    /** Sent with the run input when the caller omits the field; the served schema shows it as the default. */
    defaults?: Readonly<Record<string, unknown>>;
    /** Left out of the served schema and refused by the call engine when sent. */
    deniedInputs?: readonly string[];
    /** Why, as served to the agent in the description and the refusal. */
    deniedInputsReason?: string;
};

type ServerActorToolPolicyConfig = {
    buildDescription?: (context: ToolDescriptionContext) => string;
    /** Replaces the description of the named inputs of the tool (`path`, `query`, `body`). */
    inputDescriptions?: Readonly<Record<string, string>>;
};

type ActorToolPolicyConfig = {
    /** Direct tools only; `call-actor` and the widgets keep the Actor's own contract. */
    directInput?: DirectActorPolicyConfig;
    /** The Actor's own tool when it is served through its server interface; a run tool gets none of it. */
    serverTool?: ServerActorToolPolicyConfig;
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
        serverTool: { buildDescription: () => RAG_WEB_BROWSER_ADDITIONAL_DESC },
    },
    [WEB_FETCH]: {
        serverTool: {
            buildDescription: buildWebFetchDescription,
            inputDescriptions: WEB_FETCH_INPUT_DESCRIPTIONS,
        },
    },
    [WEB_SEARCH]: {
        serverTool: {
            buildDescription: buildWebSearchDescription,
            inputDescriptions: WEB_SEARCH_INPUT_DESCRIPTIONS,
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
