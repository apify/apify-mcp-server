import { isIP } from 'node:net';

import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';

/** Increment when an input mapping, restriction, or execution limit changes; approvals bind to this version. */
export const CURATED_ACTOR_CONTRACT_VERSION = 1;
export const CURATED_ACTOR_LIMITS = Object.freeze({
    timeoutSecs: 300,
    memoryMbytes: 4096,
    maxTotalChargeUsd: 1,
    maxPaidItems: 50,
});

/** Checks URL syntax only. DNS resolution and redirects require separate review of the pinned Actor. */
function isAllowedUrlSyntax(value: string, domains?: readonly string[]): boolean {
    try {
        const url = new URL(value);
        const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return false;
        if (isIP(hostname) || hostname.includes(':') || !hostname.includes('.')) return false;
        if (['localhost', 'local', 'internal', 'test', 'invalid'].some((suffix) => hostname.endsWith(`.${suffix}`)))
            return false;
        return !domains || domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
    } catch {
        return false;
    }
}

function buildUrlValidator(domains?: readonly string[]) {
    return z
        .string()
        .min(1)
        .max(2048)
        .refine((value) => isAllowedUrlSyntax(value, domains), {
            message: domains
                ? 'Use a public HTTP(S) URL on the supported website, without credentials or a custom port.'
                : 'Use a public HTTP(S) URL without credentials, an IP address, or a custom port.',
        })
        .describe(domains ? `Public HTTP(S) URL on ${domains.join(', ')}.` : 'Public HTTP(S) URL.');
}

const SearchTextValidator = z.string().trim().min(1).max(500);
const ResultLimitValidator = z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(10)
    .describe('Maximum results per input, from 1 to 20.');
const WaitSecsValidator = z
    .number()
    .int()
    .min(0)
    .max(45)
    .default(30)
    .describe('Seconds to wait for this run, from 0 to 45.');

const DateRangeValidator = z
    .strictObject({ from: z.iso.date(), to: z.iso.date() })
    .refine(({ from, to }) => from <= to, { message: 'The start date must not be later than the end date.' })
    .describe('Date bounds in YYYY-MM-DD format, with from no later than to.');
const BookingStayValidator = z
    .strictObject({ checkIn: z.iso.date(), checkOut: z.iso.date() })
    .refine(
        ({ checkIn, checkOut }) => {
            const nights = (Date.parse(checkOut) - Date.parse(checkIn)) / 86_400_000;
            return nights >= 1 && nights <= 30;
        },
        { message: 'The stay must be between 1 and 30 nights.' },
    )
    .describe('Check-in and check-out dates in YYYY-MM-DD format, for a stay of 1 to 30 nights.');

export type CuratedActorPolicy = {
    name: string;
    actorId: string;
    actorName: string;
    title: string;
    description: string;
    validator: z.ZodType<Record<string, unknown>>;
    buildInput: (args: Record<string, unknown>) => Record<string, unknown>;
};

function createPolicy<Shape extends z.ZodRawShape>(config: {
    name: string;
    actorId: string;
    actorName: string;
    title: string;
    description: string;
    shape: Shape;
    buildInput: (args: z.infer<z.ZodObject<Shape>>) => Record<string, unknown>;
}): CuratedActorPolicy {
    return {
        name: config.name,
        actorId: config.actorId,
        actorName: config.actorName,
        title: config.title,
        description: config.description,
        validator: z.strictObject({ ...config.shape, waitSecs: WaitSecsValidator }),
        // The factory pairs the mapping with its validator, which parses before this function is called.
        buildInput: (args) => config.buildInput(args as z.infer<z.ZodObject<Shape>>),
    };
}

/** Each mapping constructs its complete input; caller objects are never spread into an Actor run. */
export const CURATED_ACTOR_POLICIES: readonly CuratedActorPolicy[] = [
    createPolicy({
        name: HELPER_TOOLS.CHATGPT_WEB_SEARCH,
        actorId: 'yD95d01y3SlKrPqQ7',
        actorName: 'apify/web-search',
        title: 'Search public web pages',
        description: 'Search one page of organic web results: titles, URLs and snippets.',
        shape: { query: SearchTextValidator, maxResults: z.number().int().min(1).max(10).default(10) },
        buildInput: ({ query, maxResults }) => ({ query, maxResults, provider: 'google' }),
    }),
    createPolicy({
        name: HELPER_TOOLS.CHATGPT_WEB_FETCH,
        actorId: 'a6Sqhlnt4touIHTub',
        actorName: 'apify/web-fetch',
        title: 'Fetch a public web page',
        description: 'Fetch one public web page as Markdown, text or links. No custom headers.',
        shape: { url: buildUrlValidator(), format: z.enum(['markdown', 'text', 'links']).default('markdown') },
        buildInput: ({ url, format }) => ({ url, formats: [format], headers: {} }),
    }),
    createPolicy({
        name: HELPER_TOOLS.CHATGPT_WEBSITE_CONTENT,
        actorId: 'aYG0l9s7dbB7j3gbS',
        actorName: 'apify/website-content-crawler',
        title: 'Crawl public website content',
        description: 'Extract public text from one site and its subpages, with a page and depth limit.',
        shape: {
            url: buildUrlValidator(),
            maxPages: ResultLimitValidator,
            maxDepth: z.number().int().min(0).max(2).default(1),
        },
        buildInput: ({ url, maxPages, maxDepth }) => ({
            startUrls: [{ url }],
            maxCrawlPages: maxPages,
            maxResults: maxPages,
            maxCrawlDepth: maxDepth,
            crawlerType: 'cheerio',
            respectRobotsTxtFile: true,
            proxyConfiguration: { useApifyProxy: true },
            initialCookies: [],
            customHttpHeaders: {},
            pageFunction: '',
            clickElementsCssSelector: '',
            includeUrlGlobs: [],
            useSitemaps: false,
            useLlmsTxt: false,
            signHttpRequests: false,
            ignoreHttpsErrors: false,
            maxConcurrency: 2,
            maxRequestRetries: 1,
            maxSessionRotations: 1,
            requestTimeoutSecs: 30,
            removeCookieWarnings: false,
            expandIframes: false,
            blockMedia: true,
            saveMarkdown: true,
            saveHtml: false,
            saveHtmlAsFile: false,
            saveFiles: false,
            saveContentTypes: '',
            saveScreenshots: false,
            summarize: false,
            debugMode: false,
            debugLog: false,
            reuseStoredDetectionResults: false,
        }),
    }),
    createPolicy({
        name: HELPER_TOOLS.CHATGPT_SCREENSHOT,
        actorId: 'rGCyoaKTKhyMiiTvS',
        actorName: 'apify/screenshot-url',
        title: 'Capture a public page screenshot',
        description: 'Capture a PNG screenshot of one public page.',
        shape: { url: buildUrlValidator(), width: z.number().int().min(640).max(1920).default(1280) },
        buildInput: ({ url, width }) => ({
            urls: [{ url }],
            format: 'png',
            viewportWidth: width,
            waitUntil: 'load',
            delay: 0,
            scrollToBottom: false,
            selectorsToHide: '',
            proxy: { useApifyProxy: true },
        }),
    }),
    createPolicy({
        name: HELPER_TOOLS.CHATGPT_SITEMAP,
        actorId: 'rGeTNESChDZ65EbYh',
        actorName: 'apify/sitemap-extractor',
        title: 'Extract sitemap URLs',
        description:
            'Read sitemap URLs to a bounded depth, without fetching the listed pages. Large sitemaps can return many URLs.',
        shape: { url: buildUrlValidator(), maxDepth: z.number().int().min(1).max(3).default(1) },
        buildInput: ({ url, maxDepth }) => ({
            startUrls: [{ url }],
            maxCrawlingDepth: maxDepth,
            checkPageStatus: false,
            maxRequestRetries: 1,
            proxyConfiguration: { useApifyProxy: true },
            proxyRotation: 'RECOMMENDED',
        }),
    }),
    createPolicy({
        name: HELPER_TOOLS.CHATGPT_GOOGLE_MAPS,
        actorId: 'nwua9Gu5YrADL7ZDj',
        actorName: 'compass/crawler-google-places',
        title: 'Find Google Maps places',
        description:
            'Find public business listings for one search term and location. Excludes reviews and contact enrichment.',
        shape: { query: SearchTextValidator, location: SearchTextValidator, maxResults: ResultLimitValidator },
        buildInput: ({ query, location, maxResults }) => ({
            searchStringsArray: [query],
            locationQuery: location,
            maxCrawledPlacesPerSearch: maxResults,
            scrapePlaceDetailPage: false,
            scrapeContacts: false,
            maximumLeadsEnrichmentRecords: 0,
            verifyLeadsEnrichmentEmails: false,
            scrapeSocialMediaProfiles: {
                facebooks: false,
                instagrams: false,
                youtubes: false,
                tiktoks: false,
                twitters: false,
            },
            maxReviews: 0,
            scrapeReviewsPersonalData: false,
            maxImages: 0,
            scrapeImageAuthors: false,
            maxQuestions: 0,
            enableCompetitorAnalysis: false,
            scrapeTableReservationProvider: false,
            scrapeOrderOnline: false,
            scrapeDirectories: false,
            includeWebResults: false,
        }),
    }),
    createPolicy({
        name: HELPER_TOOLS.CHATGPT_AMAZON_PRODUCTS,
        actorId: 'BG3WDrGdteHgZgbPK',
        actorName: 'junglee/amazon-crawler',
        title: 'Read Amazon products',
        description: 'Extract product details from up to three Amazon product or category URLs.',
        shape: {
            urls: z
                .array(
                    buildUrlValidator([
                        'amazon.com',
                        'amazon.co.uk',
                        'amazon.de',
                        'amazon.fr',
                        'amazon.es',
                        'amazon.it',
                        'amazon.ca',
                        'amazon.com.au',
                        'amazon.co.jp',
                        'amazon.in',
                    ]),
                )
                .min(1)
                .max(3),
            maxResults: ResultLimitValidator,
        },
        buildInput: ({ urls, maxResults }) => ({
            categoryOrProductUrls: urls.map((url) => ({ url })),
            maxItemsPerStartUrl: maxResults,
            maxSearchPagesPerStartUrl: 1,
            maxProductVariantsAsSeparateResults: 0,
            maxOffers: 0,
            scrapeSellers: false,
            useCaptchaSolver: false,
            scrapeProductVariantPrices: false,
            scrapeProductDetails: true,
        }),
    }),
    createPolicy({
        name: HELPER_TOOLS.CHATGPT_YOUTUBE,
        actorId: 'h7sDV53CddomktSi5',
        actorName: 'streamers/youtube-scraper',
        title: 'Read YouTube video and channel metadata',
        description:
            'Read public YouTube video and channel metadata from a query or up to three URLs. Excludes transcripts and AI processing.',
        shape: {
            target: z.discriminatedUnion('type', [
                z.strictObject({ type: z.literal('query'), query: SearchTextValidator }),
                z.strictObject({
                    type: z.literal('urls'),
                    urls: z
                        .array(buildUrlValidator(['youtube.com', 'youtu.be']))
                        .min(1)
                        .max(3),
                }),
            ]),
            maxResults: ResultLimitValidator,
        },
        buildInput: ({ target, maxResults }) => ({
            ...(target.type === 'query'
                ? { searchQueries: [target.query] }
                : { startUrls: target.urls.map((url) => ({ url })) }),
            maxResults,
            maxResultsShorts: 0,
            maxResultStreams: 0,
            transcriptionAndSubtitle: 'NONE',
            saveSubsToKVS: false,
            aiVideoDescription: false,
            aiVideoSummary: false,
        }),
    }),
    createPolicy({
        name: HELPER_TOOLS.CHATGPT_TIKTOK,
        actorId: 'GdWCkxBtKWOsKjdch',
        actorName: 'clockworks/tiktok-scraper',
        title: 'Read TikTok video and profile metadata',
        description:
            'Read public TikTok video and profile metadata from a query or up to three URLs. Excludes downloads, comments, follower lists and AI processing.',
        shape: {
            target: z.discriminatedUnion('type', [
                z.strictObject({ type: z.literal('query'), query: SearchTextValidator }),
                z.strictObject({
                    type: z.literal('videos'),
                    urls: z
                        .array(buildUrlValidator(['tiktok.com']))
                        .min(1)
                        .max(3),
                }),
                z.strictObject({
                    type: z.literal('profiles'),
                    urls: z
                        .array(buildUrlValidator(['tiktok.com']))
                        .min(1)
                        .max(3),
                }),
            ]),
            maxResults: ResultLimitValidator,
        },
        buildInput: ({ target, maxResults }) => ({
            ...(target.type === 'query'
                ? { searchQueries: [target.query] }
                : target.type === 'videos'
                  ? { postURLs: target.urls }
                  : { profiles: target.urls }),
            profileScrapeSections: ['videos'],
            searchSection: '/video',
            resultsPerPage: maxResults,
            maxProfilesPerQuery: 1,
            maxFollowersPerProfile: 0,
            maxFollowingPerProfile: 0,
            commentsPerPost: 0,
            topLevelCommentsPerPost: 0,
            maxRepliesPerComment: 0,
            scrapeRelatedVideos: false,
            scrapeRelatedSearchWords: false,
            scrapeAdditionalAuthorMeta: false,
            shouldDownloadVideos: false,
            shouldDownloadCovers: false,
            shouldDownloadSlideshowImages: false,
            shouldDownloadAvatars: false,
            shouldDownloadMusicCovers: false,
            downloadSubtitlesOptions: 'NEVER_DOWNLOAD_SUBTITLES',
            aiVideoDescription: false,
            aiVideoSummary: false,
        }),
    }),
    createPolicy({
        name: HELPER_TOOLS.CHATGPT_INSTAGRAM,
        actorId: 'shu8hvrXbJbY3Eb9W',
        actorName: 'apify/instagram-scraper',
        title: 'Read public Instagram posts',
        description:
            'Extract bounded public posts from up to three Instagram URLs. Excludes comments, stories and mentions.',
        shape: {
            urls: z
                .array(
                    buildUrlValidator(['instagram.com']).regex(
                        /^https:\/\/(?:www\.)?instagram\.com\/[A-Za-z0-9._-]+(?:\/.*)?$/,
                        'Use an HTTPS Instagram profile or post URL on instagram.com or www.instagram.com.',
                    ),
                )
                .min(1)
                .max(3)
                .refine((urls) => new Set(urls).size === urls.length, { message: 'Use distinct Instagram URLs.' }),
            maxResults: ResultLimitValidator,
        },
        buildInput: ({ urls, maxResults }) => ({
            directUrls: urls,
            resultsType: 'posts',
            resultsLimit: maxResults,
            addParentData: false,
        }),
    }),
    createPolicy({
        name: HELPER_TOOLS.CHATGPT_FACEBOOK_POSTS,
        actorId: 'KoJrdxJCTtpon81KY',
        actorName: 'apify/facebook-posts-scraper',
        title: 'Read public Facebook posts',
        description: 'Extract bounded public posts from up to three Facebook URLs. Excludes video transcripts.',
        shape: {
            urls: z
                .array(buildUrlValidator(['facebook.com']))
                .min(1)
                .max(3),
            maxResults: ResultLimitValidator,
            dateRange: DateRangeValidator.optional(),
        },
        buildInput: ({ urls, maxResults, dateRange }) => ({
            startUrls: urls.map((url) => ({ url })),
            resultsLimit: maxResults,
            captionText: false,
            ...(dateRange ? { onlyPostsNewerThan: dateRange.from, onlyPostsOlderThan: dateRange.to } : {}),
        }),
    }),
    createPolicy({
        name: HELPER_TOOLS.CHATGPT_BOOKING,
        actorId: 'oeiQgfg5fsmIJB7Cn',
        actorName: 'voyager/booking-scraper',
        title: 'Find Booking.com accommodation listings',
        description:
            'Read public accommodation listings for one destination, with optional dates for price and availability snapshots. Does not make reservations.',
        shape: {
            destination: SearchTextValidator,
            maxResults: ResultLimitValidator,
            stay: BookingStayValidator.optional(),
        },
        buildInput: ({ destination, maxResults, stay }) => ({
            search: destination,
            maxItems: maxResults,
            extractAdditionalHotelData: false,
            ...(stay ? { checkIn: stay.checkIn, checkOut: stay.checkOut } : {}),
        }),
    }),
    createPolicy({
        name: HELPER_TOOLS.CHATGPT_TRIPADVISOR,
        actorId: 'dbEyMBriog95Fv8CW',
        actorName: 'maxcopell/tripadvisor',
        title: 'Find Tripadvisor places',
        description:
            'Read public place listings and aggregate ratings for one destination. Excludes lead enrichment and AI review summaries.',
        shape: { destination: SearchTextValidator, maxResults: ResultLimitValidator },
        buildInput: ({ destination, maxResults }) => ({
            query: destination,
            maxItemsPerQuery: maxResults,
            includeNearbyResults: false,
            includeAiReviewsSummary: false,
            maxPhotosPerPlace: 0,
            maximumLeadsEnrichmentRecords: 0,
            verifyLeadsEnrichmentEmails: false,
        }),
    }),
];

export const CURATED_ACTOR_TOOL_NAMES = Object.freeze(CURATED_ACTOR_POLICIES.map(({ name }) => name));
