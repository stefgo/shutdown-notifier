import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShutdownEvent } from "./events.js";
import { Monitor } from "./monitor.js";
import { NOTHING_SCHEDULED, type ShutdownState } from "./shutdownState.js";

const NOW = new Date("2026-10-05T20:00:00.000Z").getTime();
const MINUTE = 60_000;

const scheduled = (inMs: number, mode = "poweroff"): ShutdownState => ({
    scheduledAt: new Date(NOW + inMs),
    mode,
    wallMessage: null,
});

/** A monitor over a schedule the test sets, with the watch in the test's hand. */
function setup(initial: ShutdownState = NOTHING_SCHEDULED, pollIntervalMs = 0) {
    let state = initial;
    let change: () => void = () => {};
    const events: ShutdownEvent[] = [];
    const unwatch = vi.fn();
    const monitor = new Monitor({
        directory: "/run/systemd/shutdown",
        file: "scheduled",
        notifyDelayMs: 3_000,
        reminderMs: 5 * MINUTE,
        pollIntervalMs,
        emit: (event) => events.push(event),
        read: () => state,
        watch: (_directory, _file, onChange) => {
            change = onChange;
            return unwatch;
        },
    });
    monitor.start();
    return {
        monitor,
        events,
        unwatch,
        kinds: () => events.map((event) => event.kind),
        /** Writes the schedule and reports the change, as the watch would. */
        write: (next: ShutdownState) => {
            state = next;
            change();
        },
        /** Writes the schedule without the watch noticing. */
        writeUnseen: (next: ShutdownState) => {
            state = next;
        },
    };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
});

afterEach(() => {
    vi.useRealTimers();
});

describe("Monitor", () => {
    it("says nothing at the start when nothing is scheduled", () => {
        expect(setup().events).toEqual([]);
    });

    it("reports at the start a shutdown that is already scheduled", () => {
        const { events } = setup(scheduled(30 * MINUTE));
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ kind: "shutdown.scheduled", state: { mode: "poweroff" } });
    });

    it("reports a new schedule once the change has settled", () => {
        const { kinds, write } = setup();
        write(scheduled(30 * MINUTE));
        vi.advanceTimersByTime(2_999);
        expect(kinds()).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(kinds()).toEqual(["shutdown.scheduled"]);
    });

    it("reads a burst of changes once", () => {
        const { kinds, write } = setup();
        write(scheduled(30 * MINUTE));
        vi.advanceTimersByTime(1_000);
        write(scheduled(30 * MINUTE));
        vi.advanceTimersByTime(3_000);
        expect(kinds()).toEqual(["shutdown.scheduled"]);
    });

    it("keeps quiet about a change that changed nothing", () => {
        const { kinds, write } = setup(scheduled(30 * MINUTE));
        write(scheduled(30 * MINUTE));
        vi.advanceTimersByTime(3_000);
        expect(kinds()).toEqual(["shutdown.scheduled"]);
    });

    it("reminds before the shutdown, of the schedule that was reported", () => {
        const { events, kinds } = setup(scheduled(30 * MINUTE, "reboot"));
        vi.advanceTimersByTime(25 * MINUTE - 1);
        expect(kinds()).toEqual(["shutdown.scheduled"]);
        vi.advanceTimersByTime(1);
        expect(kinds()).toEqual(["shutdown.scheduled", "shutdown.reminder"]);
        expect(events[1].state.mode).toBe("reboot");
    });

    it("does not remind of a shutdown closer than the reminder", () => {
        const { kinds } = setup(scheduled(2 * MINUTE));
        vi.advanceTimersByTime(10 * MINUTE);
        expect(kinds()).toEqual(["shutdown.scheduled"]);
    });

    it("reminds of a shutdown further away than a timer reaches", () => {
        const days = 40 * 24 * 60 * MINUTE;
        const { kinds } = setup(scheduled(days));
        vi.advanceTimersByTime(days - 5 * MINUTE - 1);
        expect(kinds()).toEqual(["shutdown.scheduled"]);
        vi.advanceTimersByTime(1);
        expect(kinds()).toEqual(["shutdown.scheduled", "shutdown.reminder"]);
    });

    it("reports a cancellation, and drops the reminder with it", () => {
        const { kinds, write } = setup(scheduled(30 * MINUTE));
        write(NOTHING_SCHEDULED);
        vi.advanceTimersByTime(60 * MINUTE);
        expect(kinds()).toEqual(["shutdown.scheduled", "shutdown.cancelled"]);
    });

    it("reports a shutdown that was moved, and reminds of the new time only", () => {
        const { kinds, write } = setup(scheduled(30 * MINUTE));
        write(scheduled(60 * MINUTE));
        vi.advanceTimersByTime(3_000);
        expect(kinds()).toEqual(["shutdown.scheduled", "shutdown.scheduled"]);
        vi.advanceTimersByTime(30 * MINUTE);
        expect(kinds()).toEqual(["shutdown.scheduled", "shutdown.scheduled"]);
        vi.advanceTimersByTime(25 * MINUTE);
        expect(kinds()).toEqual(["shutdown.scheduled", "shutdown.scheduled", "shutdown.reminder"]);
    });

    it("finds at the next interval a change the watch missed", () => {
        const { kinds, writeUnseen } = setup(NOTHING_SCHEDULED, 60_000);
        writeUnseen(scheduled(30 * MINUTE));
        vi.advanceTimersByTime(60_000);
        expect(kinds()).toEqual(["shutdown.scheduled"]);
    });

    it("stops watching and reporting", () => {
        const { monitor, kinds, unwatch, write } = setup(scheduled(30 * MINUTE), 60_000);
        write(NOTHING_SCHEDULED);
        monitor.stop();
        vi.advanceTimersByTime(60 * MINUTE);
        expect(unwatch).toHaveBeenCalledOnce();
        expect(kinds()).toEqual(["shutdown.scheduled"]);
    });
});
