import { OpenAiGlobals } from "../types";
import { MOCK_ACTOR_DETAILS_RESPONSE } from "./mock-actor-details";

interface MockOpenAiConfig {
    toolOutput?: any;
    callTool?: (name: string, args: any) => Promise<any>;
    initialWidgetState?: any;
}

export const setupMockOpenAi = (config: MockOpenAiConfig = {}) => {
    if (typeof window === "undefined" || window.openai) return;

    console.log("Setting up mock openai");

    window.openai = {
        // API methods
        callTool: async (name: string, args: any) => {
            console.log(`Mock callTool: ${name}`, args);

            if (config.callTool) {
                return config.callTool(name, args);
            }

            switch (name) {
                case "fetch-actor-details":
                    console.log(`Returning mock actor details for: ${args.actor}`);
                    return {
                        result: "success",
                        structuredContent: MOCK_ACTOR_DETAILS_RESPONSE.structuredContent
                    };

                default:
                    alert(`Would call tool: ${name}\nWith args: ${JSON.stringify(args, null, 2)}`);
                    return { result: "mock result" };
            }
        },
        sendFollowUpMessage: async (args: { prompt: string }) => {
            console.log("Mock sendFollowUpMessage:", args);
        },
        openExternal: (payload: { href: string }) => {
            console.log("Mock openExternal:", payload);
            window.open(payload.href, "_blank");
        },
        requestDisplayMode: async (args: { mode: any }) => {
            console.log("Mock requestDisplayMode:", args);
            return { mode: args.mode };
        },
        requestModal: async (args: any) => {
            console.log("Mock requestModal:", args);
            return null;
        },
        requestClose: async () => {
            console.log("Mock requestClose");
        },

        // OpenAiGlobals properties
        theme: "dark",
        userAgent: {
            device: { type: "desktop" },
            capabilities: { hover: true, touch: false },
        },
        locale: "en-US",
        maxHeight: 800,
        displayMode: "inline",
        safeArea: {
            insets: { top: 0, bottom: 0, left: 0, right: 0 },
        },
        toolInput: {},
        toolOutput: config.toolOutput || {},
        toolResponseMetadata: null,
        widgetState: config.initialWidgetState || {
            isPolling: false,
            lastUpdateTime: Date.now(),
        },
        setWidgetState: async (state: any) => {
            console.log("Mock setWidgetState:", state);
            if (window.openai) {
                window.openai.widgetState = { ...window.openai.widgetState, ...state };
            }
        },
    } as unknown as OpenAiGlobals & any; // Casting to avoid complex type mocking of every single method signature match perfectly

    // Helper to simulate async data loading if needed
    if (config.toolOutput && Object.keys(config.toolOutput).length === 0) {
        // This part is a bit tricky to generalize, usually the caller handles delayed data updates
        // by dispatching events. We can expose a helper for that.
    }
};

export const updateMockOpenAiState = (updates: Partial<OpenAiGlobals>) => {
    if (typeof window === "undefined" || !window.openai) return;

    // Update local state
    Object.assign(window.openai, updates);

    // Dispatch event to notify listeners (hooks)
    window.dispatchEvent(
        new CustomEvent("openai:set_globals", {
            detail: { globals: updates },
        })
    );
};

