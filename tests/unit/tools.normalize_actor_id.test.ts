import { describe, expect, it } from 'vitest';

import { fixActorNameInput } from '../../src/tools/core/actor_tools_factory.js';

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
});
