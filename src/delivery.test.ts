import { describe, expect, it, vi } from "vitest";
import { Notifier, type NotifierOptions } from "./delivery.js";
import { sampleEvent } from "./events.js";
import { logger } from "./logger.js";

logger.setLevel("error");

const EVENT = sampleEvent("shutdown.scheduled", new Date("2026-10-05T20:00:00.000Z"));

type Answer = Response | Error;

/** A notifier whose target gives the answers listed, one per attempt. */
function setup(answers: Answer[], over: Partial<NotifierOptions> = {}) {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => {
        const answer = answers.shift() ?? new Response(null, { status: 204 });
        if (answer instanceof Error) throw answer;
        return answer;
    });
    const notifier = new Notifier({
        url: "https://example.org/hook/{{host.name}}",
        headers: { "X-Token": "t-{{event.kind}}" },
        timeoutMs: 1_000,
        template: { text: "{{event.title}}", seconds: "{{event.secondsUntil}}" },
        hostname: "zeus",
        retryDelaysMs: [0, 0],
        fetch: fetchMock as unknown as typeof fetch,
        ...over,
    });
    return { notifier, fetchMock };
}

describe("Notifier", () => {
    it("renders the URL, the headers and the body", () => {
        expect(setup([]).notifier.render(EVENT)).toEqual({
            url: "https://example.org/hook/zeus",
            headers: { "content-type": "application/json", "x-token": "t-shutdown.scheduled" },
            body: { text: "Shutdown scheduled", seconds: 600 },
        });
    });

    it("posts the body as JSON", async () => {
        const { notifier, fetchMock } = setup([]);
        notifier.notify(EVENT);
        await notifier.idle();
        expect(fetchMock).toHaveBeenCalledOnce();
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe("https://example.org/hook/zeus");
        expect(init).toMatchObject({ method: "POST", body: '{"text":"Shutdown scheduled","seconds":600}' });
    });

    it("tries again when nothing answers, the target fails or asks to slow down", async () => {
        const { notifier, fetchMock } = setup([new Error("connect ECONNREFUSED"), new Response("busy", { status: 503 })]);
        notifier.notify(EVENT);
        await notifier.idle();
        expect(fetchMock).toHaveBeenCalledTimes(3);

        const slow = setup([new Response(null, { status: 429 })]);
        slow.notifier.notify(EVENT);
        await slow.notifier.idle();
        expect(slow.fetchMock).toHaveBeenCalledTimes(2);
    });

    it("gives up after the third attempt", async () => {
        const { notifier, fetchMock } = setup([500, 500, 500, 500].map((status) => new Response(null, { status })));
        notifier.notify(EVENT);
        await notifier.idle();
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("does not try again what the target refused", async () => {
        const { notifier, fetchMock } = setup([new Response("bad request", { status: 400 })]);
        notifier.notify(EVENT);
        await notifier.idle();
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("reports an attempt with the status and the start of the answer", async () => {
        const { notifier } = setup([new Response("x".repeat(600), { status: 400, statusText: "Bad Request" })]);
        const delivery = await notifier.send(notifier.render(EVENT));
        expect(delivery).toMatchObject({ status: 400, error: "HTTP 400 Bad Request" });
        expect(delivery.response).toHaveLength(500);
    });

    it("sends the events in their order", async () => {
        const { notifier, fetchMock } = setup([new Response(null, { status: 500 })], {
            template: "{{event.kind}}",
        });
        notifier.notify(EVENT);
        notifier.notify(sampleEvent("shutdown.cancelled"));
        await notifier.idle();
        expect(fetchMock.mock.calls.map(([, init]) => init?.body)).toEqual([
            '"shutdown.scheduled"',
            '"shutdown.scheduled"',
            '"shutdown.cancelled"',
        ]);
    });

    it("sends nothing without a URL", async () => {
        const { notifier, fetchMock } = setup([], { url: null });
        notifier.notify(EVENT);
        await notifier.idle();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
