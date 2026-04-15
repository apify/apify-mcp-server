import { describe, expect, it, vi } from 'vitest';

import { createProgressTracker, ProgressTracker } from '../../src/utils/progress.js';

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
                'io.modelcontextprotocol/related-task': {
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
});

describe('createProgressTracker', () => {
    it('should return null when no progressToken, no sendNotification, and no onStatusMessage', () => {
        expect(createProgressTracker(undefined, undefined)).toBeNull();
    });

    it('should return ProgressTracker when progressToken and sendNotification are provided', () => {
        const tracker = createProgressTracker('tok', vi.fn());
        expect(tracker).toBeInstanceOf(ProgressTracker);
    });

    it('should return ProgressTracker when only onStatusMessage is provided', () => {
        const tracker = createProgressTracker(undefined, undefined, undefined, vi.fn());
        expect(tracker).toBeInstanceOf(ProgressTracker);
    });

    it('should return null when progressToken is provided but sendNotification is not', () => {
        expect(createProgressTracker('tok', undefined)).toBeNull();
    });
});
