import { describe, expect, it, vi } from 'vitest';

import { ProgressTracker } from '../../src/utils/progress.js';

describe('ProgressTracker', () => {
    it('should send progress notifications correctly', async () => {
        const mockSendNotification = vi.fn();
        const progressToken = 'test-token-123';
        const tracker = new ProgressTracker(progressToken, mockSendNotification);

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
        const tracker = new ProgressTracker('test-token', mockSendNotification);

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

    it('should call onStatusMessage callback during actor run updates', async () => {
        vi.useFakeTimers();
        const mockSendNotification = vi.fn();
        const mockOnStatusMessage = vi.fn();
        const tracker = new ProgressTracker('test-token', mockSendNotification, 'task-123', mockOnStatusMessage);

        const mockRun = {
            status: 'RUNNING',
            statusMessage: 'Scraping page 1 of 10',
        };
        const mockApifyClient = {
            run: () => ({
                get: vi.fn().mockResolvedValue(mockRun),
            }),
        } as any;

        tracker.startActorRunUpdates('run-id', mockApifyClient, 'test-actor');

        // Advance timer to trigger the polling interval
        await vi.advanceTimersByTimeAsync(5_000);

        expect(mockOnStatusMessage).toHaveBeenCalledWith('test-actor: Scraping page 1 of 10');
        expect(mockSendNotification).toHaveBeenCalled();

        tracker.stop();
        vi.useRealTimers();
    });

    it('should handle notification send errors gracefully', async () => {
        const mockSendNotification = vi.fn().mockRejectedValue(new Error('Network error'));
        const tracker = new ProgressTracker('test-token', mockSendNotification);

        // Should not throw
        await expect(tracker.updateProgress('Test')).resolves.toBeUndefined();
        expect(mockSendNotification).toHaveBeenCalled();
    });
});
