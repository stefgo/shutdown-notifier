import { describe, expect, it, vi } from "vitest";
import { sampleEvent } from "./events.js";
import { logger } from "./logger.js";
import { MqttError, type publishMqtt } from "./mqtt.js";
import { MqttNotifier, topicError, type MqttNotifierOptions } from "./mqttDelivery.js";

logger.setLevel("error");

const EVENT = sampleEvent("shutdown.scheduled", new Date("2026-10-05T20:00:00.000Z"));

/** A notifier whose broker fails with the errors listed, one per attempt, and then accepts. */
function setup(failures: Error[], over: Partial<MqttNotifierOptions> = {}) {
    const publishMock = vi.fn(async (..._args: Parameters<typeof publishMqtt>) => {
        const failure = failures.shift();
        if (failure) throw failure;
    });
    const notifier = new MqttNotifier({
        url: "mqtt://broker",
        topic: "shutdown/{{host.name}}/{{event.kind}}",
        clientId: "notifier",
        username: "u",
        password: "p",
        qos: 1,
        retain: true,
        timeoutMs: 1_000,
        template: { text: "{{event.title}}", seconds: "{{event.secondsUntil}}" },
        hostname: "zeus",
        retryDelaysMs: [0, 0],
        publish: publishMock,
        ...over,
    });
    return { notifier, publishMock };
}

describe("MqttNotifier", () => {
    it("renders the topic and the payload", () => {
        expect(setup([]).notifier.render(EVENT)).toEqual({
            topic: "shutdown/zeus/shutdown.scheduled",
            body: { text: "Shutdown scheduled", seconds: 600 },
        });
    });

    it("publishes the payload as JSON", async () => {
        const { notifier, publishMock } = setup([]);
        notifier.notify(EVENT);
        await notifier.idle();
        expect(publishMock).toHaveBeenCalledExactlyOnceWith(
            { url: "mqtt://broker", clientId: "notifier", username: "u", password: "p", timeoutMs: 1_000 },
            {
                topic: "shutdown/zeus/shutdown.scheduled",
                payload: '{"text":"Shutdown scheduled","seconds":600}',
                qos: 1,
                retain: true,
            },
        );
    });

    it("publishes a template that is a single text as that text", async () => {
        const { notifier, publishMock } = setup([], { template: "{{event.kind}}" });
        notifier.notify(EVENT);
        await notifier.idle();
        expect(publishMock.mock.calls[0][1].payload).toBe("shutdown.scheduled");
    });

    it("tries again when the broker could not be reached, and gives up after the third attempt", async () => {
        const once = setup([new MqttError("connect ECONNREFUSED", true)]);
        once.notifier.notify(EVENT);
        await once.notifier.idle();
        expect(once.publishMock).toHaveBeenCalledTimes(2);

        const always = setup([1, 2, 3, 4].map(() => new MqttError("connect ECONNREFUSED", true)));
        always.notifier.notify(EVENT);
        await always.notifier.idle();
        expect(always.publishMock).toHaveBeenCalledTimes(3);
    });

    it("does not try again what the broker refused", async () => {
        const { notifier, publishMock } = setup([new MqttError("not authorised", false)]);
        notifier.notify(EVENT);
        await notifier.idle();
        expect(publishMock).toHaveBeenCalledOnce();
    });

    it("reports an attempt with the reason it failed", async () => {
        const { notifier } = setup([new MqttError("not authorised", false)]);
        expect(await notifier.send(notifier.render(EVENT))).toEqual({ error: "not authorised", retryable: false });
        expect(await notifier.send(notifier.render(EVENT))).toEqual({ error: null, retryable: false });
    });

    it("publishes the events in their order", async () => {
        const { notifier, publishMock } = setup([new MqttError("busy", true)]);
        notifier.notify(EVENT);
        notifier.notify(sampleEvent("shutdown.cancelled"));
        await notifier.idle();
        expect(publishMock.mock.calls.map(([, message]) => message.topic)).toEqual([
            "shutdown/zeus/shutdown.scheduled",
            "shutdown/zeus/shutdown.scheduled",
            "shutdown/zeus/shutdown.cancelled",
        ]);
    });

    it("publishes nothing to a topic that is none", async () => {
        const { notifier, publishMock } = setup([], { hostname: "zeus/#" });
        notifier.notify(EVENT);
        await notifier.idle();
        expect(publishMock).not.toHaveBeenCalled();
    });
});

describe("topicError", () => {
    it("refuses an empty topic and one with a wildcard", () => {
        expect(topicError("shutdown/zeus")).toBeNull();
        expect(topicError("")).toMatch(/empty/);
        expect(topicError("shutdown/+")).toMatch(/not a topic to publish to/);
        expect(topicError("shutdown/#")).toMatch(/not a topic to publish to/);
    });
});
