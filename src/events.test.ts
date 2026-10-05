import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { EVENT_KINDS, buildContext, formatDuration, parseEventKind, sampleEvent } from "./events.js";
import { renderTemplate, templateError } from "./template.js";

const NOW = new Date("2026-10-05T20:00:00.000Z");

describe("buildContext", () => {
    it("carries the schedule, and how far away it is", () => {
        const { event, host } = buildContext(sampleEvent("shutdown.scheduled", NOW), "zeus");
        expect(event).toMatchObject({
            kind: "shutdown.scheduled",
            level: "warning",
            title: "Shutdown scheduled",
            mode: "poweroff",
            scheduledAt: "2026-10-05T20:10:00.000Z",
            occurredAt: "2026-10-05T20:00:00.000Z",
            secondsUntil: 600,
            remaining: "10 min",
            wallMessage: "Maintenance",
        });
        expect(event.message).toBe(`Shutdown (poweroff) scheduled for ${event.scheduledAtLocal}`);
        expect(host).toEqual({ name: "zeus" });
    });

    it("says how long is left in a reminder", () => {
        const { event } = buildContext(sampleEvent("shutdown.reminder", NOW), "zeus");
        expect(event.message).toBe(`Shutdown (poweroff) in 5 min, at ${event.scheduledAtLocal}`);
        expect(event.level).toBe("info");
    });

    it("has no schedule left after a cancellation", () => {
        const { event } = buildContext(sampleEvent("shutdown.cancelled", NOW), "zeus");
        expect(event).toMatchObject({
            kind: "shutdown.cancelled",
            level: "info",
            mode: null,
            scheduledAt: null,
            scheduledAtLocal: null,
            secondsUntil: null,
            remaining: null,
        });
    });

    it("gives every event an id of its own", () => {
        const event = sampleEvent("shutdown.scheduled", NOW);
        expect(buildContext(event, "zeus").event.id).not.toBe(buildContext(event, "zeus").event.id);
    });
});

describe("formatDuration", () => {
    it("names the two largest units", () => {
        expect(formatDuration(45)).toBe("45 s");
        expect(formatDuration(300)).toBe("5 min");
        expect(formatDuration(5400)).toBe("1 h 30 min");
        expect(formatDuration(7200)).toBe("2 h");
        expect(formatDuration(183_600)).toBe("2 d 3 h");
        expect(formatDuration(-5)).toBe("0 s");
    });
});

describe("parseEventKind", () => {
    it("takes a kind with or without its prefix", () => {
        expect(parseEventKind("reminder")).toBe("shutdown.reminder");
        expect(parseEventKind("shutdown.cancelled")).toBe("shutdown.cancelled");
        expect(parseEventKind("reboot")).toBeNull();
    });
});

describe("config/template.json", () => {
    const source = fs.readFileSync(new URL("../config/template.json", import.meta.url), "utf8");
    const body = (kind: (typeof EVENT_KINDS)[number]) =>
        renderTemplate(JSON.parse(source), buildContext(sampleEvent(kind, NOW), "zeus"));

    it("is a template the engine takes", () => {
        expect(templateError(source)).toBeNull();
    });

    it("hands on what the event carries, with its types", () => {
        expect(body("shutdown.scheduled")).toMatchObject({
            source: "shutdown-notifier",
            host: "zeus",
            kind: "shutdown.scheduled",
            level: "warning",
            title: "Shutdown scheduled",
            mode: "poweroff",
            scheduledAt: "2026-10-05T20:10:00.000Z",
            secondsUntil: 600,
            wallMessage: "Maintenance",
            timestamp: "2026-10-05T20:00:00.000Z",
        });
    });

    it("has no schedule left after a cancellation", () => {
        expect(body("shutdown.cancelled")).toMatchObject({
            kind: "shutdown.cancelled",
            level: "info",
            mode: null,
            scheduledAt: null,
            secondsUntil: null,
        });
    });
});

describe("samples/ha-lognotifier/template.json", () => {
    const source = fs.readFileSync(new URL("../samples/ha-lognotifier/template.json", import.meta.url), "utf8");
    const message = (kind: (typeof EVENT_KINDS)[number]) => {
        const body = renderTemplate(JSON.parse(source), buildContext(sampleEvent(kind, NOW), "zeus"));
        return body as { level: string; title: string; blocks: { rows: { label: string }[][] }[] };
    };
    const labels = (kind: (typeof EVENT_KINDS)[number]) =>
        message(kind).blocks[0].rows.map((row) => row.map((field) => field.label));

    it("is a template the engine takes", () => {
        expect(templateError(source)).toBeNull();
    });

    it("warns of a shutdown, with its mode and its time", () => {
        expect(message("shutdown.scheduled")).toMatchObject({ level: "warning", title: "⚠️ zeus: Shutdown scheduled" });
        expect(message("shutdown.reminder").title).toBe("⏰ zeus: Reminder: scheduled shutdown");
        expect(labels("shutdown.reminder")).toEqual([
            ["Host", "Mode"],
            ["Shutdown at", "Time left"],
            ["Event", "Noticed"],
        ]);
    });

    it("gives the all-clear without a mode and a time", () => {
        expect(message("shutdown.cancelled")).toMatchObject({
            level: "info",
            title: "✅ zeus: Scheduled shutdown cancelled",
        });
        expect(labels("shutdown.cancelled")).toEqual([["Host"], ["Event", "Noticed"]]);
    });
});
