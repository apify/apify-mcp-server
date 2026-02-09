import { renderWidget } from "../utils/init-widget";
import { ActorRun } from "../pages/ActorRun/ActorRun";
import { setupMockOpenAi } from "../utils/mock-openai";

// Mock data for local development/testing
const mockRunData = {
    runId: "run_abc123",
    actorName: "Website Content Crawler",
    actorUsername: "apify",
    status: "SUCCEEDED",
    startedAt: "2025-01-09T14:30:00.000Z",
    finishedAt: "2025-01-09T14:30:59.000Z",
    stats: {
        computeUnits: 0.014,
    },
    dataset: {
        datasetId: "dataset_xyz789",
        itemCount: 200,
        previewItems: [
            {
                title: "Tweet Scraper",
                name: "tweet-scraper",
                username: "apidojo",
                stats: "12 fields",
                description: "⚡ Lightning-fast Twitter scraper"
            },
            {
                title: "Google Maps Scraper",
                name: "crawler-google-places",
                username: "compass",
                stats: "12 fields",
                description: "Extract data from Google Maps"
            },
            {
                title: "Website Content Crawler",
                name: "website-content-crawler",
                username: "apify",
                stats: "12 fields",
                description: "Extract content from websites"
            },
            {
                title: "TikTok Scraper",
                name: "tiktok-scraper",
                username: "clockworks",
                stats: "8 fields",
                description: "Scrape TikTok videos and profiles"
            }
        ]
    }
};

// Set up mock window.openai for local development
setupMockOpenAi({
    toolOutput: mockRunData,
    initialWidgetState: {
        isRefreshing: false,
        lastUpdateTime: Date.now(),
    },
});

renderWidget(ActorRun, "actor-run-new-root");
