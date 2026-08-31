import { inflateSync } from 'node:zlib'

/**
 * Text a rendered @react-pdf/renderer document actually carries, as one
 * string per page content stream (test helper).
 *
 * Standard-font text is written as WinAnsi bytes inside `[...] TJ` / `(...) Tj`
 * operators. Inflating the streams and decoding those operands byte-for-byte
 * shows what a viewer will draw, which is the only way to prove a glyph made
 * it into the file: a character with no glyph in the font (U+2212 in
 * Helvetica, issue #1982) survives as an unmapped control byte and is drawn
 * as nothing. Thousands separators come back as U+00A0 and are normalised to
 * a plain space so assertions can use "4 684".
 */
export function pdfTextStrings(pdf: Buffer): string[] {
  const raw = pdf.toString('latin1')
  const out: string[] = []
  const streamRe = /stream\r?\n/g
  let match: RegExpExecArray | null
  while ((match = streamRe.exec(raw)) !== null) {
    const start = match.index + match[0].length
    const end = raw.indexOf('endstream', start)
    if (end === -1) continue
    const bytes = Buffer.from(raw.slice(start, end), 'latin1')
    let content: string
    try {
      content = inflateSync(bytes).toString('latin1')
    } catch {
      content = bytes.toString('latin1')
    }
    // Only page content streams carry text objects; embedded font programs
    // and images are binary and would produce false hex/paren matches.
    if (!/\bBT\b[\s\S]*\bET\b/.test(content)) continue
    const parts: string[] = []
    const opRe = /<([0-9a-fA-F]+)>|\(((?:\\.|[^\\)])*)\)/g
    let op: RegExpExecArray | null
    while ((op = opRe.exec(content)) !== null) {
      if (op[1] !== undefined) {
        parts.push(Buffer.from(op[1], 'hex').toString('latin1'))
      } else {
        parts.push(op[2].replace(/\\([()\\])/g, '$1'))
      }
    }
    if (parts.length > 0) out.push(parts.join('').replaceAll(' ', ' '))
  }
  return out
}
