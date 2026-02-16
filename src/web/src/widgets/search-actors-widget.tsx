import { ActorSearch } from "../pages/ActorSearch/ActorSearch";
import { setupMockOpenAi, updateMockOpenAiState } from "../utils/mock-openai";
import { renderWidget } from "../utils/init-widget";

// Mock data for local development/testing
const mockActors = [
    {
        id: "actor-1",
        name: "web-scraper",
        username: "apify",
        fullName: "apify/web-scraper",
        title: "Web Scraper",
        description:
            "Crawl arbitrary websites using the Chrome browser and extract data from them using jQuery. It handles dynamic pages, authentication, and provides a REST API.",
        pictureUrl: "https://apify.com/storage/actor-avatars/1/web-scraper.png",
        stats: {
            totalUsers: 12345,
            actorReviewCount: 0,
            actorReviewRating: 0,
        },
        currentPricingInfo: {
            pricingModel: "PRICE_PER_DATASET_ITEM",
            pricePerUnitUsd: 0.0001,
        },
        url: "https://apify.com/apify/web-scraper",
    },
    {
        id: "actor-2",
        name: "google-search-scraper",
        username: "apify",
        fullName: "apify/google-search-scraper",
        title: "Google Search Results Scraper",
        description:
            "Extract data from Google Search results including organic results, ads, related queries, and more. Fast and reliable scraper with proxy rotation.",
        categories: ["SEO", "CONTENT_SCRAPING"],
        pictureUrl: "https://apify.com/storage/actor-avatars/1/google-search-scraper.png",
        stats: {
            totalUsers: 8901,
            actorReviewCount: 40,
            actorReviewRating: 5.0,
        },
        currentPricingInfo: {
            pricingModel: "PAY_PER_EVENT",
            pricePerUnitUsd: 0,
        },
        url: "https://apify.com/apify/google-search-scraper",
    },
    {
        id: "actor-3",
        name: "instagram-scraper",
        username: "dtrungtin",
        fullName: "dtrungtin/instagram-scraper",
        title: "Instagram Scraper",
        description:
            "Scrape Instagram posts, profiles, hashtags, stories, and comments. Extract images, videos, captions, and engagement metrics without using the official API.",
        categories: ["SOCIAL_MEDIA", "CONTENT_SCRAPING"],
        pictureUrl: "",
        stats: {
            totalUsers: 5678,
            actorReviewCount: 124,
            actorReviewRating: 4.2,
        },
        currentPricingInfo: {
            pricingModel: "FREE",
            pricePerUnitUsd: 0,
        },
        url: "https://apify.com/dtrungtin/instagram-scraper",
    },
    {
        id: "actor-4",
        name: "amazon-product-scraper",
        username: "junglee",
        fullName: "junglee/amazon-product-scraper",
        title: "Amazon Product Scraper",
        description:
            "Extract product details, prices, ratings, reviews, and seller information from Amazon. Supports multiple Amazon domains and handles anti-scraping measures.",
        categories: ["ECOMMERCE", "PRICE_MONITORING", "CONTENT_SCRAPING"],
        pictureUrl: "https://apify.com/storage/actor-avatars/1/amazon-scraper.png",
        stats: {
            totalUsers: 3456,
            actorReviewCount: 5,
            actorReviewRating: 3.0,
        },
        currentPricingInfo: {
            pricingModel: "FLAT_PRICE_PER_MONTH",
            pricePerUnitUsd: 49.99,
        },
        url: "https://apify.com/junglee/amazon-product-scraper",
    },
];

// Set up mock window.openai for local development
setupMockOpenAi({
    toolOutput: {
        actors: [], // Start with empty to show loading state
        query: "web scraping",
    },
    initialWidgetState: {
        loadingDetails: null,
        isLoading: true, // Start in loading state
    },
});

// Simulate async data loading
setTimeout(() => {
    updateMockOpenAiState({
        toolOutput: {
            actors: mockActors,
            query: "web scraping",
        },
        widgetState: {
            loadingDetails: null,
            isLoading: false,
        },
    });
}, 2000);

renderWidget(ActorSearch);
