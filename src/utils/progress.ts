import type { ProgressNotification } from '@modelcontextprotocol/sdk/types.js';
import { RELATED_TASK_META_KEY } from '@modelcontextprotocol/sdk/types.js';

import type { ApifyClient } from '../apify_client.js';
import { APIFY_ACTOR_RUN_META_KEY } from './mcp.js';

// Kept at/above Apify Console's own run-polling interval (MIN_OBSERVER_INTERVAL_MILLIS = 3000)
// so we don't poll the API more aggressively than the Console does.
// Exported for tests to keep fake-timer advances in sync with the production interval.
export const PROGRESS_NOTIFICATION_INTERVAL_MS = 3000;

export const TERMINAL_RUN_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);

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
    return showStatusMessage ? `${actorName}: ${run.status} — ${run.statusMessage}` : `${actorName}: ${run.status}`;
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
    private runId?: string;

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

    /** Attaches a runId so every subsequent notifications/progress carries it. */
    setRunId(runId: string): void {
        this.runId = runId;
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
                        // _meta must live in params — JSONRPCNotificationSchema is .strict(), a
                        // top-level _meta drops the whole message as "Unknown message type".
                        ...((this.taskId || this.runId) && {
                            _meta: {
                                ...(this.taskId && { [RELATED_TASK_META_KEY]: { taskId: this.taskId } }),
                                ...(this.runId && { [APIFY_ACTOR_RUN_META_KEY]: { runId: this.runId } }),
                            },
                        }),
                    },
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
        this.startStatusUpdates(
            async () => {
                const run = await apifyClient.run(runId).get();
                return run && { status: run.status, message: formatRunStatusMessage(actorName, run) };
            },
            initial &&
                formatRunStatusMessage(actorName, {
                    status: initial.status ?? '',
                    statusMessage: initial.statusMessage,
                }),
        );
    }

    /**
     * Polls `fetchStatus` every `PROGRESS_NOTIFICATION_INTERVAL_MS` and emits its message whenever it
     * changes, stopping once the status is terminal. `initialMessage` is what the caller emitted before
     * starting, so the first tick does not repeat it.
     */
    private startStatusUpdates(
        fetchStatus: () => Promise<{ status: string; message: string } | undefined>,
        initialMessage: string | undefined,
    ): void {
        this.stop();
        this.stopped = false;
        let lastMessage = initialMessage;
        let tickInProgress = false;

        this.intervalId = setInterval(async () => {
            // Skip if a previous tick is still awaiting the fetch / updateProgress() — otherwise
            // a slow tick can overlap with the next one and cause out-of-order emissions.
            if (tickInProgress) return;
            tickInProgress = true;
            try {
                const current = await fetchStatus();
                // stop() may have been called while the fetch was awaiting; clearInterval can't
                // abort an in-flight tick, so guard here to avoid a late duplicate emission.
                if (this.stopped || !current) return;

                if (current.message !== lastMessage) {
                    lastMessage = current.message;
                    await this.updateProgress(current.message);

                    if (TERMINAL_RUN_STATUSES.has(current.status)) {
                        this.stop();
                    }
                }
            } catch {
                // Silent fail - continue polling
            } finally {
                tickInProgress = false;
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
