import { ActorDetails } from "../types";

/**
 * Mock response for actor details based on the real fetch-actor-details response structure
 * This can be used to populate the detail view for any actor
 */
export const MOCK_ACTOR_DETAILS_RESPONSE = {
    structuredContent: {
        actorDetails: {
            actorInfo: {
                id: "moJRLRc85AitArpNN",
                name: "web-scraper",
                username: "apify",
                title: "Web Scraper",
                description: "Crawls arbitrary websites using a web browser and extracts structured data from web pages using a provided JavaScript function. The Actor supports both recursive crawling and lists of URLs, and automatically manages concurrency for maximum performance.",
                pictureUrl: "https://apify-image-uploads-prod.s3.amazonaws.com/KD4Z3rKBPJjqq1TKm/web-scraper-icon.svg",
                stats: {
                    totalBuilds: 1000,
                    totalRuns: 50000,
                    totalUsers: 102384,
                    totalBookmarks: 1115
                },
                currentPricingInfo: {
                    pricingModel: "FREE",
                    pricePerResultUsd: 0,
                    monthlyChargeUsd: 0
                }
            },
            readme: `# Web Scraper

## What is Web Scraper?

Web Scraper is a tool for extracting data from any website. It can navigate pages, render JavaScript, and extract structured data using a few simple commands. Whether you need to scrape product prices, real estate data, or social media profiles, this Actor turns any web page into an API.

- Configurable with an **intuitive user interface**
- Can handle almost **any website** and can scrape dynamic content
- Scrape a list of **URLs or crawl an entire website** by following links
- Runs entirely on the **Apify platform**; no need to manage servers or proxies
- Set your scraper to **run on a schedule** and get data delivered automatically
- Can be used as a template to **create your own scraper**

## What can Web Scraper data be used for?

Web Scraper can extract almost any data from any site, effectively turning any site into a data source. All data can be exported into **JSON, CSV, HTML, and Excel** formats.

Here are some examples:

- **Extract reviews** from sites like Yelp or Amazon
- Gather **real estate data** from Zillow or local realtor pages
- Get **contact details** and social media accounts from local businesses
- **Monitor mentions** of a brand or person on specific sites
- **Collect and monitor product prices** on e-commerce websites

For more details, see the [full documentation](https://apify.com/apify/web-scraper).`,
            inputSchema: {
                title: "Web Scraper Input",
                type: "object",
                schemaVersion: 1,
                properties: {
                    startUrls: {
                        title: "Start URLs",
                        type: "array",
                        description: "URLs to start scraping from",
                        prefill: [{ url: "https://example.com" }]
                    },
                    linkSelector: {
                        title: "Link selector",
                        type: "string",
                        description: "CSS selector for links to follow",
                        prefill: "a[href]"
                    },
                    pageFunction: {
                        title: "Page function",
                        type: "string",
                        description: "JavaScript function to extract data"
                    },
                    proxyConfiguration: {
                        title: "Proxy configuration",
                        type: "object",
                        description: "Proxy settings"
                    }
                },
                required: ["startUrls", "pageFunction"]
            },
            actorCard: JSON.stringify({
                id: "moJRLRc85AitArpNN",
                name: "web-scraper",
                username: "apify",
                title: "Web Scraper",
                url: "https://apify.com/apify/web-scraper"
            }, null, 2)
        }
    }
};

/**
 * Creates mock actor details for any actor
 * Merges the provided actor info with the mock template
 */
export function createMockActorDetails(actor: {
    id: string;
    name: string;
    username: string;
    title?: string;
    description: string;
    pictureUrl?: string;
    stats?: {
        totalBuilds: number;
        totalRuns: number;
        totalUsers: number;
        totalBookmarks: number;
    };
    currentPricingInfo?: {
        pricingModel: string;
        pricePerResultUsd: number;
        monthlyChargeUsd: number;
    };
}): ActorDetails {
    return {
        actorInfo: {
            id: actor.id,
            name: actor.name,
            username: actor.username,
            title: actor.title || actor.name,
            description: actor.description,
            pictureUrl: actor.pictureUrl,
            stats: actor.stats,
            currentPricingInfo: actor.currentPricingInfo
        },
        readme: MOCK_ACTOR_DETAILS_RESPONSE.structuredContent.actorDetails.readme,
        inputSchema: MOCK_ACTOR_DETAILS_RESPONSE.structuredContent.actorDetails.inputSchema,
        actorCard: JSON.stringify({
            id: actor.id,
            name: actor.name,
            username: actor.username,
            title: actor.title || actor.name,
            url: `https://apify.com/${actor.username}/${actor.name}`
        }, null, 2)
    };
}
