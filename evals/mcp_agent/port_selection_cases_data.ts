/**
 * Authoring table for apify/ai-team#240: port `evals/test_cases.json` (106 v1.11 next-tool-
 * prediction cases, the old Phoenix runner's suite) into `mcp-server-evals` as `kind:
 * "selection", tier: ["pr"]` items, plus a coverage wave (the tools the old suite never
 * exercised) and a lazy-user wave (typos, vague goals, missing parameters, wrong Actor names).
 *
 * This is a one-off, committed table (like `migrate_unified_dataset.ts`'s `SOURCE_DATASETS` /
 * `EXPECTED_ERRORS_BY_NEW_ID`), read by `port_selection_cases.ts` — not a generic importer.
 * Every row here becomes exactly one upserted dataset item.
 *
 * Id scheme: `<category>/<slug>`. `<category>` is the source case's own `category` field for
 * every old category that is itself a real tool name; the two exceptions (`tool-selection`,
 * `ambiguous`, neither a tool name) use `expectedTools[0]` instead. `<slug>` dodges the 4
 * already-burned live slugs: `call-actor/rag-web-browser`, `fetch-actor-details/input-schema`,
 * `search-actors/tiktok-scraper`, `get-actor-run/status`.
 *
 * `ARCHIVED_CASES` lists every old id that is NOT ported, with a one-line reason, so all 106
 * source ids are accounted for exactly once (103 ported here + 3 archived = 106).
 */

export type PortDecision = 'keep' | 'rephrase' | 'widen' | 'new';

/** One dataset item to upsert. Every row is `kind: "selection", tier: ["pr"]` (added by the script). */
export type PortCaseSpec = {
    /** The old `evals/test_cases.json` id this row ports. Absent for a brand-new (coverage/lazy-user) case. */
    sourceId?: string;
    /** Why this row exists, for the reviewable audit trail — not written to Langfuse. */
    decision: PortDecision;
    /** New dataset item id, `<category>/<slug>`. */
    id: string;
    /** User-language query, self-contained (no `context`/`reference` carried over). */
    query: string;
    /** metadata.category — the id's family prefix. */
    category: string;
    /** Tool names the first attempted call must match. */
    expectedTools: string[];
    /** Optional: pin a captured argument. Only set when expectedTools has exactly one entry. */
    expectedArgs?: Record<string, unknown>;
    /** Isolate MCP-vs-MCP tool choice (rag-web-browser vs. search-actors) from built-ins. */
    mcpToolsOnly?: boolean;
    /** Non-default-served tool families this item needs enabled (`runs`, `storage`, `tasks`). */
    tools?: string[];
};

/** An old id that is not ported, and why. */
export type ArchivedCase = { sourceId: string; reason: string };

/**
 * 3 of the 106 old ids are not ported: 2 exact-duplicate queries (the design's own finding) and
 * 1 exact duplicate of a pre-existing live `pr`-tier item (found while authoring this table).
 */
export const ARCHIVED_CASES: ArchivedCase[] = [
    {
        sourceId: 'fetch-actor-details-10',
        reason:
            'Exact-duplicate query of the pre-existing live item "fetch-actor-details/input-schema" ' +
            '("Show me the input schema for apify/rag-web-browser") — porting it would either collide on ' +
            'the burned slug or duplicate coverage under a new one.',
    },
    {
        sourceId: 'tool-selection-confusion-2',
        reason:
            'Exact-duplicate query ("Get recent AI articles on tech blogs") of search-vs-rag-3, ported as ' +
            '"apify--rag-web-browser/ai-articles-tech-blogs".',
    },
    {
        sourceId: 'tool-selection-confusion-3',
        reason:
            'Exact-duplicate query ("Get the latest weather forecast for New York") of search-vs-rag-5, ' +
            'ported as "apify--rag-web-browser/ny-weather-forecast".',
    },
];

// ---------------------------------------------------------------------------
// Wave 1: actors (fetch-actor-details, search-actors, apify--rag-web-browser, call-actor)
// ---------------------------------------------------------------------------

const ACTORS_WAVE: PortCaseSpec[] = [
    // --- fetch-actor-details (9 ported; fetch-actor-details-10 archived above) ---
    {
        sourceId: 'fetch-actor-details-1',
        decision: 'keep',
        id: 'fetch-actor-details/instagram-scraper-overview',
        query: 'What are the details of apify/instagram-scraper?',
        category: 'fetch-actor-details',
        expectedTools: ['fetch-actor-details'],
        expectedArgs: { actor: 'apify/instagram-scraper' },
    },
    {
        sourceId: 'fetch-actor-details-2',
        decision: 'keep',
        id: 'fetch-actor-details/rag-web-browser-docs',
        query: 'Give me the documentation for apify/rag-web-browser',
        category: 'fetch-actor-details',
        expectedTools: ['fetch-actor-details'],
        expectedArgs: { actor: 'apify/rag-web-browser' },
    },
    {
        sourceId: 'fetch-actor-details-3',
        decision: 'keep',
        id: 'fetch-actor-details/google-search-scraper',
        query: 'Scrape details of apify/google-search-scraper',
        category: 'fetch-actor-details',
        expectedTools: ['fetch-actor-details'],
        expectedArgs: { actor: 'apify/google-search-scraper' },
    },
    {
        sourceId: 'fetch-actor-details-4',
        decision: 'keep',
        id: 'fetch-actor-details/instagram-scraper-capabilities',
        query: 'What can apify/instagram-scraper do?',
        category: 'fetch-actor-details',
        expectedTools: ['fetch-actor-details'],
        expectedArgs: { actor: 'apify/instagram-scraper' },
    },
    {
        sourceId: 'fetch-actor-details-5',
        decision: 'keep',
        id: 'fetch-actor-details/rag-web-browser-how-it-works',
        query: 'How does apify/rag-web-browser work?',
        category: 'fetch-actor-details',
        expectedTools: ['fetch-actor-details'],
        expectedArgs: { actor: 'apify/rag-web-browser' },
    },
    {
        sourceId: 'fetch-actor-details-6',
        decision: 'keep',
        id: 'fetch-actor-details/instagram-scraper-pricing',
        query: 'How much does apify/instagram-scraper cost?',
        category: 'fetch-actor-details',
        expectedTools: ['fetch-actor-details'],
        expectedArgs: { actor: 'apify/instagram-scraper' },
    },
    {
        sourceId: 'fetch-actor-details-7',
        decision: 'keep',
        id: 'fetch-actor-details/instagram-scraper-parameters',
        query: 'What parameters does apify/instagram-scraper accept?',
        category: 'fetch-actor-details',
        expectedTools: ['fetch-actor-details'],
        expectedArgs: { actor: 'apify/instagram-scraper' },
    },
    {
        sourceId: 'fetch-actor-details-8',
        decision: 'keep',
        id: 'fetch-actor-details/hashtag-research-features',
        query: 'Tell me about apify/social-media-hashtag-research features',
        category: 'fetch-actor-details',
        expectedTools: ['fetch-actor-details'],
        expectedArgs: { actor: 'apify/social-media-hashtag-research' },
    },
    {
        sourceId: 'fetch-actor-details-9',
        decision: 'keep',
        id: 'fetch-actor-details/rag-web-browser-pricing',
        query: "What's the pricing model for apify/rag-web-browser?",
        category: 'fetch-actor-details',
        expectedTools: ['fetch-actor-details'],
        expectedArgs: { actor: 'apify/rag-web-browser' },
    },

    // --- search-actors (25 ported: 15 plain + 5 search-vs-rag + ambiguous-query-1 +
    // tool-selection-confusion-1 + 3 search-actors-input-args) ---
    {
        sourceId: 'search-actors-1',
        decision: 'keep',
        id: 'search-actors/instagram-posts',
        query: 'What Actors can scrape Instagram posts?',
        category: 'search-actors',
        expectedTools: ['search-actors'],
    },
    {
        sourceId: 'search-actors-2',
        decision: 'keep',
        id: 'search-actors/instagram-scrapers-best',
        query: 'What are the best Instagram scrapers?',
        category: 'search-actors',
        expectedTools: ['search-actors'],
    },
    {
        sourceId: 'search-actors-3',
        decision: 'keep',
        id: 'search-actors/social-media-scraping',
        query: 'Find actors for scraping social media',
        category: 'search-actors',
        expectedTools: ['search-actors'],
    },
    {
        sourceId: 'search-actors-4',
        decision: 'keep',
        id: 'search-actors/twitter-scraping-tools',
        query: 'Show me Twitter scraping tools',
        category: 'search-actors',
        expectedTools: ['search-actors'],
    },
    {
        sourceId: 'search-actors-5',
        decision: 'keep',
        id: 'search-actors/tiktok-content',
        query: 'What actors can scrape TikTok content?',
        category: 'search-actors',
        expectedTools: ['search-actors'],
    },
    {
        sourceId: 'search-actors-6',
        decision: 'keep',
        id: 'search-actors/facebook-data',
        query: 'Find an Actor to get Facebook data',
        category: 'search-actors',
        expectedTools: ['search-actors'],
    },
    {
        sourceId: 'search-actors-7',
        decision: 'keep',
        id: 'search-actors/news-articles',
        query: 'Find actors that can scrape news articles',
        category: 'search-actors',
        expectedTools: ['search-actors'],
    },
    {
        sourceId: 'search-actors-8',
        decision: 'keep',
        id: 'search-actors/ecommerce-data-extraction',
        query: 'What tools can extract data from e-commerce sites?',
        category: 'search-actors',
        expectedTools: ['search-actors'],
    },
    {
        sourceId: 'search-actors-9',
        decision: 'keep',
        id: 'search-actors/amazon-product-scrapers',
        query: 'Show me Amazon product scrapers',
        category: 'search-actors',
        expectedTools: ['search-actors'],
    },
    {
        // Rephrased after it failed on both `claude-opus-5` (run 2) and `claude-haiku-4-5`
        // (multiple runs) with "no tool call attempted, ToolSearch exhausted the 2-turn
        // budget" — a genuine cross-model case defect, not a Haiku-only weakness (Opus failed
        // it too). Root cause: "MCP server" is self-referential in this harness (the agent
        // itself runs as an MCP client), which sent both models down a ToolSearch detour
        // instead of committing to search-actors. Rephrased to drop "MCP server" entirely.
        sourceId: 'search-actors-10',
        decision: 'rephrase',
        id: 'search-actors/playwright-mcp-server',
        query: 'Find an Actor that can automate a headless browser using Playwright.',
        category: 'search-actors',
        expectedTools: ['search-actors'],
    },
    {
        sourceId: 'search-actors-11',
        decision: 'keep',
        id: 'search-actors/amazon-product-details',
        query: 'I need to find solution to scrape details of Amazon products',
        category: 'search-actors',
        expectedTools: ['search-actors'],
    },
    {
        sourceId: 'search-actors-12',
        decision: 'keep',
        id: 'search-actors/twitter-ai-posts',
        query: 'Find an Actor to fetch posts from Twitter about AI',
        category: 'search-actors',
        expectedTools: ['search-actors'],
    },
    {
        sourceId: 'search-actors-13',
        decision: 'keep',
        id: 'search-actors/skyscanner-flights',
        query: 'Find an Actor to get flight information from Skyscanner',
        category: 'search-actors',
        expectedTools: ['search-actors'],
    },
    {
        sourceId: 'search-actors-14',
        decision: 'keep',
        id: 'search-actors/weather-data-scraping',
        query: 'Can you find actors to scrape weather data?',
        category: 'search-actors',
        expectedTools: ['search-actors'],
    },
    {
        sourceId: 'search-actors-15',
        decision: 'keep',
        id: 'search-actors/data-extraction-tasks',
        query: 'Find actors for data extraction tasks',
        category: 'search-actors',
        expectedTools: ['search-actors'],
    },
    {
        sourceId: 'search-vs-rag-1',
        decision: 'keep',
        id: 'search-actors/instagram-posts-the-rock',
        query: 'Find posts about the Rock on Instagram',
        category: 'search-actors',
        expectedTools: ['search-actors'],
    },
    {
        sourceId: 'search-vs-rag-2',
        decision: 'keep',
        id: 'search-actors/instagram-posts-ai',
        query: 'Scrape Instagram posts about AI',
        category: 'search-actors',
        expectedTools: ['search-actors'],
    },
    {
        sourceId: 'search-vs-rag-6',
        decision: 'keep',
        id: 'search-actors/weather-scraping-tools',
        query: 'Search for weather data scraping tools',
        category: 'search-actors',
        expectedTools: ['search-actors'],
    },
    {
        sourceId: 'search-vs-rag-7b',
        decision: 'keep',
        id: 'search-actors/flight-data-booking-sites',
        query: 'Find an Actor that scrapes flight data from booking sites',
        category: 'search-actors',
        expectedTools: ['search-actors'],
    },
    {
        sourceId: 'search-vs-rag-8',
        decision: 'keep',
        id: 'search-actors/flight-data-extraction',
        query: 'Find actors for flight data extraction',
        category: 'search-actors',
        expectedTools: ['search-actors'],
    },
    {
        sourceId: 'ambiguous-query-1',
        decision: 'keep',
        id: 'search-actors/instagram-posts-generic',
        query: 'Find an Actor to get instagram posts',
        category: 'search-actors',
        expectedTools: ['search-actors'],
    },
    {
        sourceId: 'tool-selection-confusion-1',
        decision: 'keep',
        id: 'search-actors/instagram-ai-posts',
        query: 'Find posts about AI on Instagram',
        category: 'search-actors',
        expectedTools: ['search-actors'],
    },
    {
        sourceId: 'search-actors-input-args-1',
        decision: 'keep',
        id: 'search-actors/stackoverflow-quicksort',
        query: 'Use Apify to scrape StackOverflow for the top 10 most upvoted quicksort implementations in Python',
        category: 'search-actors',
        expectedTools: ['search-actors'],
    },
    {
        sourceId: 'search-actors-input-args-2',
        decision: 'keep',
        id: 'search-actors/instagram-profile-scraping',
        query: 'I need to find Actor for instagram profile scraping',
        category: 'search-actors',
        expectedTools: ['search-actors'],
    },
    {
        sourceId: 'search-actors-input-args-3',
        decision: 'keep',
        id: 'search-actors/tiktok-comments-lazy-budget',
        query:
            "I'm new to Apify, I can't really code, I need data from my project, I need tiktok comments. " +
            "I'm also price sensitive",
        category: 'search-actors',
        expectedTools: ['search-actors'],
    },

    // --- apify--rag-web-browser (12 ported: 5 kept as-is, 7 widened on the MCP-vs-MCP axis —
    // see the per-item calibration notes below for which ones and why) ---
    {
        // mcpToolsOnly added after apify/ai-team#240 iter-2's full-tier Opus run: the agent
        // burned its 2-turn selection budget on a ToolSearch detour before ever attempting
        // apify--rag-web-browser on this plain query — the same built-in-detour failure mode
        // documented for report-problem and the other rag-web-browser/create-actor-task items
        // above, just probabilistic rather than deterministic.
        sourceId: 'rag-web-browser-1',
        decision: 'keep',
        id: 'apify--rag-web-browser/ai-blog-articles',
        query: 'Get recent articles about AI from tech blogs',
        category: 'apify--rag-web-browser',
        expectedTools: ['apify--rag-web-browser'],
        mcpToolsOnly: true,
    },
    {
        sourceId: 'rag-web-browser-2',
        decision: 'keep',
        id: 'apify--rag-web-browser/climate-change-articles',
        query: 'Fetch recent articles about climate change',
        category: 'apify--rag-web-browser',
        expectedTools: ['apify--rag-web-browser'],
    },
    {
        sourceId: 'rag-web-browser-3',
        decision: 'keep',
        id: 'apify--rag-web-browser/sf-weather-forecast',
        query: 'Get the latest weather forecast for San Francisco',
        category: 'apify--rag-web-browser',
        expectedTools: ['apify--rag-web-browser'],
    },
    {
        // Rephrased: "Get data from example.com" reads as a single-URL fetch (apify--web-fetch,
        // already the live item "web-fetch/example-com"'s exact axis), not a rag-web-browser
        // query — a second legitimate tool would make this an unwinnable case. Rewritten to an
        // open-ended retrieval query with no single URL named. Widened to search-actors after
        // Opus calibration (2026-09-06): "what people are saying online" reads as social-
        // platform sentiment, and Opus reasonably reached for search-actors (a Reddit/social
        // scraper) as its first move — a defensible second answer on the same MCP-vs-MCP axis
        // as the other widened items here.
        sourceId: 'rag-web-browser-4',
        decision: 'widen',
        id: 'apify--rag-web-browser/iphone-launch-reactions',
        query: 'Find out what people are saying online about the new iPhone launch',
        category: 'apify--rag-web-browser',
        expectedTools: ['apify--rag-web-browser', 'search-actors'],
        mcpToolsOnly: true,
    },
    {
        // mcpToolsOnly added after apify/ai-team#240 iter-2's full-tier Opus run: intermittently
        // (1/3 on a targeted reproduction) the agent burned its 2-turn selection budget on a
        // ToolSearch detour before ever attempting apify--rag-web-browser, on this plain,
        // unambiguous query — the same built-in-detour failure mode documented for
        // report-problem, just probabilistic here instead of deterministic. Dropping built-ins
        // removes the detour entirely (verified below).
        sourceId: 'rag-web-browser-5',
        decision: 'keep',
        id: 'apify--rag-web-browser/tech-industry-news',
        query: 'Get the latest tech industry news',
        category: 'apify--rag-web-browser',
        expectedTools: ['apify--rag-web-browser'],
        mcpToolsOnly: true,
    },
    {
        sourceId: 'misleading-query-1',
        decision: 'keep',
        id: 'apify--rag-web-browser/sf-weather-today',
        query: "What's the weather like today in San Francisco?",
        category: 'apify--rag-web-browser',
        expectedTools: ['apify--rag-web-browser'],
    },
    {
        sourceId: 'search-vs-rag-3',
        decision: 'widen',
        id: 'apify--rag-web-browser/ai-articles-tech-blogs',
        query: 'Get recent AI articles on tech blogs',
        category: 'apify--rag-web-browser',
        expectedTools: ['apify--rag-web-browser', 'search-actors'],
        mcpToolsOnly: true,
    },
    {
        // Rephrased off the two named outlets after Opus calibration (2026-09-06): "from Wired
        // and The Verge" reads as two known URLs, and Opus called apify--web-fetch directly on
        // wired.com's tag page — a third legitimate tool this item didn't list. Rewritten to a
        // generic-publications phrasing (matching the un-widened rag-web-browser/* items above,
        // which pass this way) so only the rag-vs-search-actors axis stays in play.
        sourceId: 'search-vs-rag-4',
        decision: 'widen',
        id: 'apify--rag-web-browser/ai-articles-wired-verge',
        query: 'Get current articles about AI from major tech publications',
        category: 'apify--rag-web-browser',
        expectedTools: ['apify--rag-web-browser', 'search-actors'],
        mcpToolsOnly: true,
    },
    {
        sourceId: 'search-vs-rag-5',
        decision: 'widen',
        id: 'apify--rag-web-browser/ny-weather-forecast',
        query: 'Get the latest weather forecast for New York',
        category: 'apify--rag-web-browser',
        expectedTools: ['apify--rag-web-browser', 'search-actors'],
        mcpToolsOnly: true,
    },
    {
        sourceId: 'search-vs-rag-7a',
        decision: 'widen',
        id: 'apify--rag-web-browser/flight-prices-nyc-london',
        query: 'Get flight prices from New York to London for tomorrow',
        category: 'apify--rag-web-browser',
        expectedTools: ['apify--rag-web-browser', 'search-actors'],
        mcpToolsOnly: true,
    },
    {
        sourceId: 'search-vs-rag-9',
        decision: 'widen',
        id: 'apify--rag-web-browser/ai-news-current',
        query: 'Fetch current news articles on AI',
        category: 'apify--rag-web-browser',
        expectedTools: ['apify--rag-web-browser', 'search-actors'],
        mcpToolsOnly: true,
    },
    {
        sourceId: 'search-vs-rag-10',
        decision: 'widen',
        id: 'apify--rag-web-browser/news-cnn-bbc',
        query: 'Fetch AI-related news from CNN and BBC',
        category: 'apify--rag-web-browser',
        expectedTools: ['apify--rag-web-browser', 'search-actors'],
        mcpToolsOnly: true,
    },

    // --- call-actor (6 ported). Widened to accept fetch-actor-details: calibrated on Opus
    // (2026-09-06), which checked the Actor's input schema via fetch-actor-details before
    // calling it in 5 of 6 cases — a defensible "check before you spend" pattern for a
    // resource-creating call, not a wrong tool. expectedArgs dropped (would otherwise still pin
    // the shared `actor` key correctly, but expectedTools now names 2 tools). ---
    {
        sourceId: 'call-actor-1',
        decision: 'widen',
        id: 'call-actor/instagram-scraper-hashtag',
        query: 'Run apify/instagram-scraper to scrape #dwaynejohnson',
        category: 'call-actor',
        expectedTools: ['call-actor', 'fetch-actor-details'],
    },
    {
        sourceId: 'call-actor-2',
        decision: 'widen',
        id: 'call-actor/tweet-scraper-profiles',
        query: 'Run apidojo/tweet-scraper to scrape twitter profiles',
        category: 'call-actor',
        expectedTools: ['call-actor', 'fetch-actor-details'],
    },
    {
        sourceId: 'call-actor-3',
        decision: 'widen',
        id: 'call-actor/google-search-restaurants',
        query: 'Call apify/google-search-scraper to find restaurants in London',
        category: 'call-actor',
        expectedTools: ['call-actor', 'fetch-actor-details'],
    },
    {
        sourceId: 'call-actor-4',
        decision: 'widen',
        id: 'call-actor/hashtag-research-ai',
        query: 'Run apify/social-media-hashtag-research for #AI',
        category: 'call-actor',
        expectedTools: ['call-actor', 'fetch-actor-details'],
    },
    {
        sourceId: 'call-actor-5',
        decision: 'widen',
        id: 'call-actor/ecommerce-scraper-iphone',
        query: 'Scrape iPhone15 at Amazon using apify/e-commerce-scraping-tool',
        category: 'call-actor',
        expectedTools: ['call-actor', 'fetch-actor-details'],
    },
    {
        sourceId: 'call-actor-6',
        decision: 'widen',
        id: 'call-actor/weather-scraper-nyc',
        query: 'Call epctex/weather-scraper for New York',
        category: 'call-actor',
        expectedTools: ['call-actor', 'fetch-actor-details'],
    },
];

// ---------------------------------------------------------------------------
// Wave 2: docs (search-apify-docs, fetch-apify-docs)
// ---------------------------------------------------------------------------

const DOCS_WAVE: PortCaseSpec[] = [
    {
        sourceId: 'search-apify-docs-1',
        decision: 'keep',
        id: 'search-apify-docs/build-actor-guide',
        query: 'How to build an Apify Actor',
        category: 'search-apify-docs',
        expectedTools: ['search-apify-docs'],
    },
    {
        sourceId: 'search-apify-docs-2',
        decision: 'keep',
        id: 'search-apify-docs/input-schema-examples',
        query: 'Ho to define Actor input schema, provide examples',
        category: 'search-apify-docs',
        expectedTools: ['search-apify-docs'],
    },
    {
        sourceId: 'search-apify-docs-3',
        decision: 'keep',
        id: 'search-apify-docs/playwright-with-apify',
        query: 'How to use Playwright library with Apify',
        category: 'search-apify-docs',
        expectedTools: ['search-apify-docs'],
    },
    {
        sourceId: 'search-apify-docs-4',
        decision: 'keep',
        id: 'search-apify-docs/mcp-server-docs',
        query: 'Is there documentation for the Apify MCP server?',
        category: 'search-apify-docs',
        expectedTools: ['search-apify-docs'],
    },
    {
        sourceId: 'search-apify-docs-5',
        decision: 'keep',
        id: 'search-apify-docs/apify-proxy-usage',
        query: 'How to use Apify Proxy',
        category: 'search-apify-docs',
        expectedTools: ['search-apify-docs'],
    },
    {
        sourceId: 'search-apify-docs-6',
        decision: 'keep',
        id: 'search-apify-docs/crawlee-web-scraping',
        query: 'How to do web scraping with Crawlee in the Apify docs',
        category: 'search-apify-docs',
        expectedTools: ['search-apify-docs'],
    },
    {
        // Rephrased after Opus calibration (2026-09-06): the bare noun phrase read as an open
        // request for integration help (Opus asked which language/client to target and whether
        // to write code), not a docs lookup. Rewritten as an explicit "find/search the docs"
        // request, which only search-apify-docs fits.
        sourceId: 'search-apify-docs-7',
        decision: 'rephrase',
        id: 'search-apify-docs/api-integration-guide',
        query: 'Search the Apify docs for the API integration guide',
        category: 'search-apify-docs',
        expectedTools: ['search-apify-docs'],
    },
    {
        sourceId: 'search-apify-docs-8',
        decision: 'keep',
        id: 'search-apify-docs/error-handling-actors',
        query: 'Error handling in Actors',
        category: 'search-apify-docs',
        expectedTools: ['search-apify-docs'],
    },
    {
        sourceId: 'misleading-query-3',
        decision: 'keep',
        id: 'search-apify-docs/build-actor-from-scratch',
        query: 'How do I build my own Apify Actor from scratch?',
        category: 'search-apify-docs',
        expectedTools: ['search-apify-docs'],
    },
    {
        // category "ambiguous" is not a tool name (the design's 2nd id-scheme exception):
        // <category> comes from expectedTools[0] instead.
        sourceId: 'ambiguous-query-3',
        decision: 'keep',
        id: 'search-apify-docs/actor-docs-overview',
        query: 'Show me Apify Actor documentation',
        category: 'search-apify-docs',
        expectedTools: ['search-apify-docs'],
    },
    {
        // Rephrased after "Get configuration info from: <url>" pulled `apify--web-fetch` instead
        // of `fetch-apify-docs` on both `claude-haiku-4-5` (pre-series run) and `claude-opus-5`
        // (confirmation run after the playwright-mcp-server fix) — a genuine cross-model case
        // defect, not a Haiku-only weakness. Root cause: the query read as generic "fetch this
        // URL," which is exactly `apify--web-fetch`'s job description, with nothing marking the
        // target as Apify's own docs. Rephrased to frame it as a docs lookup.
        sourceId: 'fetch-apify-docs-1',
        decision: 'rephrase',
        id: 'fetch-apify-docs/mcp-integration-page',
        query: 'What does the Apify docs page at https://docs.apify.com/platform/integrations/mcp say?',
        category: 'fetch-apify-docs',
        expectedTools: ['fetch-apify-docs'],
        expectedArgs: { url: 'https://docs.apify.com/platform/integrations/mcp' },
    },
    {
        // Same fix as above, same root cause — this one failed on `claude-opus-5`'s
        // confirmation run directly (see the sibling case's comment for the full story).
        sourceId: 'fetch-apify-docs-edge-1',
        decision: 'rephrase',
        id: 'fetch-apify-docs/nonexistent-page',
        query: 'Check the Apify docs for this page: https://docs.apify.com/nonexistent-page',
        category: 'fetch-apify-docs',
        expectedTools: ['fetch-apify-docs'],
        expectedArgs: { url: 'https://docs.apify.com/nonexistent-page' },
    },
];

// ---------------------------------------------------------------------------
// Wave 3: tasks (get-actor-task, create-actor-task, update-actor-task, publish-actor-task,
// unpublish-actor-task) — all need `tools: ["tasks"]`, none of the 5 task tools is default-served.
// ---------------------------------------------------------------------------

const TASKS_WAVE: PortCaseSpec[] = [
    {
        sourceId: 'get-actor-task-1',
        decision: 'keep',
        id: 'get-actor-task/insta-daily-config',
        query: 'What is the configuration of my task insta-daily?',
        category: 'get-actor-task',
        expectedTools: ['get-actor-task'],
        expectedArgs: { taskId: 'insta-daily' },
        tools: ['tasks'],
    },
    {
        sourceId: 'get-actor-task-2',
        decision: 'keep',
        id: 'get-actor-task/insta-daily-published',
        query: 'Is my task insta-daily published?',
        category: 'get-actor-task',
        expectedTools: ['get-actor-task'],
        expectedArgs: { taskId: 'insta-daily' },
        tools: ['tasks'],
    },
    {
        // Rephrased twice after calibration (2026-09-06). First pass ("just create it
        // directly") didn't hold on either Opus or Haiku — the real defect was "my ...
        // settings", which references pre-existing settings the agent was never given (the
        // skill's "query references context the agent can't obtain" failure mode), inviting a
        // clarifying question instead of a tool call. Rewritten as a fully self-contained
        // create request with nothing left to ask about.
        sourceId: 'create-actor-task-1',
        decision: 'rephrase',
        id: 'create-actor-task/instagram-insta-daily',
        query: 'Create a task called insta-daily that runs apify/instagram-scraper — just create it directly.',
        category: 'create-actor-task',
        expectedTools: ['create-actor-task'],
        expectedArgs: { actorId: 'apify/instagram-scraper', name: 'insta-daily' },
        tools: ['tasks'],
    },
    {
        // Strengthened for the same reason as create-actor-task-1. mcpToolsOnly added after
        // apify/ai-team#240 iter-2's full-tier Opus run: intermittently (1/3 on a targeted
        // reproduction) the agent burned its 2-turn selection budget on a ToolSearch detour
        // before ever attempting create-actor-task — the same built-in-detour failure mode
        // documented for report-problem, just probabilistic here instead of deterministic.
        // Dropping built-ins removes the detour entirely (verified below).
        sourceId: 'create-actor-task-2',
        decision: 'rephrase',
        id: 'create-actor-task/google-search-pizza',
        query: 'Create a task for apify/google-search-scraper that searches for pizza — just create it directly.',
        category: 'create-actor-task',
        expectedTools: ['create-actor-task'],
        expectedArgs: { actorId: 'apify/google-search-scraper' },
        tools: ['tasks'],
        mcpToolsOnly: true,
    },
    // --- update/publish/unpublish-actor-task: all widened to accept get-actor-task after Opus
    // calibration (2026-09-06), which checked the task's current state via get-actor-task
    // before mutating it in 9 of 10 cases — a defensible "read before write" pattern for a
    // mutating call, not a wrong tool (the same reasoning as the call-actor widening above).
    // expectedArgs dropped (would otherwise still pin the shared `taskId` key correctly, but
    // expectedTools now names 2 tools per item). ---
    {
        sourceId: 'update-actor-task-1',
        decision: 'widen',
        id: 'update-actor-task/insta-daily-beta-build',
        query: 'Change my task insta-daily to use the beta build',
        category: 'update-actor-task',
        expectedTools: ['update-actor-task', 'get-actor-task'],
        tools: ['tasks'],
    },
    {
        sourceId: 'update-actor-task-2',
        decision: 'widen',
        id: 'update-actor-task/insta-daily-landing-title',
        query: "Set the landing page title of my task insta-daily to 'Daily Instagram scraper'",
        category: 'update-actor-task',
        expectedTools: ['update-actor-task', 'get-actor-task'],
        tools: ['tasks'],
    },
    {
        // category "tool-selection" is not a tool name: <category> comes from expectedTools[0].
        sourceId: 'tool-selection-actor-task-1',
        decision: 'widen',
        id: 'update-actor-task/publish-view-setup',
        query: 'Set up my task insta-daily for publishing, using the overview dataset view',
        category: 'update-actor-task',
        expectedTools: ['update-actor-task', 'get-actor-task'],
        tools: ['tasks'],
    },
    {
        sourceId: 'tool-selection-actor-task-2',
        decision: 'widen',
        id: 'update-actor-task/insta-daily-change-input',
        query: 'I already have a task called insta-daily, change its input to search for cats instead',
        category: 'update-actor-task',
        expectedTools: ['update-actor-task', 'get-actor-task'],
        tools: ['tasks'],
    },
    {
        sourceId: 'publish-actor-task-1',
        decision: 'widen',
        id: 'publish-actor-task/insta-daily',
        query: 'Publish my task insta-daily',
        category: 'publish-actor-task',
        expectedTools: ['publish-actor-task', 'get-actor-task'],
        tools: ['tasks'],
    },
    {
        sourceId: 'publish-actor-task-2',
        decision: 'widen',
        id: 'publish-actor-task/insta-daily-make-public',
        query: 'Make my task insta-daily public',
        category: 'publish-actor-task',
        expectedTools: ['publish-actor-task', 'get-actor-task'],
        tools: ['tasks'],
    },
    {
        // Rephrased: the old `context` field simulated a prior failed publish-actor-task call.
        // Selection scoring only looks at the first tool call, so the prior-turn fact is
        // scoring-irrelevant and drops cleanly — the query already states the resolved state.
        // Also widened per the get-actor-task note above.
        sourceId: 'publish-actor-task-3',
        decision: 'widen',
        id: 'publish-actor-task/write-access-granted',
        query: 'I now have write access to my task insta-daily and its Actor now — publish it.',
        category: 'publish-actor-task',
        expectedTools: ['publish-actor-task', 'get-actor-task'],
        tools: ['tasks'],
    },
    {
        // Rephrased for the same reason as publish-actor-task-3. Category stays "publish-
        // actor-task" (the source case's own category field, a real tool name) even though
        // expectedTools names update-actor-task — the id rule only re-homes the two non-tool
        // categories (tool-selection, ambiguous), and metadata.category is a filter label, not
        // a promise it matches expectedTools. Also widened per the get-actor-task note above.
        sourceId: 'publish-actor-task-4',
        decision: 'widen',
        id: 'publish-actor-task/query-input-overview-view',
        query:
            "Set up my task insta-daily's public page with the query input field and the overview dataset " +
            'view before I publish it.',
        category: 'publish-actor-task',
        expectedTools: ['update-actor-task', 'get-actor-task'],
        tools: ['tasks'],
    },
    {
        sourceId: 'unpublish-actor-task-1',
        decision: 'widen',
        id: 'unpublish-actor-task/insta-daily',
        query: 'Unpublish my task insta-daily',
        category: 'unpublish-actor-task',
        expectedTools: ['unpublish-actor-task', 'get-actor-task'],
        tools: ['tasks'],
    },
    {
        sourceId: 'unpublish-actor-task-2',
        decision: 'widen',
        id: 'unpublish-actor-task/insta-daily-keep-display-settings',
        query: 'Take my task insta-daily off its public page but keep its display settings',
        category: 'unpublish-actor-task',
        expectedTools: ['unpublish-actor-task', 'get-actor-task'],
        tools: ['tasks'],
    },
];

// ---------------------------------------------------------------------------
// Wave 4: storage (get-dataset-items, get-dataset, get-dataset-schema, get-dataset-list,
// get-key-value-store-record, get-key-value-store-keys, get-key-value-store,
// get-key-value-store-list). get-dataset-items and get-key-value-store-record are
// auto-injected (default-served); the other 6 need `tools: ["storage"]`.
// ---------------------------------------------------------------------------

const STORAGE_WAVE: PortCaseSpec[] = [
    {
        sourceId: 'get-dataset-items-1',
        decision: 'keep',
        id: 'get-dataset-items/latest-run-output',
        query: 'Get output from my latest actor with datasetId des32s',
        category: 'get-dataset-items',
        expectedTools: ['get-dataset-items'],
        expectedArgs: { datasetId: 'des32s' },
    },
    {
        sourceId: 'get-dataset-items-2',
        decision: 'keep',
        id: 'get-dataset-items/retrieve-results',
        query: 'Retrieve results from dataset abc123',
        category: 'get-dataset-items',
        expectedTools: ['get-dataset-items'],
        expectedArgs: { datasetId: 'abc123' },
    },
    {
        sourceId: 'get-dataset-items-3',
        decision: 'keep',
        id: 'get-dataset-items/instagram-run-data',
        query: 'Show me the data from my Instagram scraper run with datasetId d23d2',
        category: 'get-dataset-items',
        expectedTools: ['get-dataset-items'],
        expectedArgs: { datasetId: 'd23d2' },
    },
    {
        sourceId: 'get-dataset-items-4',
        decision: 'keep',
        id: 'get-dataset-items/first-50-items',
        query: 'Get the first 50 items from my datasetId abc123',
        category: 'get-dataset-items',
        expectedTools: ['get-dataset-items'],
        expectedArgs: { datasetId: 'abc123' },
    },
    {
        sourceId: 'get-dataset-items-5',
        decision: 'keep',
        id: 'get-dataset-items/all-web-scraper-results',
        query: 'Retrieve all results from my web scraper with datasetID abc123',
        category: 'get-dataset-items',
        expectedTools: ['get-dataset-items'],
        expectedArgs: { datasetId: 'abc123' },
    },
    {
        sourceId: 'get-dataset-items-6',
        decision: 'keep',
        id: 'get-dataset-items/select-title-url-fields',
        query: 'Retrieve only the title and url fields from dataset UvsU',
        category: 'get-dataset-items',
        expectedTools: ['get-dataset-items'],
        expectedArgs: { datasetId: 'UvsU' },
    },
    {
        sourceId: 'get-dataset-items-basic-2',
        decision: 'keep',
        id: 'get-dataset-items/query-markdown-fields',
        query: 'Get query and markdown fields from dataset UvsU',
        category: 'get-dataset-items',
        expectedTools: ['get-dataset-items'],
        expectedArgs: { datasetId: 'UvsU' },
    },
    {
        sourceId: 'get-dataset-1',
        decision: 'keep',
        id: 'get-dataset/item-count',
        query: 'How many items are in dataset abc123?',
        category: 'get-dataset',
        expectedTools: ['get-dataset'],
        expectedArgs: { datasetId: 'abc123' },
        tools: ['storage'],
    },
    {
        sourceId: 'get-dataset-2',
        decision: 'keep',
        id: 'get-dataset/metadata-stats',
        query: 'Show me the metadata and stats for dataset des32s',
        category: 'get-dataset',
        expectedTools: ['get-dataset'],
        expectedArgs: { datasetId: 'des32s' },
        tools: ['storage'],
    },
    {
        sourceId: 'get-dataset-3',
        decision: 'keep',
        id: 'get-dataset/fields-list',
        query: 'What fields does dataset UvsU contain?',
        category: 'get-dataset',
        expectedTools: ['get-dataset'],
        expectedArgs: { datasetId: 'UvsU' },
        tools: ['storage'],
    },
    {
        sourceId: 'get-dataset-schema-1',
        decision: 'keep',
        id: 'get-dataset-schema/basic-schema',
        query: 'What is the schema of dataset abc123?',
        category: 'get-dataset-schema',
        expectedTools: ['get-dataset-schema'],
        expectedArgs: { datasetId: 'abc123' },
        tools: ['storage'],
    },
    {
        sourceId: 'get-dataset-schema-2',
        decision: 'keep',
        id: 'get-dataset-schema/generate-from-10-items',
        query: 'Generate a JSON schema for dataset des32s using 10 items',
        category: 'get-dataset-schema',
        expectedTools: ['get-dataset-schema'],
        expectedArgs: { datasetId: 'des32s', limit: 10 },
        tools: ['storage'],
    },
    {
        sourceId: 'get-dataset-schema-3',
        decision: 'keep',
        id: 'get-dataset-schema/infer-structure',
        query: 'Infer the structure of the items in dataset UvsU',
        category: 'get-dataset-schema',
        expectedTools: ['get-dataset-schema'],
        expectedArgs: { datasetId: 'UvsU' },
        tools: ['storage'],
    },
    {
        // mcpToolsOnly added after apify/ai-team#240 iter-2's full-tier Opus run: the agent
        // burned its 2-turn selection budget on a ToolSearch detour before ever attempting
        // get-dataset-list on this plain query — the same built-in-detour failure mode
        // documented for report-problem above, just probabilistic rather than deterministic.
        sourceId: 'get-dataset-list-1',
        decision: 'keep',
        id: 'get-dataset-list/list-all',
        query: 'List all my datasets',
        category: 'get-dataset-list',
        expectedTools: ['get-dataset-list'],
        tools: ['storage'],
        mcpToolsOnly: true,
    },
    {
        sourceId: 'get-dataset-list-2',
        decision: 'keep',
        id: 'get-dataset-list/account-datasets',
        query: 'What datasets do I have in my account?',
        category: 'get-dataset-list',
        expectedTools: ['get-dataset-list'],
        tools: ['storage'],
    },
    {
        sourceId: 'get-dataset-list-3',
        decision: 'keep',
        id: 'get-dataset-list/last-10-newest-first',
        query: 'Show me my last 10 datasets, newest first',
        category: 'get-dataset-list',
        expectedTools: ['get-dataset-list'],
        tools: ['storage'],
    },
    {
        sourceId: 'get-key-value-store-record-1',
        decision: 'keep',
        id: 'get-key-value-store-record/input-record',
        query: 'Get record INPUT from key-value store abc123',
        category: 'get-key-value-store-record',
        expectedTools: ['get-key-value-store-record'],
        expectedArgs: { keyValueStoreId: 'abc123', recordKey: 'INPUT' },
    },
    {
        sourceId: 'get-key-value-store-record-2',
        decision: 'keep',
        id: 'get-key-value-store-record/output-record',
        query: 'Read the value under key OUTPUT in key-value store des32s',
        category: 'get-key-value-store-record',
        expectedTools: ['get-key-value-store-record'],
        expectedArgs: { keyValueStoreId: 'des32s', recordKey: 'OUTPUT' },
    },
    {
        sourceId: 'get-key-value-store-record-3',
        decision: 'keep',
        id: 'get-key-value-store-record/data-json-record',
        query: 'Fetch the contents of key data.json from store UvsU',
        category: 'get-key-value-store-record',
        expectedTools: ['get-key-value-store-record'],
        expectedArgs: { keyValueStoreId: 'UvsU', recordKey: 'data.json' },
    },
    {
        sourceId: 'get-key-value-store-keys-1',
        decision: 'keep',
        id: 'get-key-value-store-keys/list-keys',
        query: 'List the keys in key-value store abc123',
        category: 'get-key-value-store-keys',
        expectedTools: ['get-key-value-store-keys'],
        expectedArgs: { keyValueStoreId: 'abc123' },
        tools: ['storage'],
    },
    {
        sourceId: 'get-key-value-store-keys-2',
        decision: 'keep',
        id: 'get-key-value-store-keys/which-keys-stored',
        query: 'What keys are stored in my key-value store des32s?',
        category: 'get-key-value-store-keys',
        expectedTools: ['get-key-value-store-keys'],
        expectedArgs: { keyValueStoreId: 'des32s' },
        tools: ['storage'],
    },
    {
        sourceId: 'get-key-value-store-1',
        decision: 'keep',
        id: 'get-key-value-store/metadata',
        query: 'Show me the metadata for key-value store abc123',
        category: 'get-key-value-store',
        expectedTools: ['get-key-value-store'],
        expectedArgs: { keyValueStoreId: 'abc123' },
        tools: ['storage'],
    },
    {
        sourceId: 'get-key-value-store-2',
        decision: 'keep',
        id: 'get-key-value-store/details',
        query: 'Get details about key-value store des32s',
        category: 'get-key-value-store',
        expectedTools: ['get-key-value-store'],
        expectedArgs: { keyValueStoreId: 'des32s' },
        tools: ['storage'],
    },
    {
        sourceId: 'get-key-value-store-list-1',
        decision: 'keep',
        id: 'get-key-value-store-list/list-all',
        query: 'List all my key-value stores',
        category: 'get-key-value-store-list',
        expectedTools: ['get-key-value-store-list'],
        tools: ['storage'],
    },
    {
        sourceId: 'get-key-value-store-list-2',
        decision: 'keep',
        id: 'get-key-value-store-list/account-stores',
        query: 'What key-value stores do I have in my account?',
        category: 'get-key-value-store-list',
        expectedTools: ['get-key-value-store-list'],
        tools: ['storage'],
    },
];

// ---------------------------------------------------------------------------
// Wave 5: runs — 3 brand-new cases. The old suite has zero cases for these tools (no
// `abort-actor-run`/`get-actor-log`/`get-actor-run-list` category ever existed in
// test_cases.json), so there is nothing to port; these fill the coverage floor.
//
// `report-problem` is deliberately NOT in this wave. It was authored and calibrated here
// (apify/ai-team#240 iter-2) but never cleared claude-opus-5 3/3 across 3 query attempts:
//   1. Base query + `mcpToolsOnly: true` (removes Claude Code's built-ins, ToolSearch
//      included, so the agent sees report-problem directly): 0/3, all "no tool call attempted".
//   2. Rephrase framing the bug as already reproduced ("I've already confirmed this is a bug
//      on their end... don't investigate further"): 0/3 — 2 "no tool call attempted", 1 called
//      `search-actors` to look up "TikTok" despite the explicit instruction not to.
//   3. Rephrase naming the Actor id directly (`apify/tiktok-scraper`) so nothing needed
//      resolving: 0/3, all "no tool call attempted".
// Every attempt spends the fixed 2-turn selection budget without ever attempting
// report-problem, or investigates instead. This is a structural gap, not a case defect this
// PR's scope can fix (no touching `SELECTION_MAX_TURNS` or the tool description) — the
// coverage floor's 25th tool identifier is uncovered on purpose; see `KNOWN_UNCOVERED_TOOLS`
// in `tests/unit/evals.port_selection_cases.test.ts` and the README's "pr tier" section for
// the 3 run URLs. The item was upserted then archived (not deleted) in the `mcp-server-evals`
// Langfuse dataset, with this reason recorded in its metadata, for anyone who wants to pick
// the problem back up.
// ---------------------------------------------------------------------------

const RUNS_WAVE: PortCaseSpec[] = [
    {
        // Rephrased after Opus calibration (2026-09-06): the original wording ("has been
        // running way longer than it should — stop it") left room for a cautious first check
        // (Opus called get-actor-run to see its current status before aborting). Made explicit
        // that the status is already known and no check is wanted (the same "don't verify
        // first" pattern that the archived report-problem case above needed but never cleared
        // Opus on).
        decision: 'new',
        id: 'abort-actor-run/stuck-run',
        query:
            "My Actor run y2h7sK3Wc is definitely stuck — I've already checked, it's been " +
            "running for hours with no progress. Don't check on it, just abort it now.",
        category: 'abort-actor-run',
        expectedTools: ['abort-actor-run'],
        // No `tools` metadata: abort-actor-run is auto-injected whenever call-actor is present,
        // which it always is by default.
    },
    {
        decision: 'new',
        id: 'get-actor-log/debug-failed-run',
        query: 'Show me the last 20 log lines for Actor run y2h7sK3Wc — I need to see why it failed.',
        category: 'get-actor-log',
        expectedTools: ['get-actor-log'],
        tools: ['runs'],
    },
    {
        decision: 'new',
        id: 'get-actor-run-list/recent-runs',
        query: 'List my last 10 Actor runs, most recent first.',
        category: 'get-actor-run-list',
        expectedTools: ['get-actor-run-list'],
        tools: ['runs'],
    },
];

// ---------------------------------------------------------------------------
// Wave 6: lazy-user — typos, vague goals, missing parameters, wrong/nonexistent Actor names.
// Selection scoring stays deterministic on sloppy queries: none of these change which tool is
// correct, only whether the model resolves it cleanly.
// ---------------------------------------------------------------------------

const LAZY_USER_WAVE: PortCaseSpec[] = [
    {
        // Typo in the Actor name.
        decision: 'new',
        id: 'fetch-actor-details/typo-actor-name',
        query: 'What can apify/instagarm-scraper do?',
        category: 'fetch-actor-details',
        expectedTools: ['fetch-actor-details'],
    },
    {
        // Vague goal: no Actor named — vague about which Actor, not about the target site, so
        // there's still a single deterministic first move (discover an Actor). Rephrased after
        // Opus calibration (2026-09-06): the original wording was vague about the target too
        // ("not sure exactly what"), and Opus reasonably asked clarifying questions instead of
        // picking a tool — a defensible response to genuine ambiguity, but selection mode has
        // no room for a clarifying turn. Naming a concrete target while keeping the *tool*
        // choice vague preserves the "lazy user" mode without inviting a question back.
        decision: 'new',
        id: 'search-actors/vague-scraping-need',
        query: "I want to scrape LinkedIn profiles but I don't know which Actor to use for that.",
        category: 'search-actors',
        expectedTools: ['search-actors'],
    },
    {
        // Missing parameter: no line count given. get-actor-log has a sane default (its `lines`
        // parameter is optional), so this doesn't require the agent to stop and ask first.
        decision: 'new',
        id: 'get-actor-log/missing-line-count',
        query: 'Show me the log for Actor run y2h7sK3Wc.',
        category: 'get-actor-log',
        expectedTools: ['get-actor-log'],
        tools: ['runs'],
    },
    {
        // Wrong/nonexistent Actor name: a garbled or non-existent name doesn't change which
        // tool is correct — the agent still attempts fetch-actor-details with the literal name.
        decision: 'new',
        id: 'fetch-actor-details/nonexistent-actor',
        query: 'What does apify/totally-made-up-actor-xyz do?',
        category: 'fetch-actor-details',
        expectedTools: ['fetch-actor-details'],
    },
];

/** All ported + new cases, grouped by wave (actors, docs, tasks, storage, runs, lazy-user). */
export const PORT_SELECTION_CASES: PortCaseSpec[] = [
    ...ACTORS_WAVE,
    ...DOCS_WAVE,
    ...TASKS_WAVE,
    ...STORAGE_WAVE,
    ...RUNS_WAVE,
    ...LAZY_USER_WAVE,
];
