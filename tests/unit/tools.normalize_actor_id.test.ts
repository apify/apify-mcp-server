import { describe, expect, it } from 'vitest';

import { fixActorNameInput } from '../../src/tools/actors/actor_tools_factory.js';

describe('fixActorNameInput', () => {
    it('passes clean ids through unchanged', () => {
        expect(fixActorNameInput('apify/rag-web-browser')).toBe('apify/rag-web-browser');
        expect(fixActorNameInput('username/my-actor')).toBe('username/my-actor');
    });

    it('trims leading/trailing whitespace', () => {
        expect(fixActorNameInput('  apify/rag-web-browser  ')).toBe('apify/rag-web-browser');
    });

    it('strips backtick wrappers', () => {
        expect(fixActorNameInput('`apify/rag-web-browser`')).toBe('apify/rag-web-browser');
    });

    it('strips double-quote wrappers', () => {
        expect(fixActorNameInput('"apify/rag-web-browser"')).toBe('apify/rag-web-browser');
    });

    it('strips smart curly double-quote wrappers', () => {
        expect(fixActorNameInput('\u201capify/rag-web-browser\u201d')).toBe('apify/rag-web-browser');
    });

    it('strips smart single-quote wrappers', () => {
        expect(fixActorNameInput('\u2018apify/rag-web-browser\u2019')).toBe('apify/rag-web-browser');
    });

    it('strips nested wrappers (loop takes outermost pair, regex cleans remainder)', () => {
        // Loop strips backticks → `"apify/actor"`, then regex strips remaining double-quotes
        expect(fixActorNameInput('`"apify/actor"`')).toBe('apify/actor');
    });

    it('strips unpaired trailing backtick (Mezmo leakage pattern)', () => {
        expect(fixActorNameInput('`apify/rag-web-browser')).toBe('apify/rag-web-browser');
    });

    it('strips unpaired trailing double-quote (Mezmo leakage pattern)', () => {
        expect(fixActorNameInput('apify/rag-web-browser"')).toBe('apify/rag-web-browser');
    });

    it('normalizes spaces around slash', () => {
        expect(fixActorNameInput('apify / rag-web-browser')).toBe('apify/rag-web-browser');
        expect(fixActorNameInput('apify /rag-web-browser')).toBe('apify/rag-web-browser');
        expect(fixActorNameInput('apify/ rag-web-browser')).toBe('apify/rag-web-browser');
    });

    it('collapses internal whitespace in actor name segments', () => {
        expect(fixActorNameInput('apify/rag  web browser')).toBe('apify/rag web browser');
    });

    it('handles wrappers combined with inner whitespace and slash spacing', () => {
        expect(fixActorNameInput('`apify / rag-web-browser`')).toBe('apify/rag-web-browser');
        expect(fixActorNameInput('"apify / rag-web-browser"')).toBe('apify/rag-web-browser');
    });

    it('strips leading and trailing slashes', () => {
        expect(fixActorNameInput('//apify/rag-web-browser//')).toBe('apify/rag-web-browser');
    });

    it('strips a trailing slash before dropping the :toolName suffix', () => {
        expect(fixActorNameInput('apify/example-mcp-server:add/')).toBe('apify/example-mcp-server');
    });

    it('reduces a lone slash to an empty name', () => {
        expect(fixActorNameInput('/')).toBe('');
    });

    it('drops the :toolName suffix of the removed actorName:toolName form', () => {
        expect(fixActorNameInput('apify/example-mcp-server:add')).toBe('apify/example-mcp-server');
        expect(fixActorNameInput('https://apify.com/apify/rag-web-browser')).toBe(
            'https://apify.com/apify/rag-web-browser',
        );
    });

    it('trims whitespace before dropping the tool suffix', () => {
        expect(fixActorNameInput('apify/rag-web-browser :tool')).toBe('apify/rag-web-browser');
    });

    it('drops the suffix from the first colon after the last slash', () => {
        expect(fixActorNameInput('apify/example-mcp-server:add:extra')).toBe('apify/example-mcp-server');
    });
});

// Linear time takes well under a millisecond here; the bound only catches time that grows faster than the length.
describe('Actor name normalization runs in linear time', () => {
    it.each([
        ['colon run before a slash', `${':'.repeat(100_000)}/a`],
        ['quote run inside the name', `a${'`'.repeat(100_000)}a`],
    ])('normalizes a 100,000-character %s within a second', (_, actorName) => {
        const startedAt = performance.now();
        fixActorNameInput(actorName);

        expect(performance.now() - startedAt).toBeLessThan(1000);
    });
});
