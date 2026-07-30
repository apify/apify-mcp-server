import { describe, expect, it } from 'vitest';

import { buildMcpClientContext, isUiSupportedByClient } from '../../src/mcp/client_context.js';
import { RESOURCE_MIME_TYPE } from '../../src/resources/widgets.js';

describe('buildMcpClientContext()', () => {
    it('returns undefined when initialize params are absent', () => {
        expect(buildMcpClientContext(undefined)).toBeUndefined();
    });

    it('copies client identity and all capabilities', () => {
        const params = {
            protocolVersion: '2025-06-18',
            clientInfo: { name: 'test-client', version: '1.2.3' },
            capabilities: {
                roots: { listChanged: true },
                sampling: {},
                experimental: { nested: { enabled: true } },
            },
        };

        const context = buildMcpClientContext(params);
        if (!context) throw new Error('client context was not built');

        expect(context).toEqual(params);
        expect(context).not.toBe(params);
        expect(context.clientInfo).not.toBe(params.clientInfo);
        expect(context.capabilities).not.toBe(params.capabilities);
        expect(((context.capabilities as Record<string, unknown>).experimental as { nested: object }).nested).not.toBe(
            params.capabilities.experimental.nested,
        );
    });

    it('tolerates missing initialize fields', () => {
        expect(buildMcpClientContext({})).toEqual({});
    });
});

describe('isUiSupportedByClient()', () => {
    it('detects the MCP Apps UI capability', () => {
        const context = buildMcpClientContext({
            capabilities: {
                extensions: {
                    'io.modelcontextprotocol/ui': {
                        mimeTypes: [RESOURCE_MIME_TYPE],
                    },
                },
            },
        });

        expect(isUiSupportedByClient(context)).toBe(true);
    });

    it('returns false without the widget MIME type', () => {
        expect(isUiSupportedByClient(buildMcpClientContext({ capabilities: {} }))).toBe(false);
        expect(isUiSupportedByClient(undefined)).toBe(false);
    });
});
