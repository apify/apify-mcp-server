import type { ProgressNotification } from '@modelcontextprotocol/sdk/types.js';

import { ApifyClient } from '../apify-client.js';
import { PROGRESS_NOTIFICATION_INTERVAL_MS } from '../const.js';

export class ProgressTracker {
    private progressToken: string | number;
    private sendNotification: (notification: ProgressNotification) => Promise<void>;
    private currentProgress = 0;
    private intervalId?: NodeJS.Timeout;

    constructor(
        progressToken: string | number,
        sendNotification: (notification: ProgressNotification) => Promise<void>,
    ) {
        this.progressToken = progressToken;
        this.sendNotification = sendNotification;
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
            };

            await this.sendNotification(notification);
        } catch {
            // Silent fail - don't break execution
        }
    }

    startActorRunUpdates(runId: string, apifyToken: string, actorName: string): void {
        this.stop();
        const client = new ApifyClient({ token: apifyToken });
        let lastStatus = '';
        let lastStatusMessage = '';

        this.intervalId = setInterval(async () => {
            try {
                const run = await client.run(runId).get();
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

                    // Stop polling if actor finished
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
): ProgressTracker | null {
    if (!progressToken || !sendNotification) {
        return null;
    }

    return new ProgressTracker(progressToken, sendNotification);
}
