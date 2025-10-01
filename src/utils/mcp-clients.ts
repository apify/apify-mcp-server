import type { InitializeRequest } from '@modelcontextprotocol/sdk/types';
import mcpClients from 'mcp-client-capabilities';

/**
 * Determines if the MCP client supports dynamic tools based on the InitializeRequest data.
 */
export function doesMcpClientSupportDynamicTools(initializeRequestData?: InitializeRequest): boolean {
    const clientCapabilities = mcpClients[initializeRequestData?.params?.clientInfo?.name || ''];
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
