import { ActorRun } from "../pages/ActorRun/ActorRun";
import { setupMockOpenAi } from "../utils/mock-openai";
import { renderWidget } from "../utils/init-widget";

// Mock data for local development/testing
const mockRunData = {
    runId: "test_run_123",
    actorName: "apify/rag-web-browser",
    status: "RUNNING",
    startedAt: new Date(Date.now() - 30000).toISOString(),
};

// Set up mock window.openai for local development
setupMockOpenAi({
    toolOutput: mockRunData,
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
                              itemCount: 5,
                              previewItems: [
                                  { title: "Example 1", url: "https://example.com/1", text: "Some content here..." },
                                  { title: "Example 2", url: "https://example.com/2", text: "More content here..." },
                                  { title: "Example 3", url: "https://example.com/3", text: "Even more content..." },
                              ],
                          }
                        : undefined,
                },
            };
        }
        return { result: "mock result" };
    },
});

renderWidget(ActorRun, "actor-run-root");
