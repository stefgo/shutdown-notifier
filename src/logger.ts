export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

let threshold: LogLevel = "info";

function write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(threshold)) return;
    const extra = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : "";
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}${extra}`;
    if (level === "error" || level === "warn") console.error(line);
    else console.log(line);
}

export const logger = {
    setLevel(level: LogLevel): void {
        threshold = level;
    },
    debug: (message: string, fields?: Record<string, unknown>) => write("debug", message, fields),
    info: (message: string, fields?: Record<string, unknown>) => write("info", message, fields),
    warn: (message: string, fields?: Record<string, unknown>) => write("warn", message, fields),
    error: (message: string, fields?: Record<string, unknown>) => write("error", message, fields),
};
