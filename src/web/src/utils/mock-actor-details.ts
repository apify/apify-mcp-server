import { ActorDetails, Actor } from "../types";

/**
 * Mock response for actor details based on the real fetch-actor-details response structure
 * This can be used to populate the detail view for any actor
 */
export const MOCK_ACTOR_DETAILS_RESPONSE = {
    structuredContent: {
        "actorInfo": {
            "title": "X (Twitter) Profile Posts Scraper",
            "url": "https://apify.com/scraper_one/x-profile-posts-scraper",
            "fullName": "scraper_one/x-profile-posts-scraper",
            "pictureUrl": "https://apify-image-uploads-prod.s3.us-east-1.amazonaws.com/I6SWeCfaQNWFFhjPZ-actor-Fo9GoU5wC270BgcBr-9cIIQJuTMz-X-Logo-Round-Color.png",
            "developer": {
                "username": "scraper_one",
                "isOfficialApify": false,
                "url": "https://apify.com/scraper_one"
            },
            "description": "Extract posts published by specified X (Twitter) profiles. Retrieve URLs, IDs, content, publication dates, text and engagement metrics. Ideal for social media monitoring solutions.",
            "pricing": {
                "model": "PAY_PER_EVENT",
                "isFree": false,
                "events": [
                    {
                        "title": "Initialize actor",
                        "description": "Initialize actor",
                        "tieredPricing": [
                            {
                                "tier": "BRONZE",
                                "priceUsd": 0.0025
                            },
                            {
                                "tier": "SILVER",
                                "priceUsd": 0.0025
                            },
                            {
                                "tier": "GOLD",
                                "priceUsd": 0.0025
                            },
                            {
                                "tier": "PLATINUM",
                                "priceUsd": 0.0025
                            },
                            {
                                "tier": "DIAMOND",
                                "priceUsd": 0.0025
                            },
                            {
                                "tier": "FREE",
                                "priceUsd": 0.025
                            }
                        ]
                    },
                    {
                        "title": "Result item",
                        "description": "Result item (post)",
                        "tieredPricing": [
                            {
                                "tier": "FREE",
                                "priceUsd": 0.004
                            },
                            {
                                "tier": "BRONZE",
                                "priceUsd": 0.0004
                            },
                            {
                                "tier": "SILVER",
                                "priceUsd": 0.0004
                            },
                            {
                                "tier": "GOLD",
                                "priceUsd": 0.0004
                            },
                            {
                                "tier": "PLATINUM",
                                "priceUsd": 0.0004
                            },
                            {
                                "tier": "DIAMOND",
                                "priceUsd": 0.0004
                            }
                        ]
                    }
                ]
            },
            "rating": {
                "average": 5,
                "count": 1
            },
            "isDeprecated": false,
            "stats": {
                "totalUsers": 734,
                "monthlyUsers": 113,
                "successRate": 100,
                "bookmarks": 5
            },
            "modifiedAt": "2026-01-23T08:11:16.995Z"
        },
        "readme": "# [README](https://apify.com/scraper_one/x-profile-posts-scraper/readme): X (Twitter) Profile Posts Scraper\n\n![Apify Actor](https://img.shields.io/badge/Apify-Actor-blue)\n\nThis **Apify Actor** extracts **posts** from **X (Twitter) profiles** provided as input URLs. It retrieves post content, author data, timestamps, media,\nand engagement statistics. Perfect for **social media monitoring, research, user tracking, and trend analysis solutions**. 🚀\n\n---\n\n## 🧩 Features\n\n- 👤 Scrape **posts** from multiple X (Twitter) profiles\n- 🔢 Set **result limit** per profile\n- 📸 Extract **media, author info, post text, ids, timestamp and engagement stats**\n\n---\n\n## 📥 Input Parameters\n\n| Parameter      | Type       | Required | Description                                                                   |\n|----------------|------------|----------|-------------------------------------------------------------------------------|\n| `profileUrls`  | `string[]` | ✅        | List of X profile URLs to extract posts from (e.g., `https://x.com/elonmusk`) |\n| `resultsLimit` | `number`   | ❌        | Maximum number of posts to retrieve **per profile** (1–200). Default: 30      |\n\n---\n\n## ✅ Example Input\n\n```json\n{\n    \"profileUrls\": [\n        \"https://x.com/elonmusk\"\n    ],\n    \"resultsLimit\": 20\n}\n```\n\n---\n\n## 📤 Output Format\n\nThe scraper returns an array of post objects in JSON format with details such as text, author, and metrics.\n\n### Example Output\n\n```json\n{\n    \"postText\": \"🦾🔥\",\n    \"postUrl\": \"https://x.com/elonmusk/status/1938336472253534273\",\n    \"profileUrl\": \"https://x.com/elonmusk\",\n    \"timestamp\": 1750970402000,\n    \"conversationId\": \"1938336472253534273\",\n    \"postId\": \"1938336472253534273\",\n    \"media\": [],\n    \"author\": {\n        \"name\": \"Elon Musk\",\n        \"screenName\": \"elonmusk\",\n        \"followersCount\": 221266053,\n        \"favouritesCount\": 153129,\n        \"friendsCount\": 1146,\n        \"description\": \"\"\n    },\n    \"replyCount\": 1558,\n    \"quoteCount\": 50,\n    \"repostCount\": 954,\n    \"favouriteCount\": 9609\n}\n```\n\n---\n\n## 🚀 Usage\n\n1. Go to [Apify Console](https://console.apify.com/) and create a new task using this actor.\n2. Paste input in JSON or use form view.\n3. Run the actor and monitor results in the console.\n4. Download results as JSON, CSV, or Excel.\n\n---\n\n## ⚠️ Limitations & Notes\n\n- Works only with **public X profiles**.\n- Avoid excessive usage to prevent rate-limiting or temporary IP bans.\n- Always ensure compliance with **X (Twitter)'s Terms of Service**.\n- Rate-limited – Free users can make only a few requests per day. **Contact us if you need higher or custom limits!**\n\n---\n\n## Other Recommended Scrapers\n\n- 🐦 [X (Twitter) Posts Search](https://apify.com/scraper_one/x-posts-search) — Find posts/tweets based on keywords, hashtags, and more\n- 🐦 [X (Twitter) Post Replies Scraper](https://apify.com/scraper_one/x-post-replies-scraper) — Scrap replies of multiple X (Twitter) posts\n- 🐦 [X (Twitter) Profile Posts Scraper](https://apify.com/scraper_one/x-profile-posts-scraper) — Scrap posts by specified X profiles/users\n- 📘 [Facebook Posts Search](https://apify.com/scraper_one/facebook-posts-search) — Discover Facebook posts for a given topic or page\n- 📘 [Facebook Comments Scraper](https://apify.com/scraper_one/facebook-comments-scraper) — Extract comments from public Facebook posts\n- 📘 [Facebook Reactions Scraper](https://apify.com/scraper_one/facebook-reactions-scraper) — Extract reactions from public Facebook posts\n- 📘 [Facebook Posts Scraper](https://apify.com/scraper_one/facebook-posts-scraper) — Scrap posts from Facebook pages, groups etc.\n- 💬 [YouTube Search Scraper](https://apify.com/scraper_one/youtube-search-scraper) — Extract search results from YouTube\n- 💬 [YouTube Comments Scraper](https://apify.com/scraper_one/youtube-comments-scraper) — Extract comments from YouTube videos\n\n## Support & Contact\n\n✉️ Need help or want to suggest a feature? **Open an issue** or contact us at **scraper1one@gmail.com**.\n\n",
        "inputSchema": {
            "title": "Apify Input Schema",
            "description": "Schema for input configuration in Apify Actor",
            "type": "object",
            "schemaVersion": 1,
            "properties": {
                "profileUrls": {
                    "title": "Profile URLs",
                    "description": "List of profile URLs to process",
                    "type": "array",
                    "prefill": [
                        "https://x.com/ishowspeedsui",
                        "https://x.com/AshtonHallofc"
                    ]
                },
                "resultsLimit": {
                    "title": "Results Limit",
                    "description": "Maximum number of results to retrieve (between 1 and 200) per profile URL. If not set, only a few of the first replies will be returned.",
                    "type": "integer",
                    "prefill": 30
                }
            },
            "required": [
                "profileUrls"
            ]
        },
        "actorDetails": {
            "actorInfo": {
                "id": "Fo9GoU5wC270BgcBr",
                "name": "x-profile-posts-scraper",
                "username": "scraper_one",
                "url": "https://apify.com/scraper_one/x-profile-posts-scraper",
                "fullName": "scraper_one/x-profile-posts-scraper",
                "title": "X (Twitter) Profile Posts Scraper",
                "description": "Extract posts published by specified X (Twitter) profiles. Retrieve URLs, IDs, content, publication dates, text and engagement metrics. Ideal for social media monitoring solutions.",
                "pictureUrl": "https://apify-image-uploads-prod.s3.us-east-1.amazonaws.com/I6SWeCfaQNWFFhjPZ-actor-Fo9GoU5wC270BgcBr-9cIIQJuTMz-X-Logo-Round-Color.png",
                "stats": {
                    "totalUsers": 734,
                    "actorReviewRating": 5,
                    "actorReviewCount": 1
                },
                "currentPricingInfo": {
                    "model": "PAY_PER_EVENT",
                    "isFree": false,
                    "events": [
                        {
                            "title": "Initialize actor",
                            "description": "Initialize actor",
                            "tieredPricing": [
                                {
                                    "tier": "BRONZE",
                                    "priceUsd": 0.0025
                                },
                                {
                                    "tier": "SILVER",
                                    "priceUsd": 0.0025
                                },
                                {
                                    "tier": "GOLD",
                                    "priceUsd": 0.0025
                                },
                                {
                                    "tier": "PLATINUM",
                                    "priceUsd": 0.0025
                                },
                                {
                                    "tier": "DIAMOND",
                                    "priceUsd": 0.0025
                                },
                                {
                                    "tier": "FREE",
                                    "priceUsd": 0.025
                                }
                            ]
                        },
                        {
                            "title": "Result item",
                            "description": "Result item (post)",
                            "tieredPricing": [
                                {
                                    "tier": "FREE",
                                    "priceUsd": 0.004
                                },
                                {
                                    "tier": "BRONZE",
                                    "priceUsd": 0.0004
                                },
                                {
                                    "tier": "SILVER",
                                    "priceUsd": 0.0004
                                },
                                {
                                    "tier": "GOLD",
                                    "priceUsd": 0.0004
                                },
                                {
                                    "tier": "PLATINUM",
                                    "priceUsd": 0.0004
                                },
                                {
                                    "tier": "DIAMOND",
                                    "priceUsd": 0.0004
                                }
                            ]
                        }
                    ]
                }
            },
            "actorCard": "## [X (Twitter) Profile Posts Scraper](https://apify.com/scraper_one/x-profile-posts-scraper) (`scraper_one/x-profile-posts-scraper`)\n- **URL:** https://apify.com/scraper_one/x-profile-posts-scraper\n- **Description:** Extract posts published by specified X (Twitter) profiles. Retrieve URLs, IDs, content, publication dates, text and engagement metrics. Ideal for social media monitoring solutions.\n- **[Pricing](https://apify.com/scraper_one/x-profile-posts-scraper/pricing):** This Actor is paid per event. You are not charged for the Apify platform usage, but only a fixed price for the following events:\n\t- **Initialize actor**: Initialize actor (Tiered pricing: BRONZE: $0.0025, SILVER: $0.0025, GOLD: $0.0025, PLATINUM: $0.0025, DIAMOND: $0.0025, FREE: $0.025 per event)\n\t- **Result item**: Result item (post) (Tiered pricing: FREE: $0.004, BRONZE: $0.0004, SILVER: $0.0004, GOLD: $0.0004, PLATINUM: $0.0004, DIAMOND: $0.0004 per event)\n- **Stats:** 734 total users, 113 monthly users, Runs succeeded: 100.0%, 5 bookmarks\n- **Rating:** 5.00 out of 5\n- **Developed by:** [scraper_one](https://apify.com/scraper_one) (community)\n- **Categories:** Automation, Social Media, Developer Tools\n- **Last modified:** 2026-01-23T08:11:16.995Z",
            "readme": "# [README](https://apify.com/scraper_one/x-profile-posts-scraper/readme): X (Twitter) Profile Posts Scraper\n\n![Apify Actor](https://img.shields.io/badge/Apify-Actor-blue)\n\nThis **Apify Actor** extracts **posts** from **X (Twitter) profiles** provided as input URLs. It retrieves post content, author data, timestamps, media,\nand engagement statistics. Perfect for **social media monitoring, research, user tracking, and trend analysis solutions**. 🚀\n\n---\n\n## 🧩 Features\n\n- 👤 Scrape **posts** from multiple X (Twitter) profiles\n- 🔢 Set **result limit** per profile\n- 📸 Extract **media, author info, post text, ids, timestamp and engagement stats**\n\n---\n\n## 📥 Input Parameters\n\n| Parameter      | Type       | Required | Description                                                                   |\n|----------------|------------|----------|-------------------------------------------------------------------------------|\n| `profileUrls`  | `string[]` | ✅        | List of X profile URLs to extract posts from (e.g., `https://x.com/elonmusk`) |\n| `resultsLimit` | `number`   | ❌        | Maximum number of posts to retrieve **per profile** (1–200). Default: 30      |\n\n---\n\n## ✅ Example Input\n\n```json\n{\n    \"profileUrls\": [\n        \"https://x.com/elonmusk\"\n    ],\n    \"resultsLimit\": 20\n}\n```\n\n---\n\n## 📤 Output Format\n\nThe scraper returns an array of post objects in JSON format with details such as text, author, and metrics.\n\n### Example Output\n\n```json\n{\n    \"postText\": \"🦾🔥\",\n    \"postUrl\": \"https://x.com/elonmusk/status/1938336472253534273\",\n    \"profileUrl\": \"https://x.com/elonmusk\",\n    \"timestamp\": 1750970402000,\n    \"conversationId\": \"1938336472253534273\",\n    \"postId\": \"1938336472253534273\",\n    \"media\": [],\n    \"author\": {\n        \"name\": \"Elon Musk\",\n        \"screenName\": \"elonmusk\",\n        \"followersCount\": 221266053,\n        \"favouritesCount\": 153129,\n        \"friendsCount\": 1146,\n        \"description\": \"\"\n    },\n    \"replyCount\": 1558,\n    \"quoteCount\": 50,\n    \"repostCount\": 954,\n    \"favouriteCount\": 9609\n}\n```\n\n---\n\n## 🚀 Usage\n\n1. Go to [Apify Console](https://console.apify.com/) and create a new task using this actor.\n2. Paste input in JSON or use form view.\n3. Run the actor and monitor results in the console.\n4. Download results as JSON, CSV, or Excel.\n\n---\n\n## ⚠️ Limitations & Notes\n\n- Works only with **public X profiles**.\n- Avoid excessive usage to prevent rate-limiting or temporary IP bans.\n- Always ensure compliance with **X (Twitter)'s Terms of Service**.\n- Rate-limited – Free users can make only a few requests per day. **Contact us if you need higher or custom limits!**\n\n---\n\n## Other Recommended Scrapers\n\n- 🐦 [X (Twitter) Posts Search](https://apify.com/scraper_one/x-posts-search) — Find posts/tweets based on keywords, hashtags, and more\n- 🐦 [X (Twitter) Post Replies Scraper](https://apify.com/scraper_one/x-post-replies-scraper) — Scrap replies of multiple X (Twitter) posts\n- 🐦 [X (Twitter) Profile Posts Scraper](https://apify.com/scraper_one/x-profile-posts-scraper) — Scrap posts by specified X profiles/users\n- 📘 [Facebook Posts Search](https://apify.com/scraper_one/facebook-posts-search) — Discover Facebook posts for a given topic or page\n- 📘 [Facebook Comments Scraper](https://apify.com/scraper_one/facebook-comments-scraper) — Extract comments from public Facebook posts\n- 📘 [Facebook Reactions Scraper](https://apify.com/scraper_one/facebook-reactions-scraper) — Extract reactions from public Facebook posts\n- 📘 [Facebook Posts Scraper](https://apify.com/scraper_one/facebook-posts-scraper) — Scrap posts from Facebook pages, groups etc.\n- 💬 [YouTube Search Scraper](https://apify.com/scraper_one/youtube-search-scraper) — Extract search results from YouTube\n- 💬 [YouTube Comments Scraper](https://apify.com/scraper_one/youtube-comments-scraper) — Extract comments from YouTube videos\n\n## Support & Contact\n\n✉️ Need help or want to suggest a feature? **Open an issue** or contact us at **scraper1one@gmail.com**.\n\n",
            "inputSchema": {
                "title": "Apify Input Schema",
                "description": "Schema for input configuration in Apify Actor",
                "type": "object",
                "schemaVersion": 1,
                "properties": {
                    "profileUrls": {
                        "title": "Profile URLs",
                        "description": "List of profile URLs to process",
                        "type": "array",
                        "prefill": [
                            "https://x.com/ishowspeedsui",
                            "https://x.com/AshtonHallofc"
                        ]
                    },
                    "resultsLimit": {
                        "title": "Results Limit",
                        "description": "Maximum number of results to retrieve (between 1 and 200) per profile URL. If not set, only a few of the first replies will be returned.",
                        "type": "integer",
                        "prefill": 30
                    }
                },
                "required": [
                    "profileUrls"
                ]
            }
        }
    }
};

/**
 * Creates mock actor details for any actor
 * Merges the provided actor info with the mock template
 */
export function createMockActorDetails(actor: Actor): ActorDetails {
    return {
        actorInfo: {
            id: actor.id,
            url: actor.url,
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
