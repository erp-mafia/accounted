/**
 * Minimal XML/XHTML emission helpers for the iXBRL generator.
 *
 * Open decision #3 in the implementation plan (React renderToStaticMarkup vs
 * dedicated builder) is resolved in favour of a dedicated builder: TA §3.2
 * requires *valid XHTML* with only the five XML escape entities, and React's
 * HTML serializer makes no such guarantee (named entities, void-element
 * forms, attribute quirks). A hand-rolled escaper keeps the output auditable
 * byte-for-byte against the official examples.
 */

/** Escape text content using only the five XML entities (TA §3.2.4). */
export function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Escape an attribute value (double-quoted attributes). */
export function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export type Attrs = Record<string, string | number | null | undefined>

export function attrString(attrs: Attrs): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue
    parts.push(`${key}="${escapeAttr(String(value))}"`)
  }
  return parts.length > 0 ? ' ' + parts.join(' ') : ''
}

export function el(tag: string, attrs: Attrs, children: string): string {
  return `<${tag}${attrString(attrs)}>${children}</${tag}>`
}

export function selfClosing(tag: string, attrs: Attrs): string {
  return `<${tag}${attrString(attrs)}/>`
}

/**
 * Turn user-authored multi-line text into XHTML paragraphs. Blank lines split
 * paragraphs; single newlines become <br/>. All content is escaped.
 */
export function paragraphs(text: string, className?: string): string {
  const classAttr = className ? ` class="${escapeAttr(className)}"` : ''
  return text
    .split(/\r?\n\s*\r?\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map(
      (block) =>
        `<p${classAttr}>${block
          .split(/\r?\n/)
          .map((line) => escapeText(line))
          .join('<br/>')}</p>`,
    )
    .join('\n')
}

/**
 * Format a whole-SEK amount for ixt:numspacecomma: groups of three digits
 * separated by REGULAR spaces (U+0020; NBSP fails the transform regex).
 * The sign is never part of the transformed text: negative handling lives
 * on the ix:nonFraction `sign` attribute / presentational minus outside.
 */
export function formatSekAbs(value: number): string {
  const abs = Math.abs(Math.round(value))
  return abs.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

/** Percent with one decimal for ixt:numspacecomma ("35,5"). */
export function formatPercentAbs(value: number): string {
  const abs = Math.abs(value)
  return abs.toFixed(1).replace('.', ',')
}
