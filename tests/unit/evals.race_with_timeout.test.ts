import { describe, expect, it } from 'vitest';

import { raceWithTimeout, TestTimeoutError } from '../../evals/workflows/race_with_timeout.js';

describe('raceWithTimeout()', () => {
    it('resolves with the promise value when it settles before the timeout', async () => {
        const result = await raceWithTimeout(Promise.resolve('done'), 1);
        expect(result).toBe('done');
    });

    it('rejects with the promise error when it rejects before the timeout', async () => {
        await expect(raceWithTimeout(Promise.reject(new Error('boom')), 1)).rejects.toThrow('boom');
    });

    it('rejects with TestTimeoutError once timeoutSecs elapses without the promise settling', async () => {
        const neverSettles = new Promise<never>(() => {});
        await expect(raceWithTimeout(neverSettles, 0.01)).rejects.toThrow(TestTimeoutError);
    });
});
