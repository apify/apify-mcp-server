// The ext-apps package exposes `./server` via conditional exports only (no `./server/index.js`
// wildcard), so we can't satisfy the `import/extensions` rule on this subpath.
// eslint-disable-next-line import/extensions
import { getUiCapability, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import type { ClientCapabilities, Implementation, InitializeRequestParams } from '@modelcontextprotocol/sdk/types.js';

export type McpClientContext = {
    readonly protocolVersion?: string;
    readonly clientInfo?: Readonly<Implementation>;
    readonly capabilities?: Readonly<ClientCapabilities> & Readonly<Record<string, unknown>>;
};

type McpInitializeParams = Partial<Pick<InitializeRequestParams, 'protocolVersion' | 'clientInfo' | 'capabilities'>>;

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
    // `Readonly<ClientCapabilities>` and the ext-apps helper's capabilities type describe the same
    // runtime object; this cast only crosses their type boundary.
    const uiCapability = getUiCapability(context?.capabilities as Parameters<typeof getUiCapability>[0]);
    return uiCapability?.mimeTypes?.includes(RESOURCE_MIME_TYPE) ?? false;
}
