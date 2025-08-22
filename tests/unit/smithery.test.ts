import { beforeEach, describe, expect, it, vi } from 'vitest';

import log from '@apify/log';

import { ActorsMcpServer } from '../../src/mcp/server.js';
import smithery from '../../src/smithery.js';
import * as toolsLoader from '../../src/utils/tools-loader.js';

// Silence logs in unit tests
log.setLevel(log.LEVELS.OFF);

describe('smithery entrypoint barrier behavior', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('calls blockListToolsUntil', async () => {
        // Arrange
        const blockSpy = vi.spyOn(ActorsMcpServer.prototype, 'blockListToolsUntil');
        const loadSpy = vi.spyOn(toolsLoader, 'loadToolsFromInput').mockResolvedValue([]);

        // Act
        const server = smithery({ config: { apifyToken: 'TEST_TOKEN', enableAddingActors: true, enableActorAutoLoading: true } });

        // Assert
        expect(server).toBeTruthy();
        expect(blockSpy).toHaveBeenCalledTimes(1);
        expect(loadSpy).toHaveBeenCalledTimes(1);
    });
});
