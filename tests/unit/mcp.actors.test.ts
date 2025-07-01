import type { ActorDefinition } from 'apify-client';
import { describe, expect, it } from 'vitest';

import { MCP_STREAMABLE_ENDPOINT } from '../../src/const.js';
import { getActorMCPServerPath } from '../../src/mcp/actors.js';

// Helper to create a valid ActorDefinition and allow webServerMcpPath for testing
function makeActorDefinitionWithPath(webServerMcpPath?: unknown): ActorDefinition {
    return {
        actorSpecification: 0,
        name: 'dummy',
        version: '0.0',
        ...(webServerMcpPath !== undefined ? { webServerMcpPath } : {}),
    };
}

describe('getActorMCPServerPath', () => {
    it('should return null if webServerMcpPath is missing', () => {
        const actorDefinition = makeActorDefinitionWithPath();
        const result = getActorMCPServerPath(actorDefinition);
        expect(result).toBeNull();
    });

    it('should return null if webServerMcpPath is not a string', () => {
        const actorDefinition = makeActorDefinitionWithPath(123);
        const result = getActorMCPServerPath(actorDefinition);
        expect(result).toBeNull();
    });

    it('should return the single path if only one is present', () => {
        const actorDefinition = makeActorDefinitionWithPath('/mcp');
        const result = getActorMCPServerPath(actorDefinition);
        expect(result).toBe('/mcp');
    });

    it('should return the streamable path if present among multiple', () => {
        const actorDefinition = makeActorDefinitionWithPath(`/foo, ${MCP_STREAMABLE_ENDPOINT}, /bar`);
        const result = getActorMCPServerPath(actorDefinition);
        expect(result).toBe(MCP_STREAMABLE_ENDPOINT);
    });

    it('should return the first path if streamable is not present', () => {
        const actorDefinition = makeActorDefinitionWithPath('/foo, /bar, /baz');
        const result = getActorMCPServerPath(actorDefinition);
        expect(result).toBe('/foo');
    });

    it('should trim whitespace from paths', () => {
        const actorDefinition = makeActorDefinitionWithPath('   /foo  ,   /bar  ');
        const result = getActorMCPServerPath(actorDefinition);
        expect(result).toBe('/foo');
    });

    it('should handle streamable path with whitespace', () => {
        const actorDefinition = makeActorDefinitionWithPath(` /foo ,   ${MCP_STREAMABLE_ENDPOINT}  , /bar `);
        const result = getActorMCPServerPath(actorDefinition);
        expect(result).toBe(MCP_STREAMABLE_ENDPOINT);
    });
});
