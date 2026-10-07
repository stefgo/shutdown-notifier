import os from "node:os";
import { LOG_LEVELS, type LogLevel } from "./logger.js";

export interface Config {
    /** The directory systemd-logind writes its schedule into. */
    monitorPath: string;
    /** The file in it that holds the schedule. */
    monitorFile: string;
    /** How long a change has to settle before it is read. */
    notifyDelayMs: number;
    /** How long before the shutdown the reminder is sent. 0 sends none. */
    reminderMs: number;
    /** How often the schedule is read without a change having been seen. 0 never does. */
    pollIntervalMs: number;
    /** The JSON file holding the body template. */
    httpTemplateFile: string;
    /** Where the notification goes. Null logs the events without sending anything. */
    httpUrl: string | null;
    httpHeaders: Record<string, string>;
    httpTimeoutMs: number;
    /** The broker the events are published to as well, `mqtt://` or `mqtts://`. Null publishes nothing. */
    mqttUrl: string | null;
    /** May hold placeholders. */
    mqttTopic: string;
    mqttUsername: string | null;
    mqttPassword: string | null;
    mqttClientId: string;
    mqttQos: 0 | 1;
    mqttRetain: boolean;
    mqttTimeoutMs: number;
    /** The JSON file holding the payload template. Needed once a broker is set. */
    mqttTemplateFile: string | null;
    /** What a template reads as `host.name`. */
    hostname: string;
    logLevel: LogLevel;
}

type Env = Record<string, string | undefined>;

/** Seconds from the environment, as milliseconds. */
function seconds(env: Env, name: string, fallback: number, min = 0): number {
    const raw = env[name]?.trim();
    if (!raw) return fallback * 1000;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min) {
        throw new Error(`${name}: "${raw}" is not a number of seconds${min > 0 ? ` of at least ${min}` : ""}`);
    }
    return Math.round(value * 1000);
}

function headers(env: Env, name: string): Record<string, string> {
    const raw = env[name]?.trim();
    if (!raw) return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        throw new Error(`${name}: not valid JSON: ${(e as Error).message}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${name}: takes a JSON object, such as {"X-Gotify-Key": "token"}`);
    }
    for (const [header, value] of Object.entries(parsed)) {
        if (typeof value !== "string") throw new Error(`${name}: the value of "${header}" is not text`);
    }
    return parsed as Record<string, string>;
}

function qos(env: Env, name: string): 0 | 1 {
    const raw = env[name]?.trim();
    if (!raw) return 1;
    if (raw !== "0" && raw !== "1") throw new Error(`${name}: "${raw}" is not 0 or 1`);
    return raw === "0" ? 0 : 1;
}

function flag(env: Env, name: string): boolean {
    const raw = env[name]?.trim().toLowerCase();
    if (!raw) return false;
    if (raw !== "true" && raw !== "false") throw new Error(`${name}: "${raw}" is not true or false`);
    return raw === "true";
}

function logLevel(env: Env, name: string): LogLevel {
    const raw = env[name]?.trim().toLowerCase();
    if (!raw) return "info";
    if (!(LOG_LEVELS as readonly string[]).includes(raw)) {
        throw new Error(`${name}: "${raw}" is not one of ${LOG_LEVELS.join(", ")}`);
    }
    return raw as LogLevel;
}

/** Reads the configuration. Throws with a message naming the variable that is wrong. */
export function loadConfig(env: Env = process.env): Config {
    const hostname = env.SHUTDOWN_HOSTNAME?.trim() || os.hostname();
    // Not trimmed: a password may well end with a blank.
    const mqttUsername = env.SHUTDOWN_MQTT_USERNAME || null;
    const mqttPassword = env.SHUTDOWN_MQTT_PASSWORD || null;
    if (mqttPassword !== null && mqttUsername === null) {
        throw new Error("SHUTDOWN_MQTT_PASSWORD: MQTT takes no password without SHUTDOWN_MQTT_USERNAME");
    }
    return {
        monitorPath: (env.SHUTDOWN_MONITOR_PATH?.trim() || "/run/systemd/shutdown").replace(/\/+$/, "") || "/",
        monitorFile: env.SHUTDOWN_MONITOR_FILE?.trim() || "scheduled",
        notifyDelayMs: seconds(env, "SHUTDOWN_NOTIFY_DELAY", 3),
        reminderMs: seconds(env, "SHUTDOWN_REMEMBER_TIME", 300),
        pollIntervalMs: seconds(env, "SHUTDOWN_POLL_INTERVAL", 60),
        httpTemplateFile: env.SHUTDOWN_HTTP_TEMPLATE_FILE?.trim() || "/config/template.json",
        httpUrl: env.SHUTDOWN_HTTP_URL?.trim() || null,
        httpHeaders: headers(env, "SHUTDOWN_HTTP_HEADERS"),
        httpTimeoutMs: seconds(env, "SHUTDOWN_HTTP_TIMEOUT", 10, 0.001),
        mqttUrl: env.SHUTDOWN_MQTT_URL?.trim() || null,
        mqttTopic: env.SHUTDOWN_MQTT_TOPIC?.trim() || "shutdown-notifier/{{host.name}}",
        mqttUsername,
        mqttPassword,
        mqttClientId: env.SHUTDOWN_MQTT_CLIENT_ID?.trim() || `shutdown-notifier-${hostname}`,
        mqttQos: qos(env, "SHUTDOWN_MQTT_QOS"),
        mqttRetain: flag(env, "SHUTDOWN_MQTT_RETAIN"),
        mqttTimeoutMs: seconds(env, "SHUTDOWN_MQTT_TIMEOUT", 10, 0.001),
        mqttTemplateFile: env.SHUTDOWN_MQTT_TEMPLATE_FILE?.trim() || null,
        hostname,
        logLevel: logLevel(env, "SHUTDOWN_LOG_LEVEL"),
    };
}
