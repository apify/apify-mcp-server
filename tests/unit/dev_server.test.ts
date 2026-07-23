import { describe, expect, it } from 'vitest';

import { extractInitializeMessage, parseInitializeParams } from '../../src/dev_server.js';

describe('extractInitializeMessage()', () => {
    it('matches a well-formed initialize request', () => {
        const body = {
            method: 'initialize',
            params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
        };
        expect(extractInitializeMessage(body)).toEqual(body);
    });

    it('matches an initialize request with malformed params (regression: must still route to the initialize branch, not the session-id 400)', () => {
        const body = { method: 'initialize', params: { protocolVersion: 123 } };
        expect(extractInitializeMessage(body)).toEqual(body);
    });

    it('matches an initialize request with no params at all', () => {
        const body = { method: 'initialize' };
        expect(extractInitializeMessage(body)).toEqual(body);
    });

    it('matches inside a batched array body', () => {
        const body = [{ method: 'ping' }, { method: 'initialize', params: {} }];
        expect(extractInitializeMessage(body)).toEqual(body[1]);
    });

    it('returns undefined for a non-initialize request', () => {
        expect(extractInitializeMessage({ method: 'tools/list' })).toBeUndefined();
        expect(extractInitializeMessage(null)).toBeUndefined();
        expect(extractInitializeMessage('not an object')).toBeUndefined();
    });
});

describe('parseInitializeParams()', () => {
    it('parses well-formed params', () => {
        const params = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } };
        expect(parseInitializeParams(params)).toEqual(params);
    });

    it('returns undefined for malformed or missing params instead of throwing', () => {
        expect(parseInitializeParams({ protocolVersion: 123 })).toBeUndefined();
        expect(parseInitializeParams(undefined)).toBeUndefined();
    });
});
