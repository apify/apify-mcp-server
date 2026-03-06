import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { App, McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

interface McpAppState {
    app: App | null;
    toolResult: CallToolResult | null;
    hostContext: McpUiHostContext | undefined;
}

const McpAppContext = createContext<McpAppState | null>(null);

export function McpAppProvider({ children }: { children: React.ReactNode }) {
    const [toolResult, setToolResult] = useState<CallToolResult | null>(null);
    const [hostContext, setHostContext] = useState<McpUiHostContext | undefined>();
    const receivedViaBridge = useRef(false);

    const { app } = useApp({
        appInfo: { name: "Apify MCP Widget", version: "1.0.0" },
        capabilities: {},
        onAppCreated: (createdApp) => {
            createdApp.ontoolresult = (result) => {
                receivedViaBridge.current = true;
                setToolResult(result);
            };
            createdApp.onhostcontextchanged = (ctx) =>
                setHostContext((prev) => ({ ...prev, ...ctx }));
        },
    });

    useEffect(() => {
        if (!app) return;
        setHostContext(app.getHostContext());

        // ChatGPT sets window.openai.toolOutput synchronously as an Apps SDK
        // compatibility layer. When the tool completes before the iframe loads
        // (first widget in a conversation), the MCP Apps bridge never sends
        // ui/notifications/tool-result. Read the sync value as initial data.
        if (!receivedViaBridge.current) {
            const openai = (window as any).openai;
            if (openai?.toolOutput) {
                setToolResult({
                    content: [],
                    structuredContent: openai.toolOutput,
                });
            }
        }
    }, [app]);

    return (
        <McpAppContext.Provider value={{ app, toolResult, hostContext }}>
            {children}
        </McpAppContext.Provider>
    );
}

export function useMcpApp(): McpAppState {
    const ctx = useContext(McpAppContext);
    if (!ctx) throw new Error("useMcpApp must be used within McpAppProvider");
    return ctx;
}
