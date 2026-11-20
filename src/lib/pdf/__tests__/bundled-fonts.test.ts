/**
 * The bundled fonts keep every letter across documents (../bundled-fonts.ts,
 * warmGlyphCache). fontkit caches one glyph object per glyph id; embedding a
 * document that used Å or Ö (composites of A and O) used to create the
 * plain A and O glyphs without their characters, and the next document in
 * the same process then drew "Ordförande" as "rdförande".
 */
import { createElement as h } from 'react'
import { describe, expect, it } from 'vitest'
import { Document, Page, Text, renderToBuffer } from '@react-pdf/renderer'
import { registerBundledFont } from '../bundled-fonts'

async function render(lines: string[], fontFamily: string, fontWeight = 400): Promise<string> {
  const doc = h(Document, null, h(Page, { size: 'A4', style: { fontFamily, fontWeight, padding: 40 } }, ...lines.map((line, i) => h(Text, { key: i }, line))))
  const { getDocumentProxy, extractText } = await import('unpdf')
  const { text } = await extractText(await getDocumentProxy(new Uint8Array(await renderToBuffer(doc))), { mergePages: true })
  return text.replace(/\s+/g, ' ').trim()
}

describe('bundled fonts across documents', { timeout: 20_000 }, () => {
  for (const family of ['Source Sans 3', 'Source Serif 4'] as const) {
    it(`draws plain A and O in ${family} after a document that only used Å, Ä and Ö`, async () => {
      await registerBundledFont(family)
      for (const weight of [400, 700]) {
        expect(await render(['Öst Åre Älv', 'Łódź Żywiec'], family, weight)).toBe('Öst Åre Älv Łódź Żywiec')
        expect(await render(['Ordförande Anna Oxelösund', 'Zebra LUKASZ'], family, weight)).toBe('Ordförande Anna Oxelösund Zebra LUKASZ')
      }
    })
  }
})
