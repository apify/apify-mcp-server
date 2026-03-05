import { createContext, useContext, useEffect, useState } from "react";
import type { App, McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

interface McpAppState {
    app: App | null;
    isConnected: boolean;
    error: Error | null;
    toolResult: CallToolResult | null;
    hostContext: McpUiHostContext | undefined;
}

const McpAppContext = createContext<McpAppState | null>(null);

export function McpAppProvider({ children }: { children: React.ReactNode }) {
    const [toolResult, setToolResult] = useState<CallToolResult | null>(null);
    const [hostContext, setHostContext] = useState<McpUiHostContext | undefined>();

    const { app, isConnected, error } = useApp({
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

    return (
        <McpAppContext.Provider
            value={{ app, isConnected, error, toolResult, hostContext }}
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
