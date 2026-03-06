import { MOCK_ACTOR_DETAILS_RESPONSE } from "./mock-actor-details";

interface MockOpenAiConfig {
    toolOutput?: any;
    toolResponseMetadata?: any;
    callTool?: (name: string, args: any) => Promise<any>;
    initialWidgetState?: any;
}

/**
 * Sets up a mock `window.openai` for local development.
 * The MCP Apps SDK auto-detects `window.openai` and uses its OpenAI transport,
 * so this mock makes dev mode work transparently with `useApp()`.
 */
export const setupMockOpenAi = (config: MockOpenAiConfig = {}) => {
    if (typeof window === "undefined" || (window as any).openai) return;

    console.log("Setting up mock openai");

    (window as any).openai = {
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
        toolResponseMetadata: config.toolResponseMetadata || null,
        widgetState: config.initialWidgetState || {
            isPolling: false,
            lastUpdateTime: Date.now(),
        },
        setWidgetState: async (state: any) => {
            console.log("Mock setWidgetState:", state);
            if ((window as any).openai) {
                (window as any).openai.widgetState = { ...(window as any).openai.widgetState, ...state };
            }
        },
    };
};

export const updateMockOpenAiState = (updates: Record<string, unknown>) => {
    if (typeof window === "undefined" || !(window as any).openai) return;

    // Update local state
    Object.assign((window as any).openai, updates);

    // Dispatch event to notify listeners (SDK's OpenAI transport listens for this)
    window.dispatchEvent(
        new CustomEvent("openai:set_globals", {
            detail: { globals: updates },
        })
    );
};
