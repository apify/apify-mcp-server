import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    ENV_KEYS_TO_SANITIZE,
    findMissingEnvVars,
    sanitizeEnvValue,
    sanitizeProcessEnv,
} from '../../evals/environment.js';

describe('sanitizeEnvValue()', () => {
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

describe('findMissingEnvVars()', () => {
    const KEYS = ['TEST_UNSET_VAR', 'TEST_WHITESPACE_VAR', 'TEST_QUOTES_VAR', 'TEST_CONTROL_VAR', 'TEST_VALID_VAR'];
    const originalValues = new Map<string, string | undefined>();

    beforeEach(() => {
        for (const key of KEYS) originalValues.set(key, process.env[key]);
        delete process.env.TEST_UNSET_VAR;
        process.env.TEST_WHITESPACE_VAR = '   ';
        process.env.TEST_QUOTES_VAR = '""';
        process.env.TEST_CONTROL_VAR = '\x1f\x0b';
        process.env.TEST_VALID_VAR = 'sk-abc123';
    });

    afterEach(() => {
        for (const key of KEYS) {
            const original = originalValues.get(key);
            if (original === undefined) delete process.env[key];
            else process.env[key] = original;
        }
    });

    it('reports an unset key as missing', () => {
        expect(findMissingEnvVars(['TEST_UNSET_VAR'])).toEqual(['TEST_UNSET_VAR']);
    });

    it('reports a whitespace-only value as missing', () => {
        expect(findMissingEnvVars(['TEST_WHITESPACE_VAR'])).toEqual(['TEST_WHITESPACE_VAR']);
    });

    it('reports a quotes-only value as missing', () => {
        expect(findMissingEnvVars(['TEST_QUOTES_VAR'])).toEqual(['TEST_QUOTES_VAR']);
    });

    it('reports a control-chars-only value as missing', () => {
        expect(findMissingEnvVars(['TEST_CONTROL_VAR'])).toEqual(['TEST_CONTROL_VAR']);
    });

    it('does not report a valid value as missing', () => {
        expect(findMissingEnvVars(['TEST_VALID_VAR'])).toEqual([]);
    });

    it('returns missing keys in input order', () => {
        expect(findMissingEnvVars(['TEST_VALID_VAR', 'TEST_UNSET_VAR', 'TEST_WHITESPACE_VAR'])).toEqual([
            'TEST_UNSET_VAR',
            'TEST_WHITESPACE_VAR',
        ]);
    });
});

describe('sanitizeProcessEnv()', () => {
    const KEYS = ENV_KEYS_TO_SANITIZE;
    const originalValues = new Map<string, string | undefined>();
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        for (const key of KEYS) originalValues.set(key, process.env[key]);
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        for (const key of KEYS) {
            const original = originalValues.get(key);
            if (original === undefined) delete process.env[key];
            else process.env[key] = original;
        }
        logSpy.mockRestore();
    });

    it('sanitizes a value with a trailing newline and quotes in place', () => {
        process.env.APIFY_TOKEN = '"sk-abc123"\n';
        sanitizeProcessEnv();
        expect(process.env.APIFY_TOKEN).toBe('sk-abc123');
    });

    it('leaves an unset key unset, not the string "undefined"', () => {
        delete process.env.ANTHROPIC_API_KEY;
        sanitizeProcessEnv();
        expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it('leaves an already-clean value unchanged', () => {
        process.env.OPENROUTER_API_KEY = 'sk-clean-value';
        sanitizeProcessEnv();
        expect(process.env.OPENROUTER_API_KEY).toBe('sk-clean-value');
    });

    it('does not leak the raw secret value in a logged line', () => {
        process.env.LANGFUSE_SECRET_KEY = 'sk-lf-super-secret-value\n';
        sanitizeProcessEnv();
        const loggedLines = logSpy.mock.calls.map((call: unknown[]) => String(call[0]));
        expect(loggedLines.some((line: string) => line.includes('sk-lf-super-secret-value'))).toBe(false);
    });
});
