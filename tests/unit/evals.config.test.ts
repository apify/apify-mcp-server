import { afterEach, describe, expect, it } from 'vitest';

import { sanitizeEnvValue, sanitizeProcessEnv } from '../../evals/shared/config.js';

describe('sanitizeEnvValue', () => {
    it('passes through undefined and null', () => {
        expect(sanitizeEnvValue(undefined)).toBeUndefined();
        expect(sanitizeEnvValue(null as unknown as undefined)).toBeNull();
    });

    it('strips newlines and trims surrounding whitespace', () => {
        expect(sanitizeEnvValue('sk-abc123\n')).toBe('sk-abc123');
        expect(sanitizeEnvValue('sk-abc123\r\n')).toBe('sk-abc123');
        expect(sanitizeEnvValue('sk-\nabc\r\n123\n')).toBe('sk-abc123');
        expect(sanitizeEnvValue('  sk-abc123  ')).toBe('sk-abc123');
    });

    it('strips control characters', () => {
        expect(sanitizeEnvValue('sk-abc\x00123')).toBe('sk-abc123'); // null byte
        expect(sanitizeEnvValue('sk-abc\x01123')).toBe('sk-abc123'); // SOH
        expect(sanitizeEnvValue('sk-abc\x0b123')).toBe('sk-abc123'); // vertical tab
        expect(sanitizeEnvValue('sk-abc\x0c123')).toBe('sk-abc123'); // form feed
        expect(sanitizeEnvValue('sk-abc\x1f123')).toBe('sk-abc123'); // unit separator
        expect(sanitizeEnvValue('sk-abc\x7f123')).toBe('sk-abc123'); // DEL
    });

    it('strips surrounding double quotes only', () => {
        expect(sanitizeEnvValue('"sk-abc123"')).toBe('sk-abc123');
        expect(sanitizeEnvValue('"sk-"abc"-123"')).toBe('sk-"abc"-123');
        expect(sanitizeEnvValue("'sk-abc123'")).toBe("'sk-abc123'");
    });

    it('handles combined inputs and edge cases', () => {
        expect(sanitizeEnvValue('  "sk-abc123"\n')).toBe('sk-abc123');
        expect(sanitizeEnvValue('')).toBe('');
    });

    it('is idempotent', () => {
        const value = '  "sk-abc123"\r\n';
        expect(sanitizeEnvValue(sanitizeEnvValue(value))).toBe(sanitizeEnvValue(value));
    });
});

describe('sanitizeProcessEnv', () => {
    afterEach(() => {
        delete process.env.PHOENIX_API_KEY;
        delete process.env.OPENROUTER_API_KEY;
    });

    it('sanitizes env vars in-place', () => {
        process.env.PHOENIX_API_KEY = 'key-with-newline\n';
        process.env.OPENROUTER_API_KEY = '  "quoted-key"\r\n';
        sanitizeProcessEnv();
        expect(process.env.PHOENIX_API_KEY).toBe('key-with-newline');
        expect(process.env.OPENROUTER_API_KEY).toBe('quoted-key');
    });

    it('leaves unset vars untouched', () => {
        sanitizeProcessEnv();
        expect(process.env.PHOENIX_API_KEY).toBeUndefined();
    });
});
