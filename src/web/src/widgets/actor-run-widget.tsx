import { ActorRun } from "../pages/ActorRun/ActorRun";
import { setupMockOpenAi, updateMockOpenAiState } from "../utils/mock-openai";
import { renderWidget } from "../utils/init-widget";

// Mock data for local development/testing
const mockRunData = {
    runId: "test_run_123",
    actorName: "apify/rag-web-browser", // Full name with username
    status: "RUNNING",
    startedAt: new Date(Date.now() - 30000).toISOString(),
    stats: {
        computeUnits: 0.0123,
    },
};

// Mock toolResponseMetadata (_meta) with real USD cost
const mockToolResponseMetadata = {
    usageTotalUsd: 0.0456,
};

// Simulate a 5-second loading delay to test skeleton
const LOADING_DELAY_MS = 2000;

// Set up mock window.openai for local development (no-ops when window.openai already exists)
const isMockEnvironment = typeof window !== "undefined" && !window.openai;

setupMockOpenAi({
    toolOutput: mockRunData, // Start with basic data (no dataset) to show header immediately
    toolResponseMetadata: mockToolResponseMetadata, // Real USD cost from _meta
    initialWidgetState: {
        isPolling: false,
        lastUpdateTime: Date.now(),
    },
    callTool: async (name: string, args: any) => {
        // Simulate get-actor-run tool
        if (name === "get-actor-run") {
            const runtime = Date.now() - new Date(mockRunData.startedAt).getTime();
            const isComplete = runtime > 10000; // Complete after 10 seconds

            return {
                result: "success",
                _meta: {
                    usageTotalUsd: isComplete ? 0.0456 : 0.0123,
                },
                structuredContent: {
                    runId: args.runId || "test_run_123",
                    actorName: "apify/rag-web-browser",
                    status: isComplete ? "SUCCEEDED" : "RUNNING",
                    startedAt: mockRunData.startedAt,
                    finishedAt: isComplete ? new Date().toISOString() : undefined,
                    stats: {
                        computeUnits: 0.0123,
                        memoryMaxBytes: 134217728,
                    },
                    dataset: isComplete
                        ? {
                              datasetId: "test_dataset_456",
                              itemCount: 15,
                              previewItems: [
                                  {
                                      title: "Example Page 1",
                                      url: "https://example.com/page-1",
                                      crawl: { loadedUrl: "https://example.com/page-1", httpStatusCode: 200, depth: 0, contentType: "text/html" },
                                      description: "This is a long description that should test text overflow and ellipsis in table cells",
                                      category: "Technology",
                                      price: "$29.99",
                                      rating: "4.5/5",
                                      date: "2026-02-10"
                                  },
                                  {
                                      title: "Example Page 2",
                                      url: "https://example.com/page-2",
                                      crawl: { loadedUrl: "https://example.com/page-2", httpStatusCode: 200, depth: 1, contentType: "text/html" },
                                      description: "Another lengthy description to ensure we can test horizontal scrolling properly",
                                      category: "Business",
                                      price: "$49.99",
                                      rating: "4.8/5",
                                      date: "2026-02-09"
                                  },
                                  {
                                      title: "Example Page 3",
                                      url: "https://example.com/page-3",
                                      crawl: { loadedUrl: "https://example.com/page-3", httpStatusCode: 404, depth: 2, contentType: "text/html" },
                                      description: "Third item with even more text content for testing purposes",
                                      category: "Science",
                                      price: "$39.99",
                                      rating: "4.2/5",
                                      date: "2026-02-08"
                                  },
                                  {
                                      title: "Example Page 4",
                                      url: "https://example.com/page-4",
                                      crawl: { loadedUrl: "https://example.com/page-4", httpStatusCode: 200, depth: 0, contentType: "text/html" },
                                      description: "Fourth item in the dataset to test vertical scrolling",
                                      category: "Health",
                                      price: "$19.99",
                                      rating: "4.7/5",
                                      date: "2026-02-07"
                                  },
                                  {
                                      title: "Example Page 5",
                                      url: "https://example.com/page-5",
                                      crawl: { loadedUrl: "https://example.com/page-5", httpStatusCode: 200, depth: 1, contentType: "text/html" },
                                      description: "Fifth item with more content to fill the table",
                                      category: "Education",
                                      price: "$59.99",
                                      rating: "4.9/5",
                                      date: "2026-02-06"
                                  },
                                  {
                                      title: "Example Page 6",
                                      url: "https://example.com/page-6",
                                      crawl: { loadedUrl: "https://example.com/page-6", httpStatusCode: 200, depth: 0, contentType: "text/html" },
                                      description: "Sixth item continuing the test data pattern",
                                      category: "Entertainment",
                                      price: "$24.99",
                                      rating: "4.3/5",
                                      date: "2026-02-05"
                                  },
                                  {
                                      title: "Example Page 7",
                                      url: "https://example.com/page-7",
                                      crawl: { loadedUrl: "https://example.com/page-7", httpStatusCode: 200, depth: 2, contentType: "text/html" },
                                      description: "Seventh item with varied content for testing",
                                      category: "Sports",
                                      price: "$34.99",
                                      rating: "4.6/5",
                                      date: "2026-02-04"
                                  },
                                  {
                                      title: "Example Page 8",
                                      url: "https://example.com/page-8",
                                      crawl: { loadedUrl: "https://example.com/page-8", httpStatusCode: 200, depth: 1, contentType: "text/html" },
                                      description: "Eighth item to ensure we have enough rows for scrolling",
                                      category: "Travel",
                                      price: "$44.99",
                                      rating: "4.4/5",
                                      date: "2026-02-03"
                                  },
                                  {
                                      title: "Example Page 9",
                                      url: "https://example.com/page-9",
                                      crawl: { loadedUrl: "https://example.com/page-9", httpStatusCode: 200, depth: 0, contentType: "text/html" },
                                      description: "Ninth item with additional test data",
                                      category: "Food",
                                      price: "$14.99",
                                      rating: "4.1/5",
                                      date: "2026-02-02"
                                  },
                                  {
                                      title: "Example Page 10",
                                      url: "https://example.com/page-10",
                                      crawl: { loadedUrl: "https://example.com/page-10", httpStatusCode: 200, depth: 3, contentType: "text/html" },
                                      description: "Tenth item for comprehensive testing",
                                      category: "Fashion",
                                      price: "$54.99",
                                      rating: "4.8/5",
                                      date: "2026-02-01"
                                  },
                                  {
                                      title: "Example Page 11",
                                      url: "https://example.com/page-11",
                                      crawl: { loadedUrl: "https://example.com/page-11", httpStatusCode: 200, depth: 0, contentType: "text/html" },
                                      description: "Eleventh item to ensure shadow appears correctly",
                                      category: "Music",
                                      price: "$29.99",
                                      rating: "4.5/5",
                                      date: "2026-01-31"
                                  },
                                  {
                                      title: "Example Page 12",
                                      url: "https://example.com/page-12",
                                      crawl: { loadedUrl: "https://example.com/page-12", httpStatusCode: 200, depth: 1, contentType: "text/html" },
                                      description: "Twelfth item for extended testing scenarios",
                                      category: "Art",
                                      price: "$69.99",
                                      rating: "4.9/5",
                                      date: "2026-01-30"
                                  },
                                  {
                                      title: "Example Page 13",
                                      url: "https://example.com/page-13",
                                      crawl: { loadedUrl: "https://example.com/page-13", httpStatusCode: 200, depth: 2, contentType: "text/html" },
                                      description: "Thirteenth item with more varied content",
                                      category: "Finance",
                                      price: "$39.99",
                                      rating: "4.6/5",
                                      date: "2026-01-29"
                                  },
                                  {
                                      title: "Example Page 14",
                                      url: "https://example.com/page-14",
                                      crawl: { loadedUrl: "https://example.com/page-14", httpStatusCode: 200, depth: 0, contentType: "text/html" },
                                      description: "Fourteenth item to test pagination and scrolling limits",
                                      category: "Automotive",
                                      price: "$79.99",
                                      rating: "4.7/5",
                                      date: "2026-01-28"
                                  },
                                  {
                                      title: "Example Page 15",
                                      url: "https://example.com/page-15",
                                      crawl: { loadedUrl: "https://example.com/page-15", httpStatusCode: 200, depth: 1, contentType: "text/html" },
                                      description: "Fifteenth and final item in the test dataset",
                                      category: "Real Estate",
                                      price: "$99.99",
                                      rating: "5.0/5",
                                      date: "2026-01-27"
                                  },
                              ],
                          }
                        : undefined,
                },
            };
        }
        return { result: "mock result" };
    },
});

// Simulate loading delay - update toolOutput after delay to add dataset (only in local dev)
if (isMockEnvironment) {
    setTimeout(() => {
        updateMockOpenAiState({
            toolOutput: {
                ...mockRunData,
                status: "SUCCEEDED",
                finishedAt: new Date().toISOString(),
                dataset: {
                    datasetId: "test_dataset_456",
                    itemCount: 15,
                    previewItems: [
                        {
                            title: "Example Page 1",
                            url: "https://example.com/page-1",
                            crawl: { loadedUrl: "https://example.com/page-1", httpStatusCode: 200, depth: 0, contentType: "text/html" },
                            description: "This is a long description that should test text overflow and ellipsis in table cells",
                            category: "Technology",
                            price: "$29.99",
                            rating: "4.5/5",
                            date: "2026-02-10"
                        },
                        {
                            title: "Example Page 2",
                            url: "https://example.com/page-2",
                            crawl: { loadedUrl: "https://example.com/page-2", httpStatusCode: 200, depth: 1, contentType: "text/html" },
                            description: "Another lengthy description to ensure we can test horizontal scrolling properly",
                            category: "Business",
                            price: "$49.99",
                            rating: "4.8/5",
                            date: "2026-02-09"
                        },
                        {
                            title: "Example Page 3",
                            url: "https://example.com/page-3",
                            crawl: { loadedUrl: "https://example.com/page-3", httpStatusCode: 404, depth: 2, contentType: "text/html" },
                            description: "Third item with even more text content for testing purposes",
                            category: "Science",
                            price: "$39.99",
                            rating: "4.2/5",
                            date: "2026-02-08"
                        },
                        {
                            title: "Example Page 4",
                            url: "https://example.com/page-4",
                            crawl: { loadedUrl: "https://example.com/page-4", httpStatusCode: 200, depth: 0, contentType: "text/html" },
                            description: "Fourth item in the dataset to test vertical scrolling",
                            category: "Health",
                            price: "$19.99",
                            rating: "4.7/5",
                            date: "2026-02-07"
                        },
                        {
                            title: "Example Page 5",
                            url: "https://example.com/page-5",
                            crawl: { loadedUrl: "https://example.com/page-5", httpStatusCode: 200, depth: 1, contentType: "text/html" },
                            description: "Fifth item with more content to fill the table",
                            category: "Education",
                            price: "$59.99",
                            rating: "4.9/5",
                            date: "2026-02-06"
                        },
                    ],
                },
            },
        });
    }, LOADING_DELAY_MS);
}

renderWidget(ActorRun);
