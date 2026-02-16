import { ActorRun } from "../pages/ActorRun/ActorRun";
import { setupMockOpenAi } from "../utils/mock-openai";
import { renderWidget } from "../utils/init-widget";

// Mock data for local development/testing
const mockRunData = {
    runId: "test_run_123",
    actorName: "apify/rag-web-browser",
    actorUsername: "apify",
    status: "RUNNING",
    startedAt: new Date(Date.now() - 30000).toISOString(),
    stats: {
        computeUnits: 0.0123,
    },
};

// Simulate 5-second loading delay to test skeleton
const LOADING_DELAY_MS = 2000;

// Set up mock window.openai for local development
setupMockOpenAi({
    toolOutput: mockRunData, // Start with basic data (no dataset) to show header immediately
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
                                      description: "This is a long description that should test text overflow and ellipsis in table cells",
                                      category: "Technology",
                                      price: "$29.99",
                                      rating: "4.5/5",
                                      date: "2026-02-10"
                                  },
                                  {
                                      title: "Example Page 2",
                                      url: "https://example.com/page-2",
                                      description: "Another lengthy description to ensure we can test horizontal scrolling properly",
                                      category: "Business",
                                      price: "$49.99",
                                      rating: "4.8/5",
                                      date: "2026-02-09"
                                  },
                                  {
                                      title: "Example Page 3",
                                      url: "https://example.com/page-3",
                                      description: "Third item with even more text content for testing purposes",
                                      category: "Science",
                                      price: "$39.99",
                                      rating: "4.2/5",
                                      date: "2026-02-08"
                                  },
                                  {
                                      title: "Example Page 4",
                                      url: "https://example.com/page-4",
                                      description: "Fourth item in the dataset to test vertical scrolling",
                                      category: "Health",
                                      price: "$19.99",
                                      rating: "4.7/5",
                                      date: "2026-02-07"
                                  },
                                  {
                                      title: "Example Page 5",
                                      url: "https://example.com/page-5",
                                      description: "Fifth item with more content to fill the table",
                                      category: "Education",
                                      price: "$59.99",
                                      rating: "4.9/5",
                                      date: "2026-02-06"
                                  },
                                  {
                                      title: "Example Page 6",
                                      url: "https://example.com/page-6",
                                      description: "Sixth item continuing the test data pattern",
                                      category: "Entertainment",
                                      price: "$24.99",
                                      rating: "4.3/5",
                                      date: "2026-02-05"
                                  },
                                  {
                                      title: "Example Page 7",
                                      url: "https://example.com/page-7",
                                      description: "Seventh item with varied content for testing",
                                      category: "Sports",
                                      price: "$34.99",
                                      rating: "4.6/5",
                                      date: "2026-02-04"
                                  },
                                  {
                                      title: "Example Page 8",
                                      url: "https://example.com/page-8",
                                      description: "Eighth item to ensure we have enough rows for scrolling",
                                      category: "Travel",
                                      price: "$44.99",
                                      rating: "4.4/5",
                                      date: "2026-02-03"
                                  },
                                  {
                                      title: "Example Page 9",
                                      url: "https://example.com/page-9",
                                      description: "Ninth item with additional test data",
                                      category: "Food",
                                      price: "$14.99",
                                      rating: "4.1/5",
                                      date: "2026-02-02"
                                  },
                                  {
                                      title: "Example Page 10",
                                      url: "https://example.com/page-10",
                                      description: "Tenth item for comprehensive testing",
                                      category: "Fashion",
                                      price: "$54.99",
                                      rating: "4.8/5",
                                      date: "2026-02-01"
                                  },
                                  {
                                      title: "Example Page 11",
                                      url: "https://example.com/page-11",
                                      description: "Eleventh item to ensure shadow appears correctly",
                                      category: "Music",
                                      price: "$29.99",
                                      rating: "4.5/5",
                                      date: "2026-01-31"
                                  },
                                  {
                                      title: "Example Page 12",
                                      url: "https://example.com/page-12",
                                      description: "Twelfth item for extended testing scenarios",
                                      category: "Art",
                                      price: "$69.99",
                                      rating: "4.9/5",
                                      date: "2026-01-30"
                                  },
                                  {
                                      title: "Example Page 13",
                                      url: "https://example.com/page-13",
                                      description: "Thirteenth item with more varied content",
                                      category: "Finance",
                                      price: "$39.99",
                                      rating: "4.6/5",
                                      date: "2026-01-29"
                                  },
                                  {
                                      title: "Example Page 14",
                                      url: "https://example.com/page-14",
                                      description: "Fourteenth item to test pagination and scrolling limits",
                                      category: "Automotive",
                                      price: "$79.99",
                                      rating: "4.7/5",
                                      date: "2026-01-28"
                                  },
                                  {
                                      title: "Example Page 15",
                                      url: "https://example.com/page-15",
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

// Simulate loading delay - update toolOutput after 5 seconds to add dataset
setTimeout(() => {
    if (window.openai) {
        // Update the toolOutput with dataset to show results
        window.openai.toolOutput = {
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
                        description: "This is a long description that should test text overflow and ellipsis in table cells",
                        category: "Technology",
                        price: "$29.99",
                        rating: "4.5/5",
                        date: "2026-02-10"
                    },
                    {
                        title: "Example Page 2",
                        url: "https://example.com/page-2",
                        description: "Another lengthy description to ensure we can test horizontal scrolling properly",
                        category: "Business",
                        price: "$49.99",
                        rating: "4.8/5",
                        date: "2026-02-09"
                    },
                    {
                        title: "Example Page 3",
                        url: "https://example.com/page-3",
                        description: "Third item with even more text content for testing purposes",
                        category: "Science",
                        price: "$39.99",
                        rating: "4.2/5",
                        date: "2026-02-08"
                    },
                    {
                        title: "Example Page 4",
                        url: "https://example.com/page-4",
                        description: "Fourth item in the dataset to test vertical scrolling",
                        category: "Health",
                        price: "$19.99",
                        rating: "4.7/5",
                        date: "2026-02-07"
                    },
                    {
                        title: "Example Page 5",
                        url: "https://example.com/page-5",
                        description: "Fifth item with more content to fill the table",
                        category: "Education",
                        price: "$59.99",
                        rating: "4.9/5",
                        date: "2026-02-06"
                    },
                ],
            },
        } as any;
        // Trigger a re-render by dispatching an event
        window.dispatchEvent(new Event('openai:set_globals'));
    }
}, LOADING_DELAY_MS);

renderWidget(ActorRun);
