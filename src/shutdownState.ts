import fs from "node:fs";

/**
 * What systemd-logind has scheduled, read from `/run/systemd/shutdown/scheduled`:
 *
 *     USEC=1759696200000000
 *     WARN_WALL=1
 *     MODE=poweroff
 *     WALL_MESSAGE=Maintenance
 *
 * The file exists for as long as a shutdown is scheduled and is removed when it is cancelled.
 */
export interface ShutdownState {
    /** When the shutdown happens. Null when the file names no usable time. */
    scheduledAt: Date | null;
    /** `poweroff`, `reboot`, `halt`, … Null means nothing is scheduled. */
    mode: string | null;
    wallMessage: string | null;
}

export const NOTHING_SCHEDULED: ShutdownState = { scheduledAt: null, mode: null, wallMessage: null };

export function parseShutdownState(text: string): ShutdownState {
    const state: ShutdownState = { ...NOTHING_SCHEDULED };
    for (const line of text.split("\n")) {
        const at = line.indexOf("=");
        if (at < 0) continue;
        const key = line.slice(0, at).trim().toUpperCase();
        const value = line.slice(at + 1).trim();
        if (key === "USEC") {
            // Microseconds since the epoch.
            const date = new Date(Number(value) / 1000);
            state.scheduledAt = /^\d+$/.test(value) && !Number.isNaN(date.getTime()) ? date : null;
        } else if (key === "MODE") {
            state.mode = value || null;
        } else if (key === "WALL_MESSAGE") {
            state.wallMessage = value || null;
        }
    }
    return state;
}

/** Reads the schedule. A file that is not there, or cannot be read, is no schedule. */
export function readShutdownState(file: string): ShutdownState {
    try {
        return parseShutdownState(fs.readFileSync(file, "utf8"));
    } catch {
        return { ...NOTHING_SCHEDULED };
    }
}

/** Whether two states are the same schedule: the same mode at the same time. */
export function sameSchedule(a: ShutdownState, b: ShutdownState): boolean {
    return a.mode === b.mode && (a.scheduledAt?.getTime() ?? null) === (b.scheduledAt?.getTime() ?? null);
}
