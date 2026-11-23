import { describe, expect, it } from 'vitest'
import { documentXml, renderDocx } from '../docx'
import type { FormationDocument } from '../document-model'

const doc: FormationDocument = {
  slug: 'test',
  title: 'Bolagsordning för Test & Co AB',
  subtitle: 'Utkast',
  blocks: [
    { kind: 'heading', text: '1. Företagsnamn' },
    { kind: 'paragraph', text: 'Aktiebolagets företagsnamn är Test & Co AB.' },
    { kind: 'list', items: ['ett', 'två'], ordered: true },
    { kind: 'table', head: ['Aktienummer', 'Ägare'], rows: [['1-500', 'Test <Testsson>']] },
    { kind: 'fields', rows: [{ label: 'Namn', value: 'Test' }] },
    { kind: 'signatures', people: [{ name: 'Test Testsson', caption: 'Stiftare' }] },
  ],
  footer: 'Mall från Accounted',
}

function entryNames(zip: Uint8Array): string[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  let eocd = -1
  for (let i = zip.length - 22; i >= 0; i--) if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  const count = view.getUint16(eocd + 10, true)
  let p = view.getUint32(eocd + 16, true)
  const names: string[] = []
  for (let k = 0; k < count; k++) {
    const nlen = view.getUint16(p + 28, true)
    const elen = view.getUint16(p + 30, true)
    const clen = view.getUint16(p + 32, true)
    names.push(new TextDecoder().decode(zip.slice(p + 46, p + 46 + nlen)))
    p += 46 + nlen + elen + clen
  }
  return names
}

describe('renderDocx', () => {
  it('writes the Office Open XML parts a word processor needs', async () => {
    const zip = await renderDocx(doc)
    expect(entryNames(zip)).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
      'word/_rels/document.xml.rels',
      'word/footer1.xml',
    ])
  })

  it('is byte-stable for the same document', async () => {
    expect(await renderDocx(doc)).toEqual(await renderDocx(doc))
  })

  it('escapes XML in the text', () => {
    const xml = documentXml(doc)
    expect(xml).toContain('Test &amp; Co AB')
    expect(xml).toContain('Test &lt;Testsson&gt;')
    expect(xml).not.toContain('<Testsson>')
  })
})
