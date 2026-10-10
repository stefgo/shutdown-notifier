import { createTemplateEngine } from "@stefgo/js-template-engine";

/**
 * The JSON the notification sends, written by the operator.
 *
 * The language is the one of `@stefgo/js-template-engine`: `{{path}}` placeholders, filters,
 * `$if`, `$map` and `$join`, filled in on the parsed tree. Its README describes the grammar.
 * All that is decided here is what a path may start with.
 */

/** What a placeholder may start with. Anything else is a typo, and is refused at start-up. */
export const TEMPLATE_ROOTS = ["event", "host"] as const;

/** What a template is rendered with: one value per root. */
export type TemplateContext = Readonly<Record<(typeof TEMPLATE_ROOTS)[number], unknown>>;

export const {
    /** Fills a parsed template. Throws on a template that does not compile. */
    renderTemplate,
    /** Fills the placeholders of a string as text: for a URL or a header. */
    renderTemplateText,
    /**
     * Why a body template cannot be used, or null. Checked at start-up, so a broken template is
     * refused right away instead of failing on the first event, when nobody is looking.
     */
    templateError,
    /** Why strings with placeholders -- a URL, header values -- cannot be used, or null. */
    placeholderError,
} = createTemplateEngine({ roots: TEMPLATE_ROOTS });
