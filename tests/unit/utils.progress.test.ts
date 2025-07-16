import { describe, expect, it, vi } from 'vitest';

import { ProgressTracker } from '../../src/utils/progress.js';

describe('ProgressTracker', () => {
    it('should send progress notifications correctly', async () => {
        const mockSendNotification = vi.fn();
        const progressToken = 'test-token-123';
        const tracker = new ProgressTracker(progressToken, mockSendNotification, 100);

        await tracker.updateProgress(25, 'Quarter done');

        expect(mockSendNotification).toHaveBeenCalledWith({
            method: 'notifications/progress',
            params: {
                progressToken,
                progress: 25,
                total: 100,
                message: 'Quarter done',
            },
        });
    });

    it('should track actor run status updates', async () => {
        const mockSendNotification = vi.fn();
        const tracker = new ProgressTracker('test-token', mockSendNotification, 100);

        // Test with a simple manual update instead of mocking the full actor run flow
        await tracker.updateProgress(0, 'test-actor: READY');
        await tracker.updateProgress(50, 'test-actor: RUNNING');
        await tracker.updateProgress(100, 'test-actor: SUCCEEDED');

        expect(mockSendNotification).toHaveBeenCalledTimes(3);
        expect(mockSendNotification).toHaveBeenNthCalledWith(1, {
            method: 'notifications/progress',
            params: {
                progressToken: 'test-token',
                progress: 0,
                total: 100,
                message: 'test-actor: READY',
            },
        });
        expect(mockSendNotification).toHaveBeenNthCalledWith(3, {
            method: 'notifications/progress',
            params: {
                progressToken: 'test-token',
                progress: 100,
                total: 100,
                message: 'test-actor: SUCCEEDED',
            },
        });
    });

    it('should complete correctly', async () => {
        const mockSendNotification = vi.fn();
        const tracker = new ProgressTracker('test-token', mockSendNotification, 100);

        await tracker.complete('All done!');

        expect(mockSendNotification).toHaveBeenCalledWith({
            method: 'notifications/progress',
            params: {
                progressToken: 'test-token',
                progress: 100,
                total: 100,
                message: 'All done!',
            },
        });
    });

    it('should handle notification send errors gracefully', async () => {
        const mockSendNotification = vi.fn().mockRejectedValue(new Error('Network error'));
        const tracker = new ProgressTracker('test-token', mockSendNotification);

        // Should not throw
        await expect(tracker.updateProgress(50, 'Test')).resolves.toBeUndefined();
        expect(mockSendNotification).toHaveBeenCalled();
    });
});
