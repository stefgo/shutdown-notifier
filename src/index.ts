import fs from "node:fs";
import { loadConfig, type Config } from "./config.js";
import { Notifier } from "./delivery.js";
import { EVENT_KINDS, parseEventKind, sampleEvent, type EventKind } from "./events.js";
import { logger } from "./logger.js";
import { Monitor } from "./monitor.js";
import { placeholderError, templateError } from "./template.js";

/** Reads and checks the body template. Throws with a message meant for the operator. */
function loadTemplate(file: string): unknown {
    let source: string;
    try {
        source = fs.readFileSync(file, "utf8");
    } catch (err) {
        throw new Error(`Cannot read the template ${file}: ${(err as Error).message}`);
    }
    const error = templateError(source);
    if (error) throw new Error(`Template ${file}: ${error}`);
    return JSON.parse(source);
}

function createNotifier(config: Config): Notifier {
    const template = loadTemplate(config.templateFile);
    const urlError = placeholderError(config.notifyUrl);
    if (urlError) throw new Error(`SHUTDOWN_NOTIFY_URL: ${urlError}`);
    const headerError = placeholderError(Object.values(config.notifyHeaders));
    if (headerError) throw new Error(`SHUTDOWN_NOTIFY_HEADERS: ${headerError}`);
    return new Notifier({
        url: config.notifyUrl,
        headers: config.notifyHeaders,
        timeoutMs: config.notifyTimeoutMs,
        template,
        hostname: config.hostname,
    });
}

/**
 * `--test [kind]`: renders a sample event, prints the body and -- with a notify URL -- sends
 * it once, without retries. What a template does is seen without scheduling a shutdown.
 */
async function test(notifier: Notifier, config: Config, kind: EventKind): Promise<boolean> {
    const request = notifier.render(sampleEvent(kind));
    console.log(JSON.stringify(request.body, null, 4));
    if (!config.notifyUrl) {
        console.error("SHUTDOWN_NOTIFY_URL is not set: rendered only, nothing sent.");
        return true;
    }
    const delivery = await notifier.send(request);
    if (delivery.error !== null) {
        console.error(`Not delivered: ${delivery.error}${delivery.response ? `\n${delivery.response}` : ""}`);
        return false;
    }
    console.error(`Delivered: HTTP ${delivery.status}`);
    return true;
}

async function main(args: string[]): Promise<void> {
    const config = loadConfig();
    logger.setLevel(config.logLevel);
    const notifier = createNotifier(config);

    const testAt = args.indexOf("--test");
    if (testAt >= 0) {
        const name = args[testAt + 1] ?? "scheduled";
        const kind = parseEventKind(name);
        if (!kind) throw new Error(`--test: "${name}" is not one of ${EVENT_KINDS.join(", ")}`);
        if (!(await test(notifier, config, kind))) process.exitCode = 1;
        return;
    }

    logger.info("Shutdown notifier started", {
        watching: `${config.monitorPath}/${config.monitorFile}`,
        template: config.templateFile,
        host: config.hostname,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    if (!config.notifyUrl) logger.warn("SHUTDOWN_NOTIFY_URL is not set: events are logged, nothing is sent");

    const monitor = new Monitor({
        directory: config.monitorPath,
        file: config.monitorFile,
        notifyDelayMs: config.notifyDelayMs,
        reminderMs: config.reminderMs,
        pollIntervalMs: config.pollIntervalMs,
        emit: (event) => notifier.notify(event),
    });
    monitor.start();

    // Stops watching and lets a delivery under way finish; the process ends with it.
    const shutdown = (signal: string) => {
        logger.info(`${signal} received, stopping`);
        monitor.stop();
    };
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));
}

main(process.argv.slice(2)).catch((err) => {
    logger.error((err as Error).message);
    process.exit(1);
});
