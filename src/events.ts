import { randomUUID } from "node:crypto";
import type { ShutdownState } from "./shutdownState.js";

export const EVENT_KINDS = ["shutdown.scheduled", "shutdown.reminder", "shutdown.cancelled"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export type EventLevel = "info" | "warning";

/** What happened, before it is put into words for a template. */
export interface ShutdownEvent {
    kind: EventKind;
    occurredAt: Date;
    /** The schedule the event is about. Nothing is scheduled any more after a cancellation. */
    state: ShutdownState;
}

/** What a template can read. Documented field by field in the README. */
export interface NotifyContext {
    event: {
        id: string;
        kind: EventKind;
        level: EventLevel;
        /** A short heading, such as `Shutdown scheduled`. */
        title: string;
        /** One sentence saying all of it. */
        message: string;
        mode: string | null;
        /** ISO 8601. */
        scheduledAt: string | null;
        /** In the time zone of the process (`TZ`). */
        scheduledAtLocal: string | null;
        occurredAt: string;
        occurredAtLocal: string;
        secondsUntil: number | null;
        /** `secondsUntil` in words, such as `5 min`. */
        remaining: string | null;
        wallMessage: string | null;
    };
    host: {
        name: string;
    };
}

const TITLES: Record<EventKind, string> = {
    "shutdown.scheduled": "Shutdown scheduled",
    "shutdown.reminder": "Reminder: scheduled shutdown",
    "shutdown.cancelled": "Scheduled shutdown cancelled",
};

/** Built on first use, so it follows the `TZ` the process runs with. */
let localFormat: Intl.DateTimeFormat | undefined;

export function formatLocal(date: Date): string {
    localFormat ??= new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "long" });
    return localFormat.format(date);
}

/** `45 s`, `5 min`, `1 h 30 min`, `2 d 3 h` -- the two largest units, rounded down. */
export function formatDuration(seconds: number): string {
    const s = Math.max(0, Math.floor(seconds));
    if (s < 60) return `${s} s`;
    const units: [string, number][] = [
        ["d", Math.floor(s / 86_400)],
        ["h", Math.floor((s % 86_400) / 3_600)],
        ["min", Math.floor((s % 3_600) / 60)],
    ];
    const first = units.findIndex(([, value]) => value > 0);
    return units
        .slice(first, first + 2)
        .filter(([, value]) => value > 0)
        .map(([unit, value]) => `${value} ${unit}`)
        .join(" ");
}

function message(kind: EventKind, mode: string | null, at: string | null, remaining: string | null): string {
    if (kind === "shutdown.cancelled") return "The scheduled shutdown was cancelled";
    const what = mode ? `Shutdown (${mode})` : "Shutdown";
    if (kind === "shutdown.reminder") {
        return `${what} in ${remaining ?? "a moment"}${at ? `, at ${at}` : ""}`;
    }
    return `${what} scheduled${at ? ` for ${at}` : ""}`;
}

export function buildContext(event: ShutdownEvent, hostname: string): NotifyContext {
    const { kind, occurredAt, state } = event;
    const scheduledAt = state.scheduledAt;
    const secondsUntil = scheduledAt
        ? Math.max(0, Math.round((scheduledAt.getTime() - occurredAt.getTime()) / 1000))
        : null;
    const scheduledAtLocal = scheduledAt ? formatLocal(scheduledAt) : null;
    const remaining = secondsUntil === null ? null : formatDuration(secondsUntil);
    return {
        event: {
            id: randomUUID(),
            kind,
            level: kind === "shutdown.scheduled" ? "warning" : "info",
            title: TITLES[kind],
            message: message(kind, state.mode, scheduledAtLocal, remaining),
            mode: state.mode,
            scheduledAt: scheduledAt ? scheduledAt.toISOString() : null,
            scheduledAtLocal,
            occurredAt: occurredAt.toISOString(),
            occurredAtLocal: formatLocal(occurredAt),
            secondsUntil,
            remaining,
            wallMessage: state.wallMessage,
        },
        host: { name: hostname },
    };
}

/** The event `--test` renders and sends: a power-off in ten minutes, its reminder, or its cancellation. */
export function sampleEvent(kind: EventKind, now = new Date()): ShutdownEvent {
    const minutes = kind === "shutdown.reminder" ? 5 : 10;
    return {
        kind,
        occurredAt: now,
        state:
            kind === "shutdown.cancelled"
                ? { scheduledAt: null, mode: null, wallMessage: null }
                : {
                      scheduledAt: new Date(now.getTime() + minutes * 60_000),
                      mode: "poweroff",
                      wallMessage: "Maintenance",
                  },
    };
}

/** `reminder` or `shutdown.reminder`. Null for a name that is no kind. */
export function parseEventKind(name: string): EventKind | null {
    const full = name.includes(".") ? name : `shutdown.${name}`;
    return (EVENT_KINDS as readonly string[]).includes(full) ? (full as EventKind) : null;
}
