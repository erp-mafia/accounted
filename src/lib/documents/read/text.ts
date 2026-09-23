import type { ReadPage } from './types'

/** Plain text and HTML bodies (mail underlag). HTML is reduced to its text. */
export function readTextDocument(bytes: Buffer, mimeType: string): ReadPage[] {
  const raw = bytes.toString('utf8')
  const isHtml = mimeType === 'text/html' || mimeType === 'application/xhtml+xml'
  const text = (isHtml ? htmlToText(raw) : raw).trim()
  if (!text) return []
  return [{ pageNo: 1, text, reader: isHtml ? 'html' : 'text', hasTextLayer: true }]
}

/** Named entities common in Swedish business mail; any other entity stays as written. */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  aring: 'å',
  auml: 'ä',
  ouml: 'ö',
  Aring: 'Å',
  Auml: 'Ä',
  Ouml: 'Ö',
  eacute: 'é',
  Eacute: 'É',
}

/**
 * The words of an HTML body as plain text, for search and model reading; the
 * result is never rendered as HTML. Script and style bodies and comments are
 * dropped whatever their end tags look like, block ends become line breaks,
 * and entities are decoded in one pass so an escaped ampersand is never
 * decoded twice.
 */
export function htmlToText(html: string): string {
  const withoutTags = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script[^>]*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style[^>]*>/gi, ' ')
    .replace(/<!--[\s\S]*?--!?>/g, ' ')
    .replace(/<br\b[^>]*>|<\/(?:p|div|li|tr|h[1-6]|table|section|article)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
  return decodeEntities(withoutTags)
    .replace(/[ \t ]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function decodeEntities(text: string): string {
  return text.replace(
    /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));/g,
    (entity: string, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (name) return NAMED_ENTITIES[name] ?? entity
      const code = decimal ? Number(decimal) : parseInt(hex ?? '', 16)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity
    },
  )
}
