import type { App, McpUiHostContext } from '@modelcontextprotocol/ext-apps';
import { useApp } from '@modelcontextprotocol/ext-apps/react';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createContext, useContext, useEffect, useRef, useState } from 'react';

interface McpAppState {
    app: App | null;
    toolResult: CallToolResult | null;
    hostContext: McpUiHostContext | undefined;
}

const McpAppContext = createContext<McpAppState | null>(null);

/**
 * Claude Desktop strips `structuredContent` (and `_meta`) from the
 * `ui/notifications/tool-result` notification — the widget receives only `content`/`isError`
 * (https://github.com/modelcontextprotocol/ext-apps/issues/696). Two recovery paths:
 *
 * 1. Parse `content[0]` as JSON — the run-widget tools mirror `structuredContent` there,
 *    so recovery is free and never re-executes anything.
 * 2. Re-call the tool via the host's `tools/call` proxy, which returns the full
 *    `CallToolResult` intact. Only for read-only tools: the widget entry supplies
 *    `refetchToolForArgs` mapping the captured tool-input args to an idempotent tool name
 *    (or null to skip). Never used for run-starting tools.
 *
 * Both paths are no-ops on hosts that deliver `structuredContent` (claude.ai, ChatGPT,
 * MCP Jam). When ext-apps#696 is fixed, remove the workaround: grep for "ext-apps#696" —
 * this block, the `refetchToolForArgs` wiring in init-widget/entries, and the AGENTS.md note.
 */
export type RefetchToolForArgs = (args: Record<string, unknown>) => string | null;

function parseStructuredContentFromText(result: CallToolResult): Record<string, unknown> | null {
    const first = result.content?.[0];
    if (first?.type !== 'text') return null;
    try {
        const parsed: unknown = JSON.parse(first.text);
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

/**
 * Provides a single MCP Apps connection (via `useApp()`) shared across all widget components.
 *
 * The ext-apps SDK's `useApp()` creates a `PostMessageTransport` that speaks JSON-RPC
 * with the host (ChatGPT, MCP Jam, etc.) over postMessage. Tool results arrive via
 * `ui/notifications/tool-result`, and host context (theme, viewport) via
 * `ui/notifications/host-context-changed`.
 *
 * ChatGPT quirk: on the first widget in a conversation, ChatGPT must HTTP-fetch the
 * resource template. The tool often completes before the iframe loads, so the MCP Apps
 * bridge never sends `tool-result`. As a workaround, we read `window.openai.toolOutput`
 * (set synchronously by ChatGPT's Apps SDK compatibility layer) as initial data.
 * See the `receivedViaBridge` ref and the `useEffect` below.
 */
export function McpAppProvider({
    children,
    refetchToolForArgs,
}: {
    children: React.ReactNode;
    refetchToolForArgs?: RefetchToolForArgs;
}) {
    const [toolResult, setToolResult] = useState<CallToolResult | null>(null);
    const [hostContext, setHostContext] = useState<McpUiHostContext | undefined>();
    const receivedViaBridge = useRef(false);
    const lastToolArgs = useRef<Record<string, unknown> | null>(null);

    const { app } = useApp({
        appInfo: { name: 'Apify MCP Widget', version: '1.0.0' },
        capabilities: {},
        onAppCreated: (createdApp) => {
            createdApp.ontoolresult = (result) => {
                receivedViaBridge.current = true;
                if (!result.structuredContent && !result.isError) {
                    // Claude Desktop strips structuredContent from the notification (ext-apps#696).
                    const parsed = parseStructuredContentFromText(result);
                    if (parsed) {
                        setToolResult({ ...result, structuredContent: parsed });
                        return;
                    }
                    const args = lastToolArgs.current;
                    const refetchTool = args ? (refetchToolForArgs?.(args) ?? null) : null;
                    if (refetchTool) {
                        createdApp
                            .callServerTool({ name: refetchTool, arguments: args ?? {} })
                            .then((full) => setToolResult(full.structuredContent ? full : result))
                            .catch(() => setToolResult(result));
                        return;
                    }
                }
                setToolResult(result);
            };
            createdApp.onhostcontextchanged = (ctx) => setHostContext((prev) => ({ ...prev, ...ctx }));
            createdApp.ontoolinput = (params) => {
                lastToolArgs.current = params.arguments ?? null;
            };
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
            const { toolOutput } = window.openai ?? {};
            if (toolOutput) {
                setToolResult({
                    content: [],
                    structuredContent: toolOutput,
                });
            }
        }
    }, [app]);

    return <McpAppContext.Provider value={{ app, toolResult, hostContext }}>{children}</McpAppContext.Provider>;
}

export function useMcpApp(): McpAppState {
    const ctx = useContext(McpAppContext);
    if (!ctx) throw new Error('useMcpApp must be used within McpAppProvider');
    return ctx;
}
