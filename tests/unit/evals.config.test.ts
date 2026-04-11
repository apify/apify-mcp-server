import { afterEach, describe, expect, it, vi } from 'vitest';

import { sanitizeEnvValue, sanitizeProcessEnv } from '../../evals/shared/config.js';

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

describe('sanitizeProcessEnv', () => {
    const KEYS_TO_TEST = ['PHOENIX_API_KEY', 'OPENROUTER_API_KEY'] as const;
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    afterEach(() => {
        for (const key of KEYS_TO_TEST) {
            delete process.env[key];
        }
        consoleSpy.mockClear();
    });

    it('sanitizes env vars in-place on process.env', () => {
        process.env.PHOENIX_API_KEY = 'key-with-newline\n';
        process.env.OPENROUTER_API_KEY = '  "quoted-key"\r\n';

        sanitizeProcessEnv();

        expect(process.env.PHOENIX_API_KEY).toBe('key-with-newline');
        expect(process.env.OPENROUTER_API_KEY).toBe('quoted-key');
    });

    it('leaves unset env vars as undefined', () => {
        sanitizeProcessEnv();
        expect(process.env.PHOENIX_API_KEY).toBeUndefined();
    });

    it('logs redacted values for CI debugging', () => {
        process.env.PHOENIX_API_KEY = 'phx-1234567890abcdef';

        sanitizeProcessEnv();

        const phoenixLog = consoleSpy.mock.calls.find(([msg]) => typeof msg === 'string' && msg.includes('PHOENIX_API_KEY'));
        expect(phoenixLog).toBeDefined();
        // Should show first 4 and last 4 chars, not the full key
        expect(phoenixLog![0]).toContain('phx-');
        expect(phoenixLog![0]).toContain('cdef');
        expect(phoenixLog![0]).not.toContain('1234567890ab');
    });

    it('logs (unset) for missing env vars', () => {
        sanitizeProcessEnv();

        const phoenixLog = consoleSpy.mock.calls.find(([msg]) => typeof msg === 'string' && msg.includes('PHOENIX_API_KEY'));
        expect(phoenixLog).toBeDefined();
        expect(phoenixLog![0]).toContain('(unset)');
    });

    it('logs (empty) for empty env vars', () => {
        process.env.PHOENIX_API_KEY = '';

        sanitizeProcessEnv();

        const phoenixLog = consoleSpy.mock.calls.find(([msg]) => typeof msg === 'string' && msg.includes('PHOENIX_API_KEY'));
        expect(phoenixLog).toBeDefined();
        expect(phoenixLog![0]).toContain('(empty)');
    });
});
