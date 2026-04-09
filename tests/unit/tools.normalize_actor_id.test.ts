import { describe, expect, it } from 'vitest';

import { cleanActorIdOrName } from '../../src/tools/core/actor_tools_factory.js';

describe('cleanActorIdOrName', () => {
    it('passes clean ids through unchanged', () => {
        expect(cleanActorIdOrName('apify/rag-web-browser')).toBe('apify/rag-web-browser');
        expect(cleanActorIdOrName('username/my-actor')).toBe('username/my-actor');
    });

    it('trims leading/trailing whitespace', () => {
        expect(cleanActorIdOrName('  apify/rag-web-browser  ')).toBe('apify/rag-web-browser');
    });

    it('strips backtick wrappers', () => {
        expect(cleanActorIdOrName('`apify/rag-web-browser`')).toBe('apify/rag-web-browser');
    });

    it('strips double-quote wrappers', () => {
        expect(cleanActorIdOrName('"apify/rag-web-browser"')).toBe('apify/rag-web-browser');
    });

    it('strips smart curly double-quote wrappers', () => {
        expect(cleanActorIdOrName('\u201capify/rag-web-browser\u201d')).toBe('apify/rag-web-browser');
    });

    it('strips smart single-quote wrappers', () => {
        expect(cleanActorIdOrName('\u2018apify/rag-web-browser\u2019')).toBe('apify/rag-web-browser');
    });

    it('strips nested wrappers (loop takes outermost pair, regex cleans remainder)', () => {
        // Loop strips backticks → `"apify/actor"`, then regex strips remaining double-quotes
        expect(cleanActorIdOrName('`"apify/actor"`')).toBe('apify/actor');
    });

    it('strips unpaired trailing backtick (Mezmo leakage pattern)', () => {
        expect(cleanActorIdOrName('`apify/rag-web-browser')).toBe('apify/rag-web-browser');
    });

    it('strips unpaired trailing double-quote (Mezmo leakage pattern)', () => {
        expect(cleanActorIdOrName('apify/rag-web-browser"')).toBe('apify/rag-web-browser');
    });

    it('normalizes spaces around slash', () => {
        expect(cleanActorIdOrName('apify / rag-web-browser')).toBe('apify/rag-web-browser');
        expect(cleanActorIdOrName('apify /rag-web-browser')).toBe('apify/rag-web-browser');
        expect(cleanActorIdOrName('apify/ rag-web-browser')).toBe('apify/rag-web-browser');
    });

    it('collapses internal whitespace in actor name segments', () => {
        expect(cleanActorIdOrName('apify/rag  web browser')).toBe('apify/rag web browser');
    });

    it('handles wrappers combined with inner whitespace and slash spacing', () => {
        expect(cleanActorIdOrName('`apify / rag-web-browser`')).toBe('apify/rag-web-browser');
        expect(cleanActorIdOrName('"apify / rag-web-browser"')).toBe('apify/rag-web-browser');
    });
});
