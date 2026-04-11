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

    it('strips all ASCII control characters invalid in HTTP headers', () => {
        // Node.js rejects header values containing chars outside [\t\x20-\x7e\x80-\xff]
        expect(sanitizeEnvValue('sk-abc\x00123')).toBe('sk-abc123'); // null byte
        expect(sanitizeEnvValue('sk-abc\x01123')).toBe('sk-abc123'); // SOH
        expect(sanitizeEnvValue('sk-abc\x0b123')).toBe('sk-abc123'); // vertical tab
        expect(sanitizeEnvValue('sk-abc\x0c123')).toBe('sk-abc123'); // form feed
        expect(sanitizeEnvValue('sk-abc\x1f123')).toBe('sk-abc123'); // unit separator
        expect(sanitizeEnvValue('sk-abc\x7f123')).toBe('sk-abc123'); // DEL
    });

    it('preserves horizontal tab (valid in HTTP headers)', () => {
        expect(sanitizeEnvValue('sk-abc\t123')).toBe('sk-abc\t123');
    });

    it('is idempotent', () => {
        const value = '  "sk-abc123"\r\n';
        expect(sanitizeEnvValue(sanitizeEnvValue(value))).toBe(sanitizeEnvValue(value));
    });
});
