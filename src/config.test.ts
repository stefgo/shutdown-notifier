import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
    it("has a default for everything but the URL", () => {
        expect(loadConfig({})).toMatchObject({
            monitorPath: "/run/systemd/shutdown",
            monitorFile: "scheduled",
            notifyDelayMs: 3_000,
            reminderMs: 300_000,
            pollIntervalMs: 60_000,
            templateFile: "/config/template.json",
            notifyUrl: null,
            notifyHeaders: {},
            notifyTimeoutMs: 10_000,
            logLevel: "info",
        });
    });

    it("reads times in seconds", () => {
        const config = loadConfig({ SHUTDOWN_NOTIFY_DELAY: "0.5", SHUTDOWN_REMEMBER_TIME: "0" });
        expect(config).toMatchObject({ notifyDelayMs: 500, reminderMs: 0 });
    });

    it("drops the slashes a path ends with", () => {
        expect(loadConfig({ SHUTDOWN_MONITOR_PATH: "/run/x//" }).monitorPath).toBe("/run/x");
    });

    it("reads the headers as a JSON object of texts", () => {
        expect(loadConfig({ SHUTDOWN_NOTIFY_HEADERS: '{"X-Gotify-Key":"abc"}' }).notifyHeaders).toEqual({
            "X-Gotify-Key": "abc",
        });
        expect(() => loadConfig({ SHUTDOWN_NOTIFY_HEADERS: "X-Key: abc" })).toThrow(/not valid JSON/);
        expect(() => loadConfig({ SHUTDOWN_NOTIFY_HEADERS: "[]" })).toThrow(/takes a JSON object/);
        expect(() => loadConfig({ SHUTDOWN_NOTIFY_HEADERS: '{"a":1}' })).toThrow(/"a" is not text/);
    });

    it("names the variable that is wrong", () => {
        expect(() => loadConfig({ SHUTDOWN_NOTIFY_DELAY: "soon" })).toThrow(/^SHUTDOWN_NOTIFY_DELAY: /);
        expect(() => loadConfig({ SHUTDOWN_NOTIFY_TIMEOUT: "0" })).toThrow(/^SHUTDOWN_NOTIFY_TIMEOUT: /);
        expect(() => loadConfig({ SHUTDOWN_LOG_LEVEL: "loud" })).toThrow(/^SHUTDOWN_LOG_LEVEL: /);
    });
});
