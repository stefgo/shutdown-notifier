import { RETRY_DELAYS_MS, wait } from "./delivery.js";
import { buildContext, type ShutdownEvent } from "./events.js";
import { logger } from "./logger.js";
import { MqttError, publishMqtt } from "./mqtt.js";
import { renderTemplate, renderTemplateText } from "./template.js";

export interface MqttDelivery {
    error: string | null;
    /** Whether a failed attempt is worth another one. */
    retryable: boolean;
}

export interface MqttRequest {
    topic: string;
    body: unknown;
}

export interface MqttNotifierOptions {
    url: string;
    /** May hold placeholders, filled in as text. */
    topic: string;
    clientId: string;
    username: string | null;
    password: string | null;
    qos: 0 | 1;
    retain: boolean;
    timeoutMs: number;
    /** The parsed payload template. */
    template: unknown;
    hostname: string;
    /** For tests. */
    retryDelaysMs?: number[];
    publish?: typeof publishMqtt;
}

/** Why a message cannot be published to a topic, or null. Wildcards are for subscribing only. */
export function topicError(topic: string): string | null {
    if (topic === "") return "The topic is empty";
    if (/[+#\0]/.test(topic)) return `"${topic}" is not a topic to publish to: it holds +, # or a NUL`;
    return null;
}

/** Renders the template for an event and publishes the result to the broker. */
export class MqttNotifier {
    /** Messages are published one after another, so the broker sees events in their order. */
    private tail: Promise<void> = Promise.resolve();

    constructor(private readonly options: MqttNotifierOptions) {}

    /** Renders one message. Throws on a template that does not compile -- start-up should have caught it. */
    render(event: ShutdownEvent): MqttRequest {
        const context = buildContext(event, this.options.hostname);
        return {
            topic: renderTemplateText(this.options.topic, context),
            body: renderTemplate(this.options.template, context),
        };
    }

    /** One attempt. */
    async send(request: MqttRequest): Promise<MqttDelivery> {
        const { url, clientId, username, password, timeoutMs, qos, retain } = this.options;
        try {
            await (this.options.publish ?? publishMqtt)(
                { url, clientId, username, password, timeoutMs },
                {
                    topic: request.topic,
                    // A template that is a single text is published as that text, without quotes.
                    payload: typeof request.body === "string" ? request.body : JSON.stringify(request.body),
                    qos,
                    retain,
                },
            );
            return { error: null, retryable: false };
        } catch (err) {
            return { error: (err as Error).message, retryable: err instanceof MqttError && err.retryable };
        }
    }

    /** Hands an event over and returns at once; the publishing, retries included, runs behind it. */
    notify(event: ShutdownEvent): void {
        this.tail = this.tail
            .then(() => this.deliver(event))
            .catch((err) => logger.error("MQTT publish threw", { reason: (err as Error).message }));
    }

    /** Resolves once every message handed over so far has been published or given up. */
    idle(): Promise<void> {
        return this.tail;
    }

    private async deliver(event: ShutdownEvent): Promise<void> {
        let request: MqttRequest;
        try {
            request = this.render(event);
        } catch (err) {
            logger.warn("MQTT message not published", {
                kind: event.kind,
                reason: `Template could not be rendered: ${(err as Error).message}`,
            });
            return;
        }
        const refused = topicError(request.topic);
        if (refused) {
            logger.warn("MQTT message not published", { kind: event.kind, reason: refused });
            return;
        }

        let delivery = await this.send(request);
        for (const delay of this.options.retryDelaysMs ?? RETRY_DELAYS_MS) {
            if (delivery.error === null || !delivery.retryable) break;
            await wait(delay);
            delivery = await this.send(request);
        }

        // Logged without the broker: its URL and the credentials stay out of the log.
        if (delivery.error !== null) {
            logger.warn("MQTT publish failed", { kind: event.kind, reason: delivery.error });
        } else {
            logger.info("MQTT message published", { kind: event.kind, topic: request.topic });
        }
    }
}
