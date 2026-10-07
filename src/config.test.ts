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
            httpTemplateFile: "/config/template.json",
            httpUrl: null,
            httpHeaders: {},
            httpTimeoutMs: 10_000,
            mqttUrl: null,
            mqttTopic: "shutdown-notifier/{{host.name}}",
            mqttUsername: null,
            mqttPassword: null,
            mqttQos: 1,
            mqttRetain: false,
            mqttTimeoutMs: 10_000,
            mqttTemplateFile: null,
            logLevel: "info",
        });
    });

    it("names the MQTT client after the host", () => {
        expect(loadConfig({ SHUTDOWN_HOSTNAME: "zeus" }).mqttClientId).toBe("shutdown-notifier-zeus");
        expect(loadConfig({ SHUTDOWN_MQTT_CLIENT_ID: "notifier" }).mqttClientId).toBe("notifier");
    });

    it("reads how the broker is spoken to", () => {
        const config = loadConfig({
            SHUTDOWN_MQTT_URL: " mqtts://broker ",
            SHUTDOWN_MQTT_USERNAME: "u",
            SHUTDOWN_MQTT_PASSWORD: "p ",
            SHUTDOWN_MQTT_QOS: "0",
            SHUTDOWN_MQTT_RETAIN: "True",
            SHUTDOWN_MQTT_TIMEOUT: "2.5",
        });
        expect(config).toMatchObject({
            mqttUrl: "mqtts://broker",
            mqttUsername: "u",
            mqttPassword: "p ",
            mqttQos: 0,
            mqttRetain: true,
            mqttTimeoutMs: 2_500,
        });
        expect(() => loadConfig({ SHUTDOWN_MQTT_TIMEOUT: "0" })).toThrow(/^SHUTDOWN_MQTT_TIMEOUT: /);
        expect(() => loadConfig({ SHUTDOWN_MQTT_QOS: "2" })).toThrow(/^SHUTDOWN_MQTT_QOS: /);
        expect(() => loadConfig({ SHUTDOWN_MQTT_RETAIN: "yes" })).toThrow(/^SHUTDOWN_MQTT_RETAIN: /);
        expect(() => loadConfig({ SHUTDOWN_MQTT_PASSWORD: "p" })).toThrow(/^SHUTDOWN_MQTT_PASSWORD: /);
    });

    it("reads times in seconds", () => {
        const config = loadConfig({ SHUTDOWN_NOTIFY_DELAY: "0.5", SHUTDOWN_REMEMBER_TIME: "0" });
        expect(config).toMatchObject({ notifyDelayMs: 500, reminderMs: 0 });
    });

    it("drops the slashes a path ends with", () => {
        expect(loadConfig({ SHUTDOWN_MONITOR_PATH: "/run/x//" }).monitorPath).toBe("/run/x");
    });

    it("reads the headers as a JSON object of texts", () => {
        expect(loadConfig({ SHUTDOWN_HTTP_HEADERS: '{"X-Gotify-Key":"abc"}' }).httpHeaders).toEqual({
            "X-Gotify-Key": "abc",
        });
        expect(() => loadConfig({ SHUTDOWN_HTTP_HEADERS: "X-Key: abc" })).toThrow(/not valid JSON/);
        expect(() => loadConfig({ SHUTDOWN_HTTP_HEADERS: "[]" })).toThrow(/takes a JSON object/);
        expect(() => loadConfig({ SHUTDOWN_HTTP_HEADERS: '{"a":1}' })).toThrow(/"a" is not text/);
    });

    it("names the variable that is wrong", () => {
        expect(() => loadConfig({ SHUTDOWN_NOTIFY_DELAY: "soon" })).toThrow(/^SHUTDOWN_NOTIFY_DELAY: /);
        expect(() => loadConfig({ SHUTDOWN_HTTP_TIMEOUT: "0" })).toThrow(/^SHUTDOWN_HTTP_TIMEOUT: /);
        expect(() => loadConfig({ SHUTDOWN_LOG_LEVEL: "loud" })).toThrow(/^SHUTDOWN_LOG_LEVEL: /);
    });
});
