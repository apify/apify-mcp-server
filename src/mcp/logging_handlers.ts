import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SetLevelRequestSchema } from '@modelcontextprotocol/sdk/types.js';

type SetupLoggingProxyParams = {
    server: Server;
    logLevelMap: Record<string, number>;
    getCurrentLogLevel: () => string;
};

type SetupLoggingHandlersParams = {
    server: Server;
    logLevelMap: Record<string, number>;
    setCurrentLogLevel: (level: string) => void;
};

/**
 * Proxies server logging and filters messages by the current client log level.
 */
export function setupLoggingProxy({
    server,
    logLevelMap,
    getCurrentLogLevel,
}: SetupLoggingProxyParams): void {
    const mcpServer = server;
    // Store original sendLoggingMessage
    const originalSendLoggingMessage = mcpServer.sendLoggingMessage.bind(mcpServer);

    // Proxy sendLoggingMessage to filter logs
    mcpServer.sendLoggingMessage = async (params: { level: string; data?: unknown; [key: string]: unknown }) => {
        const messageLevelValue = logLevelMap[params.level] ?? -1; // Unknown levels get -1, discard
        const currentLevelValue = logLevelMap[getCurrentLogLevel()] ?? logLevelMap.info; // Default to info if invalid
        if (messageLevelValue >= currentLevelValue) {
            await originalSendLoggingMessage(params as Parameters<typeof originalSendLoggingMessage>[0]);
        }
    };
}

/**
 * Registers the MCP logging level request handler.
 */
export function setupLoggingHandlers({
    server,
    logLevelMap,
    setCurrentLogLevel,
}: SetupLoggingHandlersParams): void {
    server.setRequestHandler(SetLevelRequestSchema, (request) => {
        const { level } = request.params;
        if (logLevelMap[level] !== undefined) {
            setCurrentLogLevel(level);
        }
        // Sending empty result based on MCP spec
        return {};
    });
}
