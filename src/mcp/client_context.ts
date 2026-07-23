// The ext-apps package exposes `./server` via conditional exports only (no `./server/index.js`
// wildcard), so we can't satisfy the `import/extensions` rule on this subpath.
// eslint-disable-next-line import/extensions
import { getUiCapability, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';

export type McpClientContext = {
    readonly protocolVersion?: string;
    readonly clientInfo?: {
        readonly name: string;
        readonly version: string;
    };
    readonly capabilities?: Readonly<Record<string, unknown>>;
};

type McpInitializeParams = {
    protocolVersion?: string;
    clientInfo?: {
        name: string;
        version: string;
    };
    capabilities?: Record<string, unknown>;
};

export function buildMcpClientContext(params: McpInitializeParams | undefined): McpClientContext | undefined {
    if (!params) return undefined;

    return {
        ...(params.protocolVersion !== undefined && { protocolVersion: params.protocolVersion }),
        ...(params.clientInfo !== undefined && { clientInfo: { ...params.clientInfo } }),
        ...(params.capabilities !== undefined && { capabilities: structuredClone(params.capabilities) }),
    };
}

export function isUiSupportedByClient(context: McpClientContext | undefined): boolean {
    const uiCapability = getUiCapability(context?.capabilities as Parameters<typeof getUiCapability>[0]);
    return uiCapability?.mimeTypes?.includes(RESOURCE_MIME_TYPE) ?? false;
}
