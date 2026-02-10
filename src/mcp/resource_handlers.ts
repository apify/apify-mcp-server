import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
    ListResourcesRequestSchema,
    ListResourceTemplatesRequestSchema,
    ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { createResourceService } from '../resources/resource_service.js';
import type { AvailableWidget } from '../resources/widgets.js';

type RegisterResourceHandlersParams = {
    server: Server;
    skyfireMode?: boolean;
    uiMode?: 'openai';
    getAvailableWidgets: () => Map<string, AvailableWidget>;
};

/**
 * Registers MCP resource handlers.
 */
export function registerResourceHandlers({
    server,
    skyfireMode,
    uiMode,
    getAvailableWidgets,
}: RegisterResourceHandlersParams): void {
    const resourceService = createResourceService({
        skyfireMode,
        uiMode,
        getAvailableWidgets,
    });

    server.setRequestHandler(ListResourcesRequestSchema, async () => {
        return await resourceService.listResources();
    });

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        return await resourceService.readResource(request.params.uri);
    });

    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
        return await resourceService.listResourceTemplates();
    });
}
