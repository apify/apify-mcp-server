import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { MOCK_ACTOR_DETAILS_RESPONSE } from "./mock-actor-details";

interface MockHostConfig {
    toolOutput?: Record<string, unknown>;
    toolResponseMetadata?: Record<string, unknown> | null;
    callTool?: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    initialWidgetState?: Record<string, unknown>;
}

let bridge: AppBridge | null = null;

/**
 * Sets up a mock MCP Apps host for local development using the SDK's AppBridge.
 *
 * In dev mode the widget loads directly in the browser (not in a host iframe),
 * so `window.parent === window`. AppBridge + PostMessageTransport handle
 * the JSON-RPC handshake and echo-filtering automatically.
 *
 * Also sets `window.openai.toolOutput` for the ChatGPT race-condition fallback
 * in mcp-app-context.tsx (ChatGPT sets this synchronously; the fallback reads
 * it when tool-result arrives late over the bridge).
 */
export const setupMockOpenAi = (config: MockHostConfig = {}) => {
    if (typeof window === "undefined" || window.openai) return;

    console.log("[mock-host] Setting up MCP Apps mock host");

    // ChatGPT toolOutput fallback — see mcp-app-context.tsx
    window.openai = {
        toolOutput: config.toolOutput || {},
        toolResponseMetadata: config.toolResponseMetadata || null,
    };

    const toolResult: CallToolResult = {
        content: [],
        structuredContent: config.toolOutput || {},
    };

    bridge = new AppBridge(
        null, // no MCP client — we handle tool calls manually
        { name: "Dev Mock Host", version: "1.0.0" },
        {
            updateModelContext: { text: {}, structuredContent: {} },
            message: { text: {} },
            openLinks: {},
        },
        {
            hostContext: {
                theme: "light",
                displayMode: "inline",
                platform: "web",
                locale: "en-US",
            },
        },
    );

    bridge.oninitialized = () => {
        console.log("[mock-host] App initialized, sending tool result");
        bridge!.sendToolResult(toolResult);
    };

    bridge.oncalltool = async (params): Promise<CallToolResult> => {
        const toolName = params.name;
        const toolArgs = (params.arguments || {}) as Record<string, unknown>;
        console.log(`[mock-host] tools/call: ${toolName}`, toolArgs);

        if (config.callTool) {
            const result = await config.callTool(toolName, toolArgs);
            return {
                content: [],
                structuredContent: (result.structuredContent ?? result) as Record<string, unknown>,
                ...(result._meta ? { _meta: result._meta as Record<string, unknown> } : {}),
            };
        }

        if (toolName === "fetch-actor-details") {
            return {
                content: [],
                structuredContent: MOCK_ACTOR_DETAILS_RESPONSE.structuredContent as Record<string, unknown>,
            };
        }

        console.warn(`[mock-host] No mock handler for tool: ${toolName}`);
        return { content: [] };
    };

    bridge.onopenlink = async ({ url }) => {
        console.log("[mock-host] openLink", url);
        if (url) window.open(url, "_blank");
        return {};
    };

    bridge.onupdatemodelcontext = async (params) => {
        console.log("[mock-host] updateModelContext", params);
        return {};
    };

    bridge.onmessage = async (params) => {
        console.log("[mock-host] message", params);
        return {};
    };

    bridge.onrequestdisplaymode = async ({ mode }) => {
        console.log("[mock-host] requestDisplayMode", mode);
        return { mode };
    };

    const transport = new PostMessageTransport(window, window);
    bridge.connect(transport).catch((err: unknown) => {
        console.error("[mock-host] Failed to connect:", err);
    });
};

export const updateMockOpenAiState = (updates: Record<string, unknown>) => {
    if (typeof window === "undefined") return;

    // Update window.openai for the ChatGPT fallback
    if (window.openai) {
        Object.assign(window.openai, updates);
    }

    // Send tool result via the bridge so the ext-apps SDK picks up the update
    if (bridge && updates.toolOutput !== undefined) {
        const result: CallToolResult = {
            content: [],
            structuredContent: updates.toolOutput as Record<string, unknown>,
        };
        bridge.sendToolResult(result);
    }
};
