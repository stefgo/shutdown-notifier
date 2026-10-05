import { buildContext, type ShutdownEvent } from "./events.js";
import { logger } from "./logger.js";
import { renderTemplate, renderTemplateText } from "./template.js";

/** The waits before the second and the third attempt. */
const RETRY_DELAYS_MS = [1_000, 5_000];

/** How much of a target's answer is kept, to show why it refused. */
const RESPONSE_PREVIEW_CHARS = 500;

export interface Delivery {
    status: number | null;
    error: string | null;
    response: string | null;
}

export interface NotifyRequest {
    url: string;
    headers: Record<string, string>;
    body: unknown;
}

export interface NotifierOptions {
    /** Null renders and logs, but sends nothing. */
    url: string | null;
    headers: Record<string, string>;
    timeoutMs: number;
    /** The parsed body template. */
    template: unknown;
    hostname: string;
    /** For tests. */
    retryDelaysMs?: number[];
    fetch?: typeof fetch;
}

/** Worth another try: nothing answered, the target failed, or it asked to slow down. */
function retryable(delivery: Delivery): boolean {
    return delivery.status === null || delivery.status >= 500 || delivery.status === 429;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Renders the template for an event and posts the result to the target. */
export class Notifier {
    /** Deliveries run one after another, so the target sees events in their order. */
    private tail: Promise<void> = Promise.resolve();

    constructor(private readonly options: NotifierOptions) {}

    /** Renders one delivery. Throws on a template that does not compile -- start-up should have caught it. */
    render(event: ShutdownEvent): NotifyRequest {
        const context = buildContext(event, this.options.hostname);
        const headers: Record<string, string> = { "content-type": "application/json" };
        for (const [name, value] of Object.entries(this.options.headers)) {
            headers[name.toLowerCase()] = renderTemplateText(value, context);
        }
        return {
            url: renderTemplateText(this.options.url ?? "", context),
            headers,
            body: renderTemplate(this.options.template, context),
        };
    }

    /** One attempt. */
    async send(request: NotifyRequest): Promise<Delivery> {
        try {
            const response = await (this.options.fetch ?? fetch)(request.url, {
                method: "POST",
                headers: request.headers,
                body: JSON.stringify(request.body),
                signal: AbortSignal.timeout(this.options.timeoutMs),
            });
            const text = (await response.text().catch(() => "")).slice(0, RESPONSE_PREVIEW_CHARS);
            return {
                status: response.status,
                error: response.ok ? null : `HTTP ${response.status} ${response.statusText}`.trim(),
                response: text || null,
            };
        } catch (err) {
            const error = err as Error;
            // undici hides the actual cause one level down, and a refused connection to a name
            // with several addresses is an AggregateError whose own message is empty.
            const cause = error.cause as (Error & { code?: string; errors?: Error[] }) | undefined;
            const message =
                error.name === "TimeoutError"
                    ? `No answer within ${this.options.timeoutMs} ms`
                    : cause?.message || cause?.errors?.[0]?.message || cause?.code || error.message;
            return { status: null, error: message, response: null };
        }
    }

    /** Hands an event over and returns at once; the delivery, retries included, runs behind it. */
    notify(event: ShutdownEvent): void {
        this.tail = this.tail
            .then(() => this.deliver(event))
            .catch((err) => logger.error("Notification threw", { reason: (err as Error).message }));
    }

    /** Resolves once every delivery handed over so far has ended. */
    idle(): Promise<void> {
        return this.tail;
    }

    private async deliver(event: ShutdownEvent): Promise<void> {
        if (!this.options.url) {
            logger.debug("No notify URL, nothing sent", { kind: event.kind });
            return;
        }
        let request: NotifyRequest;
        try {
            request = this.render(event);
        } catch (err) {
            logger.warn("Notification not sent", {
                kind: event.kind,
                reason: `Template could not be rendered: ${(err as Error).message}`,
            });
            return;
        }

        let delivery = await this.send(request);
        for (const delay of this.options.retryDelaysMs ?? RETRY_DELAYS_MS) {
            if (delivery.error === null || !retryable(delivery)) break;
            await wait(delay);
            delivery = await this.send(request);
        }

        // Logged without the request: its URL and headers are where a token would be.
        if (delivery.error !== null) {
            logger.warn("Notification failed", {
                kind: event.kind,
                reason: delivery.error,
                response: delivery.response,
            });
        } else {
            logger.info("Notification sent", { kind: event.kind, status: delivery.status });
        }
    }
}
