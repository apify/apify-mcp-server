import type { InitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { mcpClients } from 'mcp-client-capabilities';

/**
 * True when the connecting client is an Anthropic surface (Claude.ai, Claude Desktop, Claude Code).
 * Matches a substring of the self-reported client name so new Claude clients are covered without a
 * maintained allowlist; over-matching only hides an optional tool, which is the safe failure mode.
 */
export function isAnthropicClient(initializeRequestData?: InitializeRequest): boolean {
    const clientName = initializeRequestData?.params?.clientInfo?.name?.toLowerCase() ?? '';
    return clientName.includes('claude') || clientName.includes('anthropic');
}

/**
 * Determines if the MCP client supports dynamic tools based on the InitializeRequest data.
 */
export function doesMcpClientSupportDynamicTools(initializeRequestData?: InitializeRequest): boolean {
    const clientName = initializeRequestData?.params?.clientInfo?.name;
    const clientCapabilities = mcpClients[clientName || ''];
    if (!clientCapabilities) return false;

    const clientProtocolVersion = clientCapabilities.protocolVersion;
    const knownProtocolVersion = initializeRequestData?.params?.protocolVersion;

    // Compare the protocolVersion to check if the client is up to date
    // We check for strict equality because if the versions differ, we cannot be sure about the capabilities
    if (clientProtocolVersion !== knownProtocolVersion) {
        // Client version is different from the known version, we cannot be sure about its capabilities
        return false;
    }

    return clientCapabilities.tools?.listChanged === true;
}
