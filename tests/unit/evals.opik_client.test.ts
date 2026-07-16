import { describe, expect, it } from 'vitest';

import {
    buildExperimentName,
    sanitizeExperimentSegment,
    shortModelName,
    testCaseItemId,
    toDatasetItem,
} from '../../evals/workflows/opik_client.js';
import type { WorkflowTestCase } from '../../evals/workflows/test_cases_loader.js';

describe('shortModelName()', () => {
    it('strips the provider prefix', () => {
        expect(shortModelName('anthropic/claude-haiku-4.5')).toBe('claude-haiku-4.5');
        expect(shortModelName('deepseek/deepseek-v4-flash')).toBe('deepseek-v4-flash');
    });

    it('returns the model unchanged when there is no prefix', () => {
        expect(shortModelName('claude-haiku-4.5')).toBe('claude-haiku-4.5');
    });
});

describe('sanitizeExperimentSegment()', () => {
    it('replaces disallowed characters with a hyphen', () => {
        expect(sanitizeExperimentSegment('feat/opik-evals')).toBe('feat-opik-evals');
        expect(sanitizeExperimentSegment('feature/add stuff')).toBe('feature-add-stuff');
    });

    it('keeps allowed characters', () => {
        expect(sanitizeExperimentSegment('release-1.2_x')).toBe('release-1.2_x');
    });
});

describe('buildExperimentName()', () => {
    it('joins the sanitized branch and short model name', () => {
        expect(buildExperimentName('feat/opik-evals', 'anthropic/claude-haiku-4.5')).toBe(
            'feat-opik-evals/claude-haiku-4.5',
        );
    });

    it('falls back to "local" when the branch is missing', () => {
        expect(buildExperimentName(undefined, 'anthropic/claude-haiku-4.5')).toBe('local/claude-haiku-4.5');
    });
});

describe('testCaseItemId()', () => {
    it('produces a stable version 7 UUID for the same test id', () => {
        const first = testCaseItemId('search-google-maps');
        expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(testCaseItemId('search-google-maps')).toBe(first);
    });

    it('produces different UUIDs for different test ids', () => {
        expect(testCaseItemId('test-a')).not.toBe(testCaseItemId('test-b'));
    });
});

describe('toDatasetItem()', () => {
    it('maps the required fields and derives the item id from the test id', () => {
        const testCase: WorkflowTestCase = {
            id: 'search-google-maps',
            category: 'search',
            query: 'find maps',
            reference: 'must search',
        };
        expect(toDatasetItem(testCase)).toEqual({
            id: testCaseItemId('search-google-maps'),
            testId: 'search-google-maps',
            category: 'search',
            query: 'find maps',
            reference: 'must search',
        });
    });

    it('includes optional fields only when present', () => {
        const testCase: WorkflowTestCase = {
            id: 'call-actor',
            category: 'call',
            query: 'call it',
            reference: 'must call',
            maxTurns: 5,
            tools: ['actors'],
            failTools: ['call-actor'],
        };
        expect(toDatasetItem(testCase)).toEqual({
            id: testCaseItemId('call-actor'),
            testId: 'call-actor',
            category: 'call',
            query: 'call it',
            reference: 'must call',
            maxTurns: 5,
            tools: ['actors'],
            failTools: ['call-actor'],
        });
    });

    it('defaults a missing reference to an empty string', () => {
        const testCase = { id: 'x', category: 'c', query: 'q' } as WorkflowTestCase;
        expect(toDatasetItem(testCase).reference).toBe('');
    });
});
