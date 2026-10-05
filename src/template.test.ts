import { describe, expect, it } from "vitest";
import {
    placeholderError,
    renderTemplate,
    renderTemplateText,
    templateError,
    type TemplateContext,
} from "./template.js";

// The engine's tests as kasm has them. The engine does not care what an event is, so they keep
// kasm's sample data -- nested objects and arrays, which a shutdown event has none of.
const EVENT = {
    id: "e1",
    kind: "vrrp.state_changed",
    level: "warning",
    subject: { instanceName: "VI_1", vrid: 51 },
    data: {
        from: "MASTER",
        to: "BACKUP",
        priority: 100,
        masters: ["lb-01", "lb-02"],
        members: [
            { host: "lb-01", state: "MASTER" },
            { host: "lb-02", state: "BACKUP" },
        ],
        none: [],
        zero: 0,
        empty: "",
        nothing: null,
    } as Record<string, unknown>,
};

const context = (over: Partial<typeof EVENT> = {}): TemplateContext => ({
    event: { ...EVENT, ...over },
    host: { name: "lb-01", site: "dc1" },
});

const render = (template: unknown, over: Partial<typeof EVENT> = {}) => renderTemplate(template, context(over));

describe("renderTemplate: placeholders", () => {
    it("puts the value itself where a string is nothing but one placeholder", () => {
        expect(render({ a: "{{event.data.priority}}", b: "{{event.subject}}", c: "{{event.data.masters}}" })).toEqual({
            a: 100,
            b: { instanceName: "VI_1", vrid: 51 },
            c: ["lb-01", "lb-02"],
        });
    });

    it("makes null of a value that is missing", () => {
        expect(render({ a: "{{event.data.nope}}", b: "{{event.data.nope.deeper}}" })).toEqual({ a: null, b: null });
    });

    it("writes a placeholder inside a longer string as text", () => {
        expect(render("p={{event.data.priority}} m={{event.data.masters}} x={{event.data.nope}}.")).toBe(
            'p=100 m=["lb-01","lb-02"] x=.',
        );
    });

    it("reaches into an array by index", () => {
        expect(render("{{event.data.members.1.host}}")).toBe("lb-02");
    });

    it("leaves a string without a placeholder, and anything that is not a string, as it is", () => {
        expect(render({ a: "plain { text }", b: 1, c: true, d: null, e: [1, "two"] })).toEqual({
            a: "plain { text }",
            b: 1,
            c: true,
            d: null,
            e: [1, "two"],
        });
    });

    it("fills a placeholder in a key", () => {
        expect(render({ "{{event.kind}}": 1 })).toEqual({ "vrrp.state_changed": 1 });
    });

    it("puts what an event carries in as a value: a quote or a brace cannot change the structure", () => {
        const hostile = { data: { error: '", "admin": true, "x": "{{event.id}}' } };
        expect(render({ text: "failed: {{event.data.error}}" }, hostile)).toEqual({
            text: 'failed: ", "admin": true, "x": "{{event.id}}',
        });
    });

    it("finds own properties only", () => {
        expect(render({ a: "{{event.constructor}}", b: "{{event.data.masters.join}}" })).toEqual({ a: null, b: null });
    });
});

describe("renderTemplate: filters", () => {
    it("default stands in for what is missing, null or empty", () => {
        expect(
            render([
                '{{event.data.nope | default("n/a")}}',
                "{{event.data.nothing | default('n/a')}}",
                "{{event.data.empty | default(0)}}",
                "{{event.data.from | default('n/a')}}",
                // Not missing: a zero is a value.
                "{{event.data.zero | default(7)}}",
            ]),
        ).toEqual(["n/a", "n/a", 0, "MASTER", 0]);
    });

    it("keeps a bar inside a quoted literal", () => {
        expect(render("{{event.data.nope | default('a|b') | upper}}")).toBe("A|B");
    });

    it("join turns an array into text, with a comma unless told otherwise", () => {
        expect(render(["{{event.data.masters | join}}", "{{event.data.masters | join(' / ')}}"])).toEqual([
            "lb-01, lb-02",
            "lb-01 / lb-02",
        ]);
    });

    it("map takes one field of every item, null where an item has none", () => {
        expect(render("{{event.data.members | map('host')}}")).toEqual(["lb-01", "lb-02"]);
        expect(render("{{event.data.members | map('nope')}}")).toEqual([null, null]);
        expect(render("{{event.data.members | map('state') | join | lower}}")).toBe("master, backup");
    });

    it("upper and lower change the case", () => {
        expect(render(["{{event.level | upper}}", "{{event.data.from | lower}}"])).toEqual(["WARNING", "master"]);
    });

    it("truncate keeps the first characters, and never half of one", () => {
        expect(render("{{event.id | truncate(1)}}")).toBe("e");
        expect(render("{{event.data.text | truncate(2)}}", { data: { text: "👍👍👍" } })).toBe("👍👍");
        expect(render("{{event.data.from | truncate(99)}}")).toBe("MASTER");
    });

    it("passes on a value of the wrong type unchanged", () => {
        expect(
            render([
                "{{event.data.priority | upper}}",
                "{{event.data.priority | truncate(1)}}",
                "{{event.data.from | join}}",
                "{{event.data.from | map('host')}}",
            ]),
        ).toEqual([100, 100, "MASTER", "MASTER"]);
    });
});

describe("renderTemplate: $if", () => {
    it("takes the branch its condition names", () => {
        const template = { $if: "event.data.from", then: "yes", else: "no" };
        expect(render(template)).toBe("yes");
        expect(render(template, { data: {} })).toBe("no");
    });

    it("is false for what is missing, null, empty, false, 0 or an empty array", () => {
        const truthy = (path: string) => render({ $if: path, then: true, else: false });
        for (const path of ["nope", "nothing", "empty", "zero", "none"]) {
            expect(truthy(`event.data.${path}`), path).toBe(false);
        }
        expect(truthy("event.data.masters")).toBe(true);
        expect(truthy("!event.data.none")).toBe(true);
    });

    it("compares with a literal", () => {
        const holds = (condition: string) => render({ $if: condition, then: true, else: false });
        expect(holds("event.level == 'warning'")).toBe(true);
        expect(holds('event.level == "error"')).toBe(false);
        expect(holds("event.level != 'error'")).toBe(true);
        expect(holds("event.data.priority == 100")).toBe(true);
        // Not the text "100".
        expect(holds("event.data.priority == '100'")).toBe(false);
        expect(holds("event.data.nope == null")).toBe(true);
        expect(holds('event.data.masters == ["lb-01", "lb-02"]')).toBe(true);
    });

    it("drops the key or the item of a branch that is left out", () => {
        expect(render({ a: 1, b: { $if: "event.data.nope", then: 2 } })).toEqual({ a: 1 });
        expect(render([1, { $if: "event.data.from", else: 2 }, 3])).toEqual([1, 3]);
    });

    it("is null at the top when its branch is left out", () => {
        expect(render({ $if: "event.data.nope", then: 1 })).toBeNull();
    });
});

describe("renderTemplate: $map and $join", () => {
    it("makes one item per element, with the item and its index in scope", () => {
        expect(render({ $map: "event.data.members", "each(m, i)": "{{i}}: {{m.host}} is {{m.state | lower}}" })).toEqual([
            "0: lb-01 is master",
            "1: lb-02 is backup",
        ]);
    });

    it("takes the array as a path or as a placeholder, filters included", () => {
        const each = { "each(h)": { host: "{{h}}" } };
        const expected = [{ host: "lb-01" }, { host: "lb-02" }];
        expect(render({ $map: "event.data.masters", ...each })).toEqual(expected);
        expect(render({ $map: "{{event.data.members | map('host')}}", ...each })).toEqual(expected);
    });

    it("keeps the context in reach inside the loop", () => {
        expect(render({ $map: "event.data.masters", "each(h)": "{{h}}@{{host.site}}" })).toEqual([
            "lb-01@dc1",
            "lb-02@dc1",
        ]);
    });

    it("is an empty array for anything but an array", () => {
        expect(render({ $map: "event.data.from", "each(m)": "{{m}}" })).toEqual([]);
        expect(render({ $map: "event.data.nope", "each(m)": "{{m}}" })).toEqual([]);
    });

    it("leaves out the items an $if inside it drops", () => {
        const template = { $map: "event.data.members", "each(m)": { $if: "m.state == 'MASTER'", then: "{{m.host}}" } };
        expect(render(template)).toEqual(["lb-01"]);
    });

    it("joins what it holds into text", () => {
        const lines = { $map: "event.data.members", "each(m)": "- {{m.host}}" };
        expect(render({ $join: lines, with: "\n" })).toBe("- lb-01\n- lb-02");
        expect(render({ $join: ["a", 1, null, { b: 2 }] })).toBe('a1{"b":2}');
    });

    it("passes on what is not an array", () => {
        expect(render({ $join: "{{event.data.from}}", with: ", " })).toBe("MASTER");
    });

    it("writes a key starting with $$ with one $ less", () => {
        expect(render({ $$if: "event.kind", $$other: 1 })).toEqual({ $if: "event.kind", $other: 1 });
    });
});

describe("renderTemplateText", () => {
    it("fills a URL or a header as text", () => {
        expect(renderTemplateText("https://example.org/{{host.site}}/{{event.data.priority}}?x={{event.data.nope}}", context())).toBe(
            "https://example.org/dc1/100?x=",
        );
    });
});

describe("templateError", () => {
    const error = (template: unknown) => templateError(JSON.stringify(template));

    it("refuses what is not JSON", () => {
        expect(templateError('{"text": ')).toMatch(/^Not valid JSON: /);
    });

    it("says where a placeholder with an unknown root sits", () => {
        expect(error({ blocks: [{ text: "{{foo.bar}}" }] })).toBe(
            'blocks[0].text: "{{foo.bar}}": a path starts with event, host',
        );
    });

    it("refuses a path that is none", () => {
        expect(error("{{event..kind}}")).toBe('"{{event..kind}}": "event..kind" is not a path');
        expect(error("{{event.data[0]}}")).toBe('"{{event.data[0]}}": "event.data[0]" is not a path');
    });

    it("names the filters there are when it meets one there is not", () => {
        expect(error("{{event.kind | shout}}")).toContain('"shout" is not a filter');
        expect(error("{{event.kind | upper(1)}}")).toContain("is not a filter");
    });

    it("refuses a filter argument of the wrong kind", () => {
        expect(error("{{event.kind | truncate(0)}}")).toContain("truncate(...) takes the number of characters");
        expect(error("{{event.kind | truncate}}")).toContain("truncate(...) takes the number of characters");
        expect(error("{{event.data.masters | join(1)}}")).toContain("join(...) takes the text");
        expect(error("{{event.data.members | map}}")).toContain("map(...) takes the name of a field");
        expect(error("{{event.kind | default(text)}}")).toContain("default(...) takes a JSON value");
    });

    it("refuses a condition that is none", () => {
        expect(error({ $if: "!event.kind == 'x'", then: 1 })).toContain("is not a condition");
        expect(error({ $if: "event.kind == text", then: 1 })).toContain('"text" is not a value');
        expect(error({ $if: 1, then: 1 })).toBe('"$if" takes a condition as text, such as "event.data.master"');
        expect(error({ $if: "nope.kind", then: 1 })).toContain("a path starts with event, host");
    });

    it("refuses an $if without a branch, or with a key it does not know", () => {
        expect(error({ $if: "event.kind" })).toBe('"$if" needs "then", "else" or both');
        expect(error({ $if: "event.kind", then: 1, otherwise: 2 })).toBe(
            '"$if" takes "then" and "else", not "otherwise"',
        );
    });

    it("refuses two directives in one object", () => {
        expect(error({ $if: "event.kind", then: 1, $join: [] })).toBe("$if and $join cannot share one object");
    });

    it("refuses a loop without exactly one well-formed each", () => {
        const map = (rest: Record<string, unknown>) => error({ $map: "event.data.members", ...rest });
        expect(map({})).toBe('"$map" needs exactly one "each(name)"');
        expect(map({ "each(a)": 1, "each(b)": 2 })).toBe('"$map" needs exactly one "each(name)"');
        expect(map({ each: 1 })).toBe('"each" is not "each(name)" or "each(name, index)"');
        expect(map({ "each(event)": 1 })).toBe('"each(event)": "event" is already in use');
        expect(map({ "each(m, m)": 1 })).toBe('"each(m, m)": item and index need two names');
        // No leading underscore, so `__proto__` cannot become a root.
        expect(map({ "each(__proto__)": 1 })).toBe('"each(__proto__)" is not "each(name)" or "each(name, index)"');
    });

    it("knows a loop variable inside its loop only, and not twice", () => {
        const inner = { $map: "event.data.members", "each(m)": "{{m.host}}" };
        expect(error([inner, "{{m.host}}"])).toBe('[1]: "{{m.host}}": a path starts with event, host');
        expect(error({ $map: "event.data.members", "each(m)": { $map: "m.vips", "each(m)": 1 } })).toContain(
            '"m" is already in use',
        );
    });

    it("caps how deep directives nest", () => {
        const nested = (depth: number): unknown => (depth === 0 ? [] : { $join: nested(depth - 1) });
        expect(error(nested(8))).toBeNull();
        expect(error(nested(9))).toContain("$if, $map and $join nest deeper than 8 levels");
    });

    it("caps how deep a template nests at all", () => {
        const nested = (depth: number): unknown => (depth === 0 ? 1 : [nested(depth - 1)]);
        expect(error(nested(64))).toBeNull();
        expect(error(nested(65))).toContain("nested deeper than 64 levels");
    });
});

describe("placeholderError", () => {
    it("checks a string, or every string of a list", () => {
        expect(placeholderError("https://example.org/{{host.site}}")).toBeNull();
        expect(placeholderError(["Bearer {{host.name}}", "{{nope}}"])).toBe(
            '"{{nope}}": a path starts with event, host',
        );
    });

    it("has nothing to say about what is not text", () => {
        expect(placeholderError(undefined)).toBeNull();
        expect(placeholderError([1, null])).toBeNull();
    });
});
