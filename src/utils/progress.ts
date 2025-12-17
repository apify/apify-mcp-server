import type { ProgressNotification } from '@modelcontextprotocol/sdk/types.js';

import type { ApifyClient } from '../apify-client.js';
import { PROGRESS_NOTIFICATION_INTERVAL_MS } from '../const.js';

export class ProgressTracker {
    private progressToken: string | number;
    private sendNotification: (notification: ProgressNotification) => Promise<void>;
    private currentProgress = 0;
    private intervalId?: NodeJS.Timeout;
    private taskId?: string;

    constructor(
        progressToken: string | number,
        sendNotification: (notification: ProgressNotification) => Promise<void>,
        taskId?: string,
    ) {
        this.progressToken = progressToken;
        this.sendNotification = sendNotification;
        this.taskId = taskId;
    }

    async updateProgress(message?: string): Promise<void> {
        this.currentProgress += 1;

        try {
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
        } catch {
            // Silent fail - don't break execution
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
): ProgressTracker | null {
    if (!progressToken || !sendNotification) {
        return null;
    }

    return new ProgressTracker(progressToken, sendNotification, taskId);
}
