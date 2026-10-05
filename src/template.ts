/**
 * The JSON the notification sends, written by the operator.
 *
 * The engine is the one of the Keepalived Status Monitor (kasm, `shared/src/webhookTemplate.ts`),
 * taken over unchanged apart from the roots a path may start with, so a template written for
 * one reads the same for the other.
 *
 * A template is JSON with `{{path}}` placeholders, and it is filled in on the *parsed* tree,
 * never as text. What an event carries -- a wall message, a hostname -- is put into the tree
 * as a value, so a quote or a brace in it cannot break the JSON or smuggle in keys of its own,
 * and nothing in a template is ever executed.
 *
 * - A string that is nothing but one placeholder, `"{{event.secondsUntil}}"`, becomes the value
 *   itself, with its type: a number stays a number, an object an object, a missing value null.
 * - A placeholder inside a longer string is written as text: a missing value as "", an object
 *   as its JSON.
 * - Filters follow the path and can be chained: `default(<literal>)` stands in for a value that
 *   is missing, null or "", `join(", ")` turns an array into text, `map("host")` takes one
 *   field of every item, `upper` and `lower` change the case, `truncate(12)` keeps the first
 *   characters of a text. A filter handed a value of the wrong type passes it on unchanged --
 *   like a missing value, that never fails a delivery.
 *
 * Conditions and loops are JSON objects with a directive key, borrowed from JSON-e so the
 * template stays a data structure:
 *
 * - `{"$if": "<condition>", "then": …, "else": …}` -- a branch that is left out drops the key
 *   (in an object) or the item (in an array). A condition is `path`, `!path`,
 *   `path == <literal>` or `path != <literal>`; there is no expression language.
 * - `{"$map": "<path>", "each(m)": …}` or `"each(m, i)"` -- one item per element of the array,
 *   with `m` (and the index `i`) as further roots inside it. Anything but an array gives [].
 * - `{"$join": …, "with": "\n"}` -- renders what it holds and joins an array into text.
 * - A key starting with `$$` is written with one `$` less, for a target that wants `$if` itself.
 *
 * Loops only run over arrays the event carries, and nesting is capped, so a render always
 * ends. The template is compiled once into a tree that both the check at start-up and the
 * render use, so the two cannot disagree about the grammar.
 */

/** What a placeholder may start with. Anything else is a typo, and is refused at start-up. */
export const TEMPLATE_ROOTS = ["event", "host"] as const;

/** What a template is rendered with: one value per root. */
export type TemplateContext = Readonly<Record<(typeof TEMPLATE_ROOTS)[number], unknown>>;

// ── Placeholders ─────────────────────────────────────────────────────────────

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const WHOLE_PLACEHOLDER = /^\{\{([^{}]*)\}\}$/;
const SEGMENT = /^[A-Za-z_][A-Za-z0-9_-]*$|^\d+$/;
const FILTER_CALL = /^([a-z]+)\s*(?:\(([\s\S]*)\))?$/;
/** A loop variable. No leading underscore, so `__proto__` cannot become a root. */
const VARIABLE = /^[A-Za-z][A-Za-z0-9_]*$/;

type Filter =
    | { name: "default"; fallback: unknown }
    | { name: "join"; separator: string }
    | { name: "map"; field: string[] }
    | { name: "upper" }
    | { name: "lower" }
    | { name: "truncate"; length: number };

interface Expression {
    path: string[];
    filters: Filter[];
}

/** Splits at every bar outside a quoted literal: `default("a|b")` keeps its bar. */
function splitPipes(source: string): string[] {
    const parts: string[] = [];
    let start = 0;
    let quote: string | null = null;
    for (let i = 0; i < source.length; i++) {
        const c = source[i];
        if (quote) {
            if (c === "\\") i++;
            else if (c === quote) quote = null;
        } else if (c === '"' || c === "'") {
            quote = c;
        } else if (c === "|") {
            parts.push(source.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(source.slice(start));
    return parts.map((part) => part.trim());
}

/** A JSON value, or text in single quotes -- which saves escaping quotes inside the JSON template. */
function parseLiteral(text: string): unknown {
    const single = /^'([^']*)'$/.exec(text.trim());
    if (single) return single[1];
    return JSON.parse(text);
}

/**
 * `event.data.vrid` -> segments, checking that the first one is a root in scope. `label` says
 * in the message what the path was part of, such as `"{{event.x}}"`.
 */
function parsePath(text: string, roots: readonly string[], label: string): string[] {
    const path = text.split(".");
    if (!path.every((segment) => SEGMENT.test(segment))) {
        throw new Error(`${label}: "${text}" is not a path`);
    }
    if (!roots.includes(path[0])) {
        throw new Error(`${label}: a path starts with ${roots.join(", ")}`);
    }
    return path;
}

function parseFilter(text: string, source: string): Filter {
    const call = FILTER_CALL.exec(text);
    const name = call?.[1];
    const arg = call?.[2];
    const literal = (what: string): unknown => {
        try {
            return parseLiteral(arg ?? "");
        } catch {
            throw new Error(`"{{${source}}}": ${name}(...) takes ${what}`);
        }
    };
    switch (name) {
        case "default":
            return { name, fallback: literal(`a JSON value, such as "text" or 0`) };
        case "join": {
            if (arg === undefined) return { name, separator: ", " };
            const separator = literal("the text to put between the items");
            if (typeof separator !== "string") {
                throw new Error(`"{{${source}}}": join(...) takes the text to put between the items`);
            }
            return { name, separator };
        }
        case "map": {
            const field = arg === undefined ? undefined : literal("the name of a field, such as \"host\"");
            if (typeof field !== "string" || !field.split(".").every((s) => SEGMENT.test(s))) {
                throw new Error(`"{{${source}}}": map(...) takes the name of a field, such as "host"`);
            }
            return { name, field: field.split(".") };
        }
        case "upper":
        case "lower":
            if (arg !== undefined) break;
            return { name };
        case "truncate": {
            const length = arg === undefined ? undefined : literal("the number of characters to keep, such as 12");
            if (typeof length !== "number" || !Number.isInteger(length) || length < 1) {
                throw new Error(`"{{${source}}}": truncate(...) takes the number of characters to keep, such as 12`);
            }
            return { name, length };
        }
    }
    throw new Error(
        `"{{${source}}}": "${text}" is not a filter -- there are default(…), join(…), map(…), truncate(…), upper and lower`,
    );
}

/** Parses what stands between the braces. Throws with a message meant for the operator. */
function parseExpression(source: string, roots: readonly string[]): Expression {
    const [pathPart, ...filterParts] = splitPipes(source);
    return {
        path: parsePath(pathPart, roots, `"{{${source}}}"`),
        filters: filterParts.map((part) => parseFilter(part, source)),
    };
}

/** Walks own properties only, so `{{event.constructor}}` finds nothing. */
function lookup(value: unknown, path: readonly string[]): unknown {
    for (const segment of path) {
        if (value === null || typeof value !== "object") return undefined;
        if (!Object.prototype.hasOwnProperty.call(value, segment)) return undefined;
        value = (value as Record<string, unknown>)[segment];
    }
    return value;
}

function isMissing(value: unknown): boolean {
    return value === undefined || value === null || value === "";
}

function applyFilter(value: unknown, filter: Filter): unknown {
    switch (filter.name) {
        case "default":
            return isMissing(value) ? filter.fallback : value;
        case "join":
            return Array.isArray(value) ? value.map(asText).join(filter.separator) : value;
        case "map":
            return Array.isArray(value) ? value.map((item) => lookup(item, filter.field) ?? null) : value;
        case "upper":
            return typeof value === "string" ? value.toUpperCase() : value;
        case "lower":
            return typeof value === "string" ? value.toLowerCase() : value;
        case "truncate":
            // By character, not by UTF-16 unit: a cut must not leave half an emoji behind.
            return typeof value === "string" ? Array.from(value).slice(0, filter.length).join("") : value;
    }
}

/** The context, plus whatever loop variables are in scope. */
type Scope = Readonly<Record<string, unknown>>;

function resolve(scope: Scope, expression: Expression): unknown {
    return expression.filters.reduce(applyFilter, lookup(scope, expression.path));
}

function asText(value: unknown): string {
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return JSON.stringify(value);
}

// ── Conditions ───────────────────────────────────────────────────────────────

const CONDITION = /^(!?)\s*([^\s=!]+)\s*(?:(==|!=)\s*([\s\S]+))?$/;

interface Condition {
    path: string[];
    negate: boolean;
    /** Present only for `==` and `!=`. */
    compare?: { equal: boolean; literal: unknown };
}

function parseCondition(source: string, roots: readonly string[]): Condition {
    const match = CONDITION.exec(source.trim());
    if (!match || (match[1] && match[3])) {
        throw new Error(
            `"$if": "${source}" is not a condition -- write path, !path, path == 'text' or path != 'text'`,
        );
    }
    const path = parsePath(match[2], roots, `"$if": "${source}"`);
    if (!match[3]) return { path, negate: match[1] === "!" };
    let literal: unknown;
    try {
        literal = parseLiteral(match[4]);
    } catch {
        throw new Error(`"$if": "${match[4].trim()}" is not a value -- write 'text', "text", 0, true or null`);
    }
    return { path, negate: false, compare: { equal: match[3] === "==", literal } };
}

/** False for what is missing, null, "", false, 0 or an empty array. */
function isTruthy(value: unknown): boolean {
    if (Array.isArray(value)) return value.length > 0;
    return !isMissing(value) && value !== false && value !== 0;
}

function test(condition: Condition, scope: Scope): boolean {
    const value = lookup(scope, condition.path);
    if (!condition.compare) return isTruthy(value) !== condition.negate;
    const { equal, literal } = condition.compare;
    const same =
        literal !== null && typeof literal === "object"
            ? JSON.stringify(value) === JSON.stringify(literal)
            : (value ?? null) === literal;
    return same === equal;
}

// ── Compiling ────────────────────────────────────────────────────────────────

/** How deep `$if`, `$map` and `$join` may nest in each other. */
const MAX_DIRECTIVE_DEPTH = 8;
/** How deep a template may nest at all -- beyond this a recursive walk risks the stack. */
const MAX_DEPTH = 64;

const DIRECTIVES = ["$if", "$map", "$join"] as const;
const EACH = /^each\(\s*([^,\s)]+)\s*(?:,\s*([^,\s)]+)\s*)?\)$/;

type Part = string | Expression;

type TemplateNode =
    | { type: "literal"; value: unknown }
    | { type: "value"; expression: Expression }
    | { type: "text"; parts: Part[] }
    | { type: "array"; items: TemplateNode[] }
    | { type: "object"; entries: { key: Part[]; value: TemplateNode }[] }
    | { type: "if"; condition: Condition; then?: TemplateNode; else?: TemplateNode }
    | { type: "map"; source: Expression; item: string; index?: string; each: TemplateNode }
    | { type: "join"; inner: TemplateNode; separator: string };

interface Where {
    /** Where the node sits, such as `content.$join`; "" at the top. */
    location: string;
    roots: readonly string[];
    depth: number;
    directives: number;
}

/** An error that already says where it happened, so no enclosing node prefixes it again. */
function locatedError(location: string, message: string): Error {
    return Object.assign(new Error(location ? `${location}: ${message}` : message), { located: true });
}

function inside(where: Where, step: string, directive = false): Where {
    const location = where.location && !step.startsWith("[") ? `${where.location}.${step}` : where.location + step;
    if (where.depth + 1 > MAX_DEPTH) throw locatedError(location, `nested deeper than ${MAX_DEPTH} levels`);
    if (directive && where.directives + 1 > MAX_DIRECTIVE_DEPTH) {
        throw locatedError(location, `$if, $map and $join nest deeper than ${MAX_DIRECTIVE_DEPTH} levels`);
    }
    return { ...where, location, depth: where.depth + 1, directives: where.directives + (directive ? 1 : 0) };
}

function compileText(text: string, roots: readonly string[]): Part[] {
    const parts: Part[] = [];
    let last = 0;
    for (const match of text.matchAll(PLACEHOLDER)) {
        if (match.index > last) parts.push(text.slice(last, match.index));
        parts.push(parseExpression(match[1], roots));
        last = match.index + match[0].length;
    }
    if (last < text.length) parts.push(text.slice(last));
    return parts;
}

function compile(template: unknown, where: Where): TemplateNode {
    try {
        return compileNode(template, where);
    } catch (e) {
        // Say where, once: the innermost node that failed prefixes its location.
        if ((e as { located?: boolean }).located) throw e;
        throw locatedError(where.location, (e as Error).message);
    }
}

function compileNode(template: unknown, where: Where): TemplateNode {
    if (typeof template === "string") {
        const whole = WHOLE_PLACEHOLDER.exec(template);
        if (whole) return { type: "value", expression: parseExpression(whole[1], where.roots) };
        const parts = compileText(template, where.roots);
        return parts.every((part) => typeof part === "string")
            ? { type: "literal", value: template }
            : { type: "text", parts };
    }
    if (Array.isArray(template)) {
        return { type: "array", items: template.map((item, i) => compile(item, inside(where, `[${i}]`))) };
    }
    if (template === null || typeof template !== "object") return { type: "literal", value: template };

    const object = template as Record<string, unknown>;
    const found = DIRECTIVES.filter((name) => Object.prototype.hasOwnProperty.call(object, name));
    if (found.length > 1) throw new Error(`${found.join(" and ")} cannot share one object`);
    if (found.length === 1) return compileDirective(found[0], object, where);

    return {
        type: "object",
        entries: Object.entries(object).map(([key, value]) => ({
            // `$$if` is written as `$if`: the way to send a key that would otherwise be a directive.
            key: compileText(key.startsWith("$$") ? key.slice(1) : key, where.roots),
            value: compile(value, inside(where, key)),
        })),
    };
}

function onlyKeys(object: Record<string, unknown>, directive: string, allowed: string[]): void {
    const extra = Object.keys(object).filter((key) => key !== directive && !allowed.includes(key));
    if (extra.length > 0) {
        throw new Error(`"${directive}" takes ${allowed.map((k) => `"${k}"`).join(" and ")}, not "${extra[0]}"`);
    }
}

/** `"{{event.data.members}}"` and `"event.data.members"` both name the array to loop over. */
function unwrap(source: string): string {
    const whole = WHOLE_PLACEHOLDER.exec(source.trim());
    return whole ? whole[1] : source;
}

function compileDirective(
    directive: (typeof DIRECTIVES)[number],
    object: Record<string, unknown>,
    where: Where,
): TemplateNode {
    const value = object[directive];
    const here = inside(where, directive, true);

    if (directive === "$if") {
        onlyKeys(object, directive, ["then", "else"]);
        if (typeof value !== "string") throw new Error(`"$if" takes a condition as text, such as "event.data.master"`);
        if (!("then" in object) && !("else" in object)) throw new Error(`"$if" needs "then", "else" or both`);
        return {
            type: "if",
            condition: parseCondition(value, where.roots),
            then: "then" in object ? compile(object.then, inside(here, "then")) : undefined,
            else: "else" in object ? compile(object.else, inside(here, "else")) : undefined,
        };
    }

    if (directive === "$map") {
        const eachKeys = Object.keys(object).filter((key) => key.startsWith("each"));
        if (eachKeys.length !== 1) throw new Error(`"$map" needs exactly one "each(name)"`);
        onlyKeys(object, directive, eachKeys);
        if (typeof value !== "string") throw new Error(`"$map" takes the path of an array, such as "event.data.members"`);
        const each = EACH.exec(eachKeys[0]);
        const names = each ? [each[1], each[2]].filter((name) => name !== undefined) : [];
        if (!each || !names.every((name) => VARIABLE.test(name))) {
            throw new Error(`"${eachKeys[0]}" is not "each(name)" or "each(name, index)"`);
        }
        const taken = names.find((name) => where.roots.includes(name));
        if (taken) throw new Error(`"${eachKeys[0]}": "${taken}" is already in use`);
        if (names[0] === names[1]) throw new Error(`"${eachKeys[0]}": item and index need two names`);
        return {
            type: "map",
            source: parseExpression(unwrap(value), where.roots),
            item: names[0],
            index: names[1],
            each: compile(object[eachKeys[0]], { ...inside(here, eachKeys[0]), roots: [...where.roots, ...names] }),
        };
    }

    onlyKeys(object, directive, ["with"]);
    const separator = object.with ?? "";
    if (typeof separator !== "string") throw new Error(`"with" takes the text to put between the items`);
    return { type: "join", inner: compile(value, here), separator };
}

/** Parses and checks a body template. Throws with a message meant for the operator. */
function compileTemplate(template: unknown): TemplateNode {
    return compile(template, { location: "", roots: TEMPLATE_ROOTS, depth: 0, directives: 0 });
}

// ── Rendering ────────────────────────────────────────────────────────────────

/** A `$if` without the branch it took: the key or the item it stood for is left out. */
const OMIT = Symbol("omit");

function renderParts(parts: Part[], scope: Scope): string {
    return parts.map((part) => (typeof part === "string" ? part : asText(resolve(scope, part)))).join("");
}

function evaluate(node: TemplateNode, scope: Scope): unknown {
    switch (node.type) {
        case "literal":
            return node.value;
        case "value":
            return resolve(scope, node.expression) ?? null;
        case "text":
            return renderParts(node.parts, scope);
        case "array":
            return node.items.map((item) => evaluate(item, scope)).filter((item) => item !== OMIT);
        case "object": {
            const result: Record<string, unknown> = {};
            for (const entry of node.entries) {
                const value = evaluate(entry.value, scope);
                if (value !== OMIT) result[renderParts(entry.key, scope)] = value;
            }
            return result;
        }
        case "if": {
            const branch = test(node.condition, scope) ? node.then : node.else;
            return branch ? evaluate(branch, scope) : OMIT;
        }
        case "map": {
            const source = resolve(scope, node.source);
            if (!Array.isArray(source)) return [];
            return source
                .map((item, i) => {
                    const inner: Record<string, unknown> = { ...scope, [node.item]: item };
                    if (node.index) inner[node.index] = i;
                    return evaluate(node.each, inner);
                })
                .filter((item) => item !== OMIT);
        }
        case "join": {
            const value = evaluate(node.inner, scope);
            return Array.isArray(value) ? value.map(asText).join(node.separator) : value;
        }
    }
}

/** Fills the placeholders of a string as text: for a URL or a header. */
export function renderTemplateText(text: string, context: TemplateContext): string {
    return renderParts(compileText(text, TEMPLATE_ROOTS), context as unknown as Scope);
}

/** Fills a parsed template. Throws on a template that does not compile. */
export function renderTemplate(template: unknown, context: TemplateContext): unknown {
    const result = evaluate(compileTemplate(template), context as unknown as Scope);
    return result === OMIT ? null : result;
}

/**
 * Why a body template cannot be used, or null. Checked at start-up, so a broken template is
 * refused right away instead of failing on the first event, when nobody is looking.
 */
export function templateError(source: string): string | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(source);
    } catch (e) {
        return `Not valid JSON: ${(e as Error).message}`;
    }
    try {
        compileTemplate(parsed);
        return null;
    } catch (e) {
        return (e as Error).message;
    }
}

/** Why strings with placeholders -- a URL, header values -- cannot be used, or null. */
export function placeholderError(node: unknown): string | null {
    try {
        for (const text of Array.isArray(node) ? node : [node]) {
            if (typeof text === "string") compileText(text, TEMPLATE_ROOTS);
        }
        return null;
    } catch (e) {
        return (e as Error).message;
    }
}
