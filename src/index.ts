import fs from "node:fs";
import { loadConfig, type Config } from "./config.js";
import { Notifier } from "./delivery.js";
import { EVENT_KINDS, parseEventKind, sampleEvent, type EventKind } from "./events.js";
import { logger } from "./logger.js";
import { Monitor } from "./monitor.js";
import { parseMqttUrl } from "./mqtt.js";
import { MqttNotifier, topicError } from "./mqttDelivery.js";
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
    const template = loadTemplate(config.httpTemplateFile);
    const urlError = placeholderError(config.httpUrl);
    if (urlError) throw new Error(`SHUTDOWN_HTTP_URL: ${urlError}`);
    const headerError = placeholderError(Object.values(config.httpHeaders));
    if (headerError) throw new Error(`SHUTDOWN_HTTP_HEADERS: ${headerError}`);
    return new Notifier({
        url: config.httpUrl,
        headers: config.httpHeaders,
        timeoutMs: config.httpTimeoutMs,
        template,
        hostname: config.hostname,
    });
}

/** Null without a broker: MQTT is a second way out, next to the HTTP URL. */
function createMqttNotifier(config: Config): MqttNotifier | null {
    if (!config.mqttUrl) return null;
    try {
        parseMqttUrl(config.mqttUrl);
    } catch (err) {
        throw new Error(`SHUTDOWN_MQTT_URL: ${(err as Error).message}`);
    }
    if (!config.mqttTemplateFile) {
        throw new Error("SHUTDOWN_MQTT_TEMPLATE_FILE: is not set -- with SHUTDOWN_MQTT_URL it names the payload template");
    }
    const topicPlaceholderError = placeholderError(config.mqttTopic);
    if (topicPlaceholderError) throw new Error(`SHUTDOWN_MQTT_TOPIC: ${topicPlaceholderError}`);
    return new MqttNotifier({
        url: config.mqttUrl,
        topic: config.mqttTopic,
        clientId: config.mqttClientId,
        username: config.mqttUsername,
        password: config.mqttPassword,
        qos: config.mqttQos,
        retain: config.mqttRetain,
        timeoutMs: config.mqttTimeoutMs,
        template: loadTemplate(config.mqttTemplateFile),
        hostname: config.hostname,
    });
}

/** The MQTT half of `--test`: prints the payload and publishes it once, without retries. */
async function testMqtt(mqtt: MqttNotifier, kind: EventKind): Promise<boolean> {
    const request = mqtt.render(sampleEvent(kind));
    console.log(JSON.stringify(request.body, null, 4));
    const refused = topicError(request.topic);
    const delivery = refused ? { error: refused } : await mqtt.send(request);
    if (delivery.error !== null) {
        console.error(`Not published: ${delivery.error}`);
        return false;
    }
    console.error(`Published to ${request.topic}`);
    return true;
}

/**
 * `--test [kind]`: renders a sample event, prints the body and -- with an HTTP URL -- sends
 * it once, without retries. What a template does is seen without scheduling a shutdown.
 * With a broker, `testMqtt` does the same for MQTT.
 */
async function test(notifier: Notifier, config: Config, kind: EventKind): Promise<boolean> {
    const request = notifier.render(sampleEvent(kind));
    console.log(JSON.stringify(request.body, null, 4));
    if (!config.httpUrl) {
        console.error("SHUTDOWN_HTTP_URL is not set: rendered only, nothing sent.");
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
    const mqtt = createMqttNotifier(config);

    const testAt = args.indexOf("--test");
    if (testAt >= 0) {
        const name = args[testAt + 1] ?? "scheduled";
        const kind = parseEventKind(name);
        if (!kind) throw new Error(`--test: "${name}" is not one of ${EVENT_KINDS.join(", ")}`);
        // Both are tried, also when the first one failed.
        const sent = await test(notifier, config, kind);
        const published = mqtt ? await testMqtt(mqtt, kind) : true;
        if (!sent || !published) process.exitCode = 1;
        return;
    }

    logger.info("Shutdown notifier started", {
        watching: `${config.monitorPath}/${config.monitorFile}`,
        template: config.httpTemplateFile,
        mqtt: mqtt ? config.mqttTopic : null,
        host: config.hostname,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    if (!config.httpUrl && !mqtt) {
        logger.warn("Neither SHUTDOWN_HTTP_URL nor SHUTDOWN_MQTT_URL is set: events are logged, nothing is sent");
    }

    const monitor = new Monitor({
        directory: config.monitorPath,
        file: config.monitorFile,
        notifyDelayMs: config.notifyDelayMs,
        reminderMs: config.reminderMs,
        pollIntervalMs: config.pollIntervalMs,
        emit: (event) => {
            notifier.notify(event);
            mqtt?.notify(event);
        },
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
