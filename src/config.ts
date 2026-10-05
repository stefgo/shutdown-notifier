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
    templateFile: string;
    /** Where the notification goes. Null logs the events without sending anything. */
    notifyUrl: string | null;
    notifyHeaders: Record<string, string>;
    notifyTimeoutMs: number;
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
    return {
        monitorPath: (env.SHUTDOWN_MONITOR_PATH?.trim() || "/run/systemd/shutdown").replace(/\/+$/, "") || "/",
        monitorFile: env.SHUTDOWN_MONITOR_FILE?.trim() || "scheduled",
        notifyDelayMs: seconds(env, "SHUTDOWN_NOTIFY_DELAY", 3),
        reminderMs: seconds(env, "SHUTDOWN_REMEMBER_TIME", 300),
        pollIntervalMs: seconds(env, "SHUTDOWN_POLL_INTERVAL", 60),
        templateFile: env.SHUTDOWN_NOTIFY_TEMPLATE_FILE?.trim() || "/config/template.json",
        notifyUrl: env.SHUTDOWN_NOTIFY_URL?.trim() || null,
        notifyHeaders: headers(env, "SHUTDOWN_NOTIFY_HEADERS"),
        notifyTimeoutMs: seconds(env, "SHUTDOWN_NOTIFY_TIMEOUT", 10, 0.001),
        hostname: env.SHUTDOWN_HOSTNAME?.trim() || os.hostname(),
        logLevel: logLevel(env, "SHUTDOWN_LOG_LEVEL"),
    };
}
