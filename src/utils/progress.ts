import type { ProgressNotification } from '@modelcontextprotocol/sdk/types.js';

import type { ApifyClient } from '../apify_client.js';
import { PROGRESS_NOTIFICATION_INTERVAL_MS, RELATED_TASK_META_KEY } from '../const.js';

const TERMINAL_RUN_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);

/**
 * Leads with the run status so clients can see lifecycle transitions
 * (RUNNING → SUCCEEDED) and never miss a terminal flip behind a stale statusMessage.
 * At terminal status the message is only appended when the actor explicitly marked it
 * terminal — otherwise it's an in-progress message left over from before the flip.
 */
export function formatRunStatusMessage(
    actorName: string,
    run: { status: string; statusMessage?: string | null; isStatusMessageTerminal?: boolean | null },
): string {
    const isTerminal = TERMINAL_RUN_STATUSES.has(run.status);
    const showStatusMessage = run.statusMessage && (!isTerminal || run.isStatusMessageTerminal === true);
    return showStatusMessage
        ? `${actorName}: ${run.status} — ${run.statusMessage}`
        : `${actorName}: ${run.status}`;
}

export class ProgressTracker {
    private progressToken?: string | number;
    private sendNotification?: (notification: ProgressNotification) => Promise<void>;
    private currentProgress = 0;
    private intervalId?: NodeJS.Timeout;
    private stopped = false;
    private lastEmittedMessage?: string;
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
        // Dedup consecutive identical messages so a polling tick that emitted the
        // terminal status doesn't double-emit when the caller also explicitly emits.
        if (message !== undefined && message === this.lastEmittedMessage) {
            return;
        }
        this.lastEmittedMessage = message;
        this.currentProgress += 1;

        // Send progress notification only if progressToken and sendNotification are available
        if (this.progressToken !== undefined && this.progressToken !== null && this.sendNotification) {
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
                            [RELATED_TASK_META_KEY]: {
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

        // Update task statusMessage if callback is provided
        if (this.onStatusMessage && message) {
            try {
                await this.onStatusMessage(message);
            } catch {
                // Silent fail - don't break execution
            }
        }
    }

    startActorRunUpdates(
        runId: string,
        apifyClient: ApifyClient,
        actorName: string,
        initial?: { status?: string; statusMessage?: string | null },
    ): void {
        this.stop();
        this.stopped = false;
        let lastStatus = initial?.status ?? '';
        let lastStatusMessage = initial?.statusMessage || '';
        let tickInFlight = false;

        this.intervalId = setInterval(async () => {
            // Skip if a previous tick is still awaiting run.get() / updateProgress() — otherwise
            // a slow tick can overlap with the next one and cause out-of-order emissions.
            if (tickInFlight) return;
            tickInFlight = true;
            try {
                const run = await apifyClient.run(runId).get();
                // stop() may have been called while run.get() was awaiting; clearInterval can't
                // abort an in-flight tick, so guard here to avoid a late duplicate emission.
                if (this.stopped || !run) return;

                const { status, statusMessage } = run;
                const normalizedStatusMessage = statusMessage || '';

                // Only send notification if status or statusMessage changed
                if (status !== lastStatus || normalizedStatusMessage !== lastStatusMessage) {
                    lastStatus = status;
                    lastStatusMessage = normalizedStatusMessage;

                    await this.updateProgress(formatRunStatusMessage(actorName, run));

                    // Stop polling if Actor finished
                    if (TERMINAL_RUN_STATUSES.has(status)) {
                        this.stop();
                    }
                }
            } catch {
                // Silent fail - continue polling
            } finally {
                tickInFlight = false;
            }
        }, PROGRESS_NOTIFICATION_INTERVAL_MS);
    }

    stop(): void {
        this.stopped = true;
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
    const hasProgressNotificationSupport = progressToken !== undefined && progressToken !== null && !!sendNotification;
    if (!hasProgressNotificationSupport && !onStatusMessage) {
        return null;
    }

    return new ProgressTracker({ progressToken, sendNotification, taskId, onStatusMessage });
}
