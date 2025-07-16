import type { ProgressNotification } from '@modelcontextprotocol/sdk/types.js';

import { ApifyClient } from '../apify-client.js';

export class ProgressTracker {
    private progressToken: string | number;
    private sendNotification: (notification: ProgressNotification) => Promise<void>;
    private currentProgress = 0;
    private total = 100;
    private intervalId?: NodeJS.Timeout;

    constructor(
        progressToken: string | number,
        sendNotification: (notification: ProgressNotification) => Promise<void>,
        total = 100,
    ) {
        this.progressToken = progressToken;
        this.sendNotification = sendNotification;
        this.total = total;
    }

    async updateProgress(progress: number, message?: string): Promise<void> {
        this.currentProgress = Math.min(progress, this.total);

        try {
            const notification: ProgressNotification = {
                method: 'notifications/progress' as const,
                params: {
                    progressToken: this.progressToken,
                    progress: this.currentProgress,
                    total: this.total,
                    ...(message && { message }),
                },
            };

            await this.sendNotification(notification);
        } catch {
            // Silent fail - don't break execution
        }
    }

    startActorRunUpdates(runId: string, apifyToken: string, actorName: string): void {
        this.stopPeriodicUpdates();
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

                    // Calculate progress based on status
                    let progress = 0;
                    if (status === 'RUNNING') progress = 50;
                    else if (status === 'SUCCEEDED') progress = 100;
                    else if (status === 'FAILED') progress = 100;

                    const message = statusMessage
                        ? `${actorName}: ${statusMessage}`
                        : `${actorName}: ${status}`;

                    await this.updateProgress(progress, message);

                    // Stop polling if actor finished
                    if (status === 'SUCCEEDED' || status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
                        this.stopPeriodicUpdates();
                    }
                }
            } catch {
                // Silent fail - continue polling
            }
        }, 5_000);
    }

    stopPeriodicUpdates(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }
    }

    async complete(message = 'Completed'): Promise<void> {
        this.stopPeriodicUpdates();
        await this.updateProgress(this.total, message);
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
