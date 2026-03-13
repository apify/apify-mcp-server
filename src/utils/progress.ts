import type { ProgressNotification } from '@modelcontextprotocol/sdk/types.js';

import type { ApifyClient } from '../apify_client.js';
import { PROGRESS_NOTIFICATION_INTERVAL_MS } from '../const.js';

export class ProgressTracker {
    private progressToken?: string | number;
    private sendNotification?: (notification: ProgressNotification) => Promise<void>;
    private currentProgress = 0;
    private intervalId?: NodeJS.Timeout;
    private taskId?: string;
    private onStatusMessage?: (message: string) => Promise<void>;

    constructor(options: {
        progressToken?: string | number;
        sendNotification?: (notification: ProgressNotification) => Promise<void>;
        taskId?: string;
        onStatusMessage?: (message: string) => Promise<void>;
    }) {
        this.progressToken = options.progressToken;
        this.sendNotification = options.sendNotification;
        this.taskId = options.taskId;
        this.onStatusMessage = options.onStatusMessage;
    }

    async updateProgress(message?: string): Promise<void> {
        this.currentProgress += 1;

        // Send progress notification only if progressToken and sendNotification are available
        if (this.progressToken && this.sendNotification) {
            const notification: ProgressNotification = {
                method: 'notifications/progress' as const,
                params: {
                    progressToken: this.progressToken,
                    progress: this.currentProgress,
                    ...(message && { message }),
                },
                // Per MCP spec: progress notifications during task execution should include related-task metadata
                ...(this.taskId && {
                    _meta: {
                        'io.modelcontextprotocol/related-task': {
                            taskId: this.taskId,
                        },
                    },
                }),
            };

            await this.sendNotification(notification);
        }

        // Update task statusMessage if callback is provided
        if (this.onStatusMessage && message) {
            await this.onStatusMessage(message);
        }
    }

    startActorRunUpdates(runId: string, apifyClient: ApifyClient, actorName: string): void {
        this.stop();
        let lastStatus = '';
        let lastStatusMessage = '';

        this.intervalId = setInterval(async () => {
            try {
                const run = await apifyClient.run(runId).get();
                if (!run) return;

                const { status, statusMessage } = run;

                // Only send notification if status or statusMessage changed
                if (status !== lastStatus || statusMessage !== lastStatusMessage) {
                    lastStatus = status;
                    lastStatusMessage = statusMessage || '';

                    const message = statusMessage
                        ? `${actorName}: ${statusMessage}`
                        : `${actorName}: ${status}`;

                    await this.updateProgress(message);

                    // Stop polling if Actor finished
                    if (status === 'SUCCEEDED' || status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
                        this.stop();
                    }
                }
            } catch {
                // Silent fail - continue polling
            }
        }, PROGRESS_NOTIFICATION_INTERVAL_MS);
    }

    stop(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }
    }
}

export function createProgressTracker(
    progressToken: string | number | undefined,
    sendNotification: ((notification: ProgressNotification) => Promise<void>) | undefined,
    taskId?: string,
    onStatusMessage?: (message: string) => Promise<void>,
): ProgressTracker | null {
    // Create tracker if we have either progress notification support or a status message callback
    if ((!progressToken || !sendNotification) && !onStatusMessage) {
        return null;
    }

    return new ProgressTracker({ progressToken, sendNotification, taskId, onStatusMessage });
}
