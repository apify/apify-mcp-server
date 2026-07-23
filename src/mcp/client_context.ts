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
        // The SDK's `Implementation`/`clientInfo` shape carries optional nested fields (`icons[]`,
        // `title`, `websiteUrl`, `description`) beyond {name, version}, so clone it the same way as
        // capabilities — a shallow spread would share those nested objects/arrays by reference.
        ...(params.clientInfo !== undefined && { clientInfo: structuredClone(params.clientInfo) }),
        ...(params.capabilities !== undefined && { capabilities: structuredClone(params.capabilities) }),
    };
}

export function isUiSupportedByClient(context: McpClientContext | undefined): boolean {
    // `context.capabilities` is our protocol-neutral `Record<string, unknown>`; `getUiCapability` is
    // an upstream ext-apps helper expecting its own SDK-typed capabilities shape. The runtime value is
    // the same object either way, so this cast only crosses that type boundary.
    const uiCapability = getUiCapability(context?.capabilities as Parameters<typeof getUiCapability>[0]);
    return uiCapability?.mimeTypes?.includes(RESOURCE_MIME_TYPE) ?? false;
}
