import { describe, expect, it } from 'vitest';

import { sanitizeEnvValue } from '../../evals/shared/config.js';

describe('sanitizeEnvValue', () => {
    it('returns undefined for undefined', () => {
        expect(sanitizeEnvValue(undefined)).toBeUndefined();
    });

    it('returns null for null', () => {
        expect(sanitizeEnvValue(null as unknown as undefined)).toBeNull();
    });

    it('strips trailing newline', () => {
        expect(sanitizeEnvValue('sk-abc123\n')).toBe('sk-abc123');
    });

    it('strips carriage-return + newline', () => {
        expect(sanitizeEnvValue('sk-abc123\r\n')).toBe('sk-abc123');
    });

    it('strips embedded newlines', () => {
        expect(sanitizeEnvValue('sk-\nabc\r\n123\n')).toBe('sk-abc123');
    });

    it('trims surrounding whitespace', () => {
        expect(sanitizeEnvValue('  sk-abc123  ')).toBe('sk-abc123');
    });

    it('strips surrounding double quotes', () => {
        expect(sanitizeEnvValue('"sk-abc123"')).toBe('sk-abc123');
    });

    it('strips only outer quotes (not inner)', () => {
        expect(sanitizeEnvValue('"sk-"abc"-123"')).toBe('sk-"abc"-123');
    });

    it('does not strip single quotes', () => {
        expect(sanitizeEnvValue("'sk-abc123'")).toBe("'sk-abc123'");
    });

    it('handles combined whitespace, newlines, and quotes', () => {
        expect(sanitizeEnvValue('  "sk-abc123"\n')).toBe('sk-abc123');
    });

    it('returns empty string for empty input', () => {
        expect(sanitizeEnvValue('')).toBe('');
    });

    it('is idempotent', () => {
        const value = '  "sk-abc123"\r\n';
        expect(sanitizeEnvValue(sanitizeEnvValue(value))).toBe(sanitizeEnvValue(value));
    });
});
