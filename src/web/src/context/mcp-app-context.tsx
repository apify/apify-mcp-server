import { createContext, useContext, useEffect, useState } from "react";
import type { App, McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

interface McpAppState {
    app: App | null;
    toolResult: CallToolResult | null;
    hostContext: McpUiHostContext | undefined;
}

const McpAppContext = createContext<McpAppState | null>(null);

// TODO(mcp-apps): Remove this OpenAI globals fallback once ChatGPT consistently
// delivers initial and subsequent widget data via MCP Apps notifications only.
function getLegacyToolResultFromOpenAi(): CallToolResult | null {
    if (typeof window === "undefined" || !(window as any).openai) {
        return null;
    }

    const openai = (window as any).openai as {
        toolOutput?: unknown;
        toolResponseMetadata?: unknown;
    };

    if (!openai.toolOutput) {
        return null;
    }

    return {
        content: [],
        structuredContent: openai.toolOutput as Record<string, unknown>,
        _meta: (openai.toolResponseMetadata as Record<string, unknown> | null) ?? undefined,
    };
}

export function McpAppProvider({ children }: { children: React.ReactNode }) {
    const [toolResult, setToolResult] = useState<CallToolResult | null>(() => getLegacyToolResultFromOpenAi());
    const [hostContext, setHostContext] = useState<McpUiHostContext | undefined>();

    const { app } = useApp({
        appInfo: { name: "Apify MCP Widget", version: "1.0.0" },
        capabilities: {},
        onAppCreated: (createdApp) => {
            createdApp.ontoolresult = (result) => setToolResult(result);
            createdApp.onhostcontextchanged = (ctx) =>
                setHostContext((prev) => ({ ...prev, ...ctx }));
        },
    });

    useEffect(() => {
        if (app) setHostContext(app.getHostContext());
    }, [app]);

    useEffect(() => {
        // Keep listening to the legacy OpenAI bridge while migration is in progress.
        const handleOpenAiGlobalsUpdate = () => {
            const legacyResult = getLegacyToolResultFromOpenAi();
            if (legacyResult) {
                setToolResult(legacyResult);
            }
        };

        window.addEventListener("openai:set_globals", handleOpenAiGlobalsUpdate as EventListener);
        handleOpenAiGlobalsUpdate();

        return () => {
            window.removeEventListener("openai:set_globals", handleOpenAiGlobalsUpdate as EventListener);
        };
    }, []);

    return (
        <McpAppContext.Provider
            value={{ app, toolResult, hostContext }}
        >
            {children}
        </McpAppContext.Provider>
    );
}

export function useMcpApp(): McpAppState {
    const ctx = useContext(McpAppContext);
    if (!ctx) throw new Error("useMcpApp must be used within McpAppProvider");
    return ctx;
}
