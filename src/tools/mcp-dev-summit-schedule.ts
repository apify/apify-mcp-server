 import { z } from 'zod';
 import zodToJsonSchema from 'zod-to-json-schema';

 import { ApifyClient } from '../apify-client.js';
 import { HelperTools } from '../const.js';
 import type { InternalTool, ToolEntry } from '../types.js';
 import { ajv } from '../utils/ajv.js';
 import { buildMCPResponse } from '../utils/mcp.js';
 import { mcpDevSummitScheduleCache } from '../state.js';

// Local backup variable to store the latest data in case cache expires
let latestScheduleData: string[] | null = null;

// Helper function to fetch schedule data from Apify Actor
async function fetchScheduleData(): Promise<string[]> {
    const client = new ApifyClient({ token: process.env.APIFY_TOKEN });

    const input = {
        "aggressivePrune": false,
        "blockMedia": true,
        "clickElementsCssSelector": "[aria-expanded=\"false\"]",
        "clientSideMinChangePercentage": 15,
        "crawlerType": "cheerio",
        "debugLog": false,
        "debugMode": false,
        "expandIframes": true,
        "ignoreCanonicalUrl": false,
        "ignoreHttpsErrors": false,
        "includeUrlGlobs": [
            {
                "glob": "https://mcpdevsummiteurope2025.sched.com/event/**"
            }
        ],
        "keepUrlFragments": false,
        "proxyConfiguration": {
            "useApifyProxy": true
        },
        "readableTextCharThreshold": 100,
        "removeCookieWarnings": true,
        "removeElementsCssSelector": "nav, footer, script, style, noscript, svg, img[src^='data:'],\n[role=\"alert\"],\n[role=\"banner\"],\n[role=\"dialog\"],\n[role=\"alertdialog\"],\n[role=\"region\"][aria-label*=\"skip\" i],\n[aria-modal=\"true\"]",
        "renderingTypeDetectionPercentage": 10,
        "respectRobotsTxtFile": false,
        "saveFiles": false,
        "saveHtml": false,
        "saveHtmlAsFile": false,
        "saveMarkdown": true,
        "saveScreenshots": false,
        "startUrls": [
            {
                "url": "https://mcpdevsummiteurope2025.sched.com/list/simple",
                "method": "GET"
            }
        ],
        "useSitemaps": false,
        "excludeUrlGlobs": [],
        "maxCrawlDepth": 20,
        "maxCrawlPages": 9999999,
        "initialConcurrency": 0,
        "maxConcurrency": 200,
        "initialCookies": [],
        "maxSessionRotations": 10,
        "maxRequestRetries": 3,
        "requestTimeoutSecs": 60,
        "minFileDownloadSpeedKBps": 128,
        "dynamicContentWaitSecs": 10,
        "waitForSelector": "",
        "softWaitForSelector": "",
        "maxScrollHeightPixels": 5000,
        "keepElementsCssSelector": "",
        "htmlTransformer": "readableText",
        "maxResults": 9999999
    };

    const run = await client.actor('apify/website-content-crawler').call(input);
    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    // The crawled markdown already contains all the event details
    const data = items.map((item: any) => item.text || '');

    // Update the local backup variable
    latestScheduleData = data;

    return data;
}

// Helper function to schedule background refresh
function scheduleBackgroundRefresh(): void {
    // Use setTimeout to schedule refresh after response is sent
    setTimeout(async () => {
        try {
            // Remove expired entry
            (mcpDevSummitScheduleCache as any).cache.remove('mcp-dev-summit-schedule');
            const freshData = await fetchScheduleData();
            mcpDevSummitScheduleCache.set('mcp-dev-summit-schedule', freshData);
            // Update local backup as well
            latestScheduleData = freshData;
        } catch (error) {
            console.error('Background refresh of MCP Dev Summit schedule failed:', error);
        }
    }, 0);
}

// Custom cache check that serves expired data and refreshes in background
function getCachedOrFetch(): { data: string[] | null, isExpired: boolean } {
    const cacheKey = 'mcp-dev-summit-schedule';
    const entry = (mcpDevSummitScheduleCache as any).cache.get(cacheKey);

    if (!entry) {
        return { data: null, isExpired: false };
    }

    const isExpired = entry.expiresAt <= Date.now();

    if (isExpired) {
        // Return expired data
        return { data: entry.value, isExpired: true };
    }

    return { data: entry.value, isExpired: false };
}



export const getMcpDevSummitSchedule: ToolEntry = {
    type: 'internal',
    tool: {
        name: HelperTools.GET_MCP_DEV_SUMMIT_SCHEDULE,
        actorFullName: HelperTools.GET_MCP_DEV_SUMMIT_SCHEDULE,
        description: `Retrieve the schedule for the MCP Dev Summit Europe 2025.
Fetches and parses the schedule from https://mcpdevsummiteurope2025.sched.com/list/simple to provide 
structured information about sessions, speakers, and timing.

USAGE:
- Use when you need information about MCP Dev Summit sessions, schedule, or speakers.

USAGE EXAMPLES:
- user_input: What sessions are scheduled for the MCP Dev Summit?
- user_input: Who are the speakers at the MCP Dev Summit?`,
        inputSchema: zodToJsonSchema(z.object({})),
        ajvValidate: ajv.compile(zodToJsonSchema(z.object({}))),
         call: async () => {
             const { data: cachedData, isExpired } = getCachedOrFetch();

             if (cachedData) {
                 // Serve cached data immediately
                 if (isExpired) {
                     // Schedule background refresh for expired data
                     scheduleBackgroundRefresh();
                 }
                 return buildMCPResponse(cachedData);
             }

             // No cached data, check local backup
             if (latestScheduleData) {
                 // Serve local backup data immediately
                 scheduleBackgroundRefresh();
                 return buildMCPResponse(latestScheduleData);
             }

             // No cached or backup data, fetch fresh data
             const freshData = await fetchScheduleData();

             // Cache the fresh data
             mcpDevSummitScheduleCache.set('mcp-dev-summit-schedule', freshData);

             return buildMCPResponse(freshData);
         },
    } as InternalTool,
};
