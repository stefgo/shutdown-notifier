import { describe, expect, it } from "vitest";
import { placeholderError, renderTemplate, renderTemplateText, templateError } from "./template.js";

// The grammar is tested where it lives, in @stefgo/js-template-engine. What is decided here
// is what a path may start with.
const context = { event: { kind: "shutdown.scheduled", secondsUntil: 600 }, host: { name: "zeus" } };

describe("the roots of a template", () => {
    it("reads the event and the host", () => {
        expect(renderTemplate({ kind: "{{event.kind}}", in: "{{event.secondsUntil}}", on: "{{host.name}}" }, context)).toEqual({
            kind: "shutdown.scheduled",
            in: 600,
            on: "zeus",
        });
        expect(renderTemplateText("https://example.org/{{host.name}}/{{event.kind}}", context)).toBe(
            "https://example.org/zeus/shutdown.scheduled",
        );
    });

    it("refuses a path that starts with anything else", () => {
        expect(templateError('{"text": "{{client.name}}"}')).toBe(
            'text: "{{client.name}}": a path starts with event, host',
        );
        expect(placeholderError(["Bearer {{host.name}}", "{{webhook.name}}"])).toBe(
            '"{{webhook.name}}": a path starts with event, host',
        );
    });
});
