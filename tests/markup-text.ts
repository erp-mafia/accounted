/**
 * The text of rendered markup, for a test that reads what a page says.
 *
 * Tags are passed over without a pattern that matches a tag: the markup is
 * split on '<', and of each part what follows its first '>' is text. A
 * replace that strips tags by a pattern is what the security scan reports
 * as "Incomplete multi-character sanitization", in a test file too.
 *
 * The markup is what React rendered in the test, so a '<' always opens a
 * tag: text that holds one carries it as an entity.
 */

/** Every piece of text in the markup, in order, with whitespace collapsed and empty pieces left out. */
export function markupTexts(html: string): string[] {
  return html
    .split('<')
    .map((part, index) => (index === 0 ? part : part.slice(part.indexOf('>') + 1)))
    .map((text) => text.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

/** The markup's text as one line: its pieces joined by `separator`. */
export function markupText(html: string, separator = ' '): string {
  return markupTexts(html).join(separator)
}
