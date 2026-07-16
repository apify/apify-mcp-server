/** Thrown when a test's wall-clock budget (--test-timeout) elapses; distinguishes a stuck test from any other execution error. */
export class TestTimeoutError extends Error {}

/** Rejects with TestTimeoutError after timeoutSecs if promise hasn't settled yet. Does not cancel promise's underlying work. */
export async function raceWithTimeout<T>(promise: Promise<T>, timeoutSecs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () => reject(new TestTimeoutError(`Test exceeded ${timeoutSecs}s timeout`)),
            timeoutSecs * 1000,
        );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
