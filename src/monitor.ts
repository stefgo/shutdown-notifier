import fs from "node:fs";
import path from "node:path";
import type { ShutdownEvent } from "./events.js";
import { logger } from "./logger.js";
import { readShutdownState, sameSchedule, type ShutdownState } from "./shutdownState.js";

/** The longest wait `setTimeout` takes; a longer one fires at once. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** Calls `onChange` whenever the schedule may have changed; returns what stops it. */
export type Watch = (directory: string, file: string, onChange: () => void) => () => void;

export interface MonitorOptions {
    directory: string;
    file: string;
    notifyDelayMs: number;
    reminderMs: number;
    pollIntervalMs: number;
    emit: (event: ShutdownEvent) => void;
    /** For tests. */
    read?: () => ShutdownState;
    watch?: Watch;
}

/**
 * Watches the directory, not the file: logind replaces the file by renaming a new one over
 * it, and a watch on the file itself would keep following the one that is gone.
 */
const watchDirectory: Watch = (directory, file, onChange) => {
    const watcher = fs.watch(directory, (_type, name) => {
        if (name === null || name === file) onChange();
    });
    watcher.on("error", (err) => logger.warn("Watching the schedule failed", { reason: err.message }));
    return () => watcher.close();
};

/**
 * Follows the schedule and reports what changes in it: a shutdown that is scheduled, one
 * that is cancelled, and a reminder some time before it happens.
 */
export class Monitor {
    private current: ShutdownState = { scheduledAt: null, mode: null, wallMessage: null };
    private settle: NodeJS.Timeout | null = null;
    private reminder: NodeJS.Timeout | null = null;
    private poll: NodeJS.Timeout | null = null;
    private unwatch: (() => void) | null = null;
    private readonly read: () => ShutdownState;

    constructor(private readonly options: MonitorOptions) {
        const file = path.join(options.directory, options.file);
        this.read = options.read ?? (() => readShutdownState(file));
    }

    /** Reports a shutdown that is already scheduled, then every change from here on. */
    start(): void {
        this.check();
        try {
            this.unwatch = (this.options.watch ?? watchDirectory)(this.options.directory, this.options.file, () =>
                this.changed(),
            );
        } catch (err) {
            logger.warn("Cannot watch the schedule, reading it at intervals only", {
                directory: this.options.directory,
                reason: (err as Error).message,
            });
        }
        // What a watch can miss -- a directory that was replaced under it -- the interval finds.
        if (this.options.pollIntervalMs > 0) {
            this.poll = setInterval(() => this.check(), this.options.pollIntervalMs);
        }
    }

    stop(): void {
        this.unwatch?.();
        this.unwatch = null;
        for (const timer of [this.settle, this.reminder, this.poll]) {
            if (timer) clearTimeout(timer);
        }
        this.settle = this.reminder = this.poll = null;
    }

    /** A change is read once it has settled: logind writes the file in several steps. */
    private changed(): void {
        logger.debug("The schedule changed");
        if (this.settle) clearTimeout(this.settle);
        this.settle = setTimeout(() => {
            this.settle = null;
            this.check();
        }, this.options.notifyDelayMs);
    }

    private check(): void {
        const state = this.read();
        if (sameSchedule(this.current, state)) return;
        this.current = state;
        if (this.reminder) clearTimeout(this.reminder);
        this.reminder = null;

        if (state.mode) {
            logger.info("Shutdown scheduled", { mode: state.mode, at: state.scheduledAt?.toISOString() ?? null });
            this.options.emit({ kind: "shutdown.scheduled", occurredAt: new Date(), state });
            this.armReminder(state);
        } else {
            logger.info("Scheduled shutdown cancelled");
            this.options.emit({ kind: "shutdown.cancelled", occurredAt: new Date(), state });
        }
    }

    /** No reminder for a shutdown that is closer than the reminder would be early. */
    private armReminder(state: ShutdownState): void {
        if (!state.scheduledAt || this.options.reminderMs <= 0) return;
        const at = state.scheduledAt.getTime() - this.options.reminderMs;
        if (at <= Date.now()) return;
        const arm = (): void => {
            const wait = at - Date.now();
            this.reminder =
                wait > MAX_TIMEOUT_MS
                    ? setTimeout(arm, MAX_TIMEOUT_MS)
                    : setTimeout(() => {
                          this.reminder = null;
                          logger.info("Reminding of the scheduled shutdown");
                          this.options.emit({ kind: "shutdown.reminder", occurredAt: new Date(), state });
                      }, wait);
        };
        arm();
    }
}
