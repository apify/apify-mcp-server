import { describe, expect, it, vi } from 'vitest';

import { PROGRESS_NOTIFICATION_INTERVAL_MS, RELATED_TASK_META_KEY } from '../../src/const.js';
import { createProgressTracker, formatRunStatusMessage, ProgressTracker } from '../../src/utils/progress.js';

describe('ProgressTracker', () => {
    it('should send progress notifications correctly', async () => {
        const mockSendNotification = vi.fn();
        const progressToken = 'test-token-123';
        const tracker = new ProgressTracker({ progressToken, sendNotification: mockSendNotification });

        await tracker.updateProgress('Quarter done');

        expect(mockSendNotification).toHaveBeenCalledWith({
            method: 'notifications/progress',
            params: {
                progressToken,
                progress: 1,
                message: 'Quarter done',
            },
        });
    });

    it('should track actor run status updates', async () => {
        const mockSendNotification = vi.fn();
        const tracker = new ProgressTracker({ progressToken: 'test-token', sendNotification: mockSendNotification });

        // Test with a simple manual update instead of mocking the full actor run flow
        await tracker.updateProgress('test-actor: READY');
        await tracker.updateProgress('test-actor: RUNNING');
        await tracker.updateProgress('test-actor: SUCCEEDED');

        expect(mockSendNotification).toHaveBeenCalledTimes(3);
        expect(mockSendNotification).toHaveBeenNthCalledWith(1, {
            method: 'notifications/progress',
            params: {
                progressToken: 'test-token',
                progress: 1,
                message: 'test-actor: READY',
            },
        });
        expect(mockSendNotification).toHaveBeenNthCalledWith(3, {
            method: 'notifications/progress',
            params: {
                progressToken: 'test-token',
                progress: 3,
                message: 'test-actor: SUCCEEDED',
            },
        });
    });

    it('dedups consecutive identical messages', async () => {
        const mockSendNotification = vi.fn();
        const tracker = new ProgressTracker({ progressToken: 'tok', sendNotification: mockSendNotification });

        await tracker.updateProgress('apify/foo: SUCCEEDED — Done');
        await tracker.updateProgress('apify/foo: SUCCEEDED — Done');
        await tracker.updateProgress('apify/foo: SUCCEEDED — Done with extra');

        expect(mockSendNotification).toHaveBeenCalledTimes(2);
        expect(mockSendNotification).toHaveBeenNthCalledWith(1, expect.objectContaining({
            params: expect.objectContaining({ progress: 1, message: 'apify/foo: SUCCEEDED — Done' }),
        }));
        expect(mockSendNotification).toHaveBeenNthCalledWith(2, expect.objectContaining({
            params: expect.objectContaining({ progress: 2, message: 'apify/foo: SUCCEEDED — Done with extra' }),
        }));
    });

    it('should handle notification send errors gracefully', async () => {
        const mockSendNotification = vi.fn().mockRejectedValue(new Error('Network error'));
        const tracker = new ProgressTracker({ progressToken: 'test-token', sendNotification: mockSendNotification });

        // Should not throw
        await expect(tracker.updateProgress('Test')).resolves.toBeUndefined();
        expect(mockSendNotification).toHaveBeenCalled();
    });

    it('should call onStatusMessage with the progress message', async () => {
        const mockOnStatusMessage = vi.fn();
        const tracker = new ProgressTracker({ onStatusMessage: mockOnStatusMessage });

        await tracker.updateProgress('Actor running');

        expect(mockOnStatusMessage).toHaveBeenCalledWith('Actor running');
    });

    it('should not call onStatusMessage when message is undefined', async () => {
        const mockOnStatusMessage = vi.fn();
        const tracker = new ProgressTracker({ onStatusMessage: mockOnStatusMessage });

        await tracker.updateProgress();

        expect(mockOnStatusMessage).not.toHaveBeenCalled();
    });

    it('should handle onStatusMessage errors gracefully', async () => {
        const mockOnStatusMessage = vi.fn().mockRejectedValue(new Error('Store error'));
        const tracker = new ProgressTracker({ onStatusMessage: mockOnStatusMessage });

        // Should not throw
        await expect(tracker.updateProgress('Test')).resolves.toBeUndefined();
        expect(mockOnStatusMessage).toHaveBeenCalledWith('Test');
    });

    it('should include related-task metadata with taskId in progress notifications', async () => {
        const mockSendNotification = vi.fn();
        const tracker = new ProgressTracker({
            progressToken: 'tok',
            sendNotification: mockSendNotification,
            taskId: 'task-abc',
        });

        await tracker.updateProgress('running');

        expect(mockSendNotification).toHaveBeenCalledWith({
            method: 'notifications/progress',
            params: {
                progressToken: 'tok',
                progress: 1,
                message: 'running',
            },
            _meta: {
                [RELATED_TASK_META_KEY]: {
                    taskId: 'task-abc',
                },
            },
        });
    });

    it('should not include _meta when taskId is not provided', async () => {
        const mockSendNotification = vi.fn();
        const tracker = new ProgressTracker({
            progressToken: 'tok',
            sendNotification: mockSendNotification,
        });

        await tracker.updateProgress('running');

        const notification = mockSendNotification.mock.calls[0][0];
        expect(notification).not.toHaveProperty('_meta');
    });

    it('does not re-emit on first poll tick when run state matches the seeded initial', async () => {
        vi.useFakeTimers();
        try {
            const mockSendNotification = vi.fn();
            const tracker = new ProgressTracker({ progressToken: 'tok', sendNotification: mockSendNotification });
            const get = vi.fn().mockResolvedValue({ status: 'RUNNING', statusMessage: null });
            const apifyClient = { run: vi.fn().mockReturnValue({ get }) } as never;

            tracker.startActorRunUpdates('run-1', apifyClient, 'apify/foo', { status: 'RUNNING', statusMessage: null });
            await vi.advanceTimersByTimeAsync(PROGRESS_NOTIFICATION_INTERVAL_MS + 500);
            tracker.stop();

            expect(get).toHaveBeenCalled();
            expect(mockSendNotification).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('skips overlapping poll ticks when a previous tick is still in-flight', async () => {
        vi.useFakeTimers();
        try {
            const mockSendNotification = vi.fn();
            const tracker = new ProgressTracker({ progressToken: 'tok', sendNotification: mockSendNotification });
            let resolveGet: ((run: unknown) => void) | undefined;
            const get = vi.fn().mockImplementation(async () => new Promise((resolve) => {
                resolveGet = resolve;
            }));
            const apifyClient = { run: vi.fn().mockReturnValue({ get }) } as never;

            tracker.startActorRunUpdates('run-1', apifyClient, 'apify/foo', { status: 'RUNNING' });
            // First tick fires; run.get() is now in-flight.
            await vi.advanceTimersByTimeAsync(PROGRESS_NOTIFICATION_INTERVAL_MS + 500);
            expect(get).toHaveBeenCalledTimes(1);

            // Several more interval ticks fire while the first is still awaiting — guard should skip them.
            await vi.advanceTimersByTimeAsync(PROGRESS_NOTIFICATION_INTERVAL_MS * 2);
            expect(get).toHaveBeenCalledTimes(1);

            // Resolve the first tick; the next interval should fire a fresh get().
            resolveGet!({ status: 'RUNNING', statusMessage: 'Crawling' });
            await vi.advanceTimersByTimeAsync(PROGRESS_NOTIFICATION_INTERVAL_MS + 500);
            expect(get).toHaveBeenCalledTimes(2);

            tracker.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not emit when stop() is called while a poll tick is in-flight', async () => {
        vi.useFakeTimers();
        try {
            const mockSendNotification = vi.fn();
            const tracker = new ProgressTracker({ progressToken: 'tok', sendNotification: mockSendNotification });
            let resolveGet: ((run: unknown) => void) | undefined;
            const get = vi.fn().mockImplementation(async () => new Promise((resolve) => {
                resolveGet = resolve;
            }));
            const apifyClient = { run: vi.fn().mockReturnValue({ get }) } as never;

            tracker.startActorRunUpdates('run-1', apifyClient, 'apify/foo', { status: 'RUNNING' });
            await vi.advanceTimersByTimeAsync(PROGRESS_NOTIFICATION_INTERVAL_MS + 500);
            expect(get).toHaveBeenCalled();

            tracker.stop();
            resolveGet!({ status: 'SUCCEEDED', statusMessage: 'Done', isStatusMessageTerminal: true });
            await Promise.resolve();
            await Promise.resolve();

            expect(mockSendNotification).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('formatRunStatusMessage', () => {
    it('leads with status and appends in-progress statusMessage', () => {
        expect(formatRunStatusMessage('apify/foo', { status: 'RUNNING', statusMessage: 'Crawled 5/10 pages' }))
            .toBe('apify/foo: RUNNING — Crawled 5/10 pages');
    });

    it('appends terminal statusMessage only when the actor marked it terminal', () => {
        expect(formatRunStatusMessage('apify/foo', {
            status: 'SUCCEEDED',
            statusMessage: 'Actor finished with 1 result',
            isStatusMessageTerminal: true,
        })).toBe('apify/foo: SUCCEEDED — Actor finished with 1 result');
    });

    it('omits non-terminal statusMessage at terminal status to avoid showing stale text', () => {
        for (const isStatusMessageTerminal of [false, null, undefined]) {
            expect(formatRunStatusMessage('apify/foo', {
                status: 'SUCCEEDED',
                statusMessage: 'Starting the crawler.',
                isStatusMessageTerminal,
            })).toBe('apify/foo: SUCCEEDED');
        }
    });

    it('uses status alone when statusMessage is missing', () => {
        for (const status of ['READY', 'RUNNING', 'SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']) {
            expect(formatRunStatusMessage('apify/foo', { status, statusMessage: null })).toBe(`apify/foo: ${status}`);
            expect(formatRunStatusMessage('apify/foo', { status })).toBe(`apify/foo: ${status}`);
        }
    });
});

describe('createProgressTracker', () => {
    it('should return null when no progressToken, no sendNotification, and no onStatusMessage', () => {
        expect(createProgressTracker(undefined, undefined)).toBeNull();
    });

    it('should return ProgressTracker when only onStatusMessage is provided', () => {
        const tracker = createProgressTracker(undefined, undefined, undefined, vi.fn());
        expect(tracker).toBeInstanceOf(ProgressTracker);
    });

    it('should return ProgressTracker and send notifications for progressToken = 0', async () => {
        const mockSendNotification = vi.fn();
        const tracker = createProgressTracker(0, mockSendNotification);

        expect(tracker).toBeInstanceOf(ProgressTracker);
        await tracker?.updateProgress('Started');

        expect(mockSendNotification).toHaveBeenCalledWith({
            method: 'notifications/progress',
            params: {
                progressToken: 0,
                progress: 1,
                message: 'Started',
            },
        });
    });
});
