import { describe, it, expect } from 'vitest'
import { MAIL_HTML_FIXTURES } from '@/tests/fixtures/mail-html'
import { htmlToText, readTextDocument } from '../text'

describe('htmlToText', () => {
  it('keeps the words, drops scripts, styles and tags, and keeps line breaks between blocks', () => {
    const html =
      '<html><head><style>p{}</style><script>x()</script></head><body><h1>Faktura</h1><p>Belopp: <b>1 249</b> kr &amp; moms</p><table><tr><td>A</td><td>B</td></tr></table></body></html>'
    expect(htmlToText(html)).toBe('Faktura\nBelopp: 1 249 kr & moms\nA B')
  })

  it('drops script and style bodies and comments whatever their end tags look like', () => {
    const html = '<p>Före</p><script type="x">a()</script ><SCRIPT>b()</SCRIPT\t\n foo><style>p{}</style ><!-- dold --!><p>Efter</p>'
    expect(htmlToText(html)).toBe('Före\nEfter')
  })

  it('decodes entities once, including Swedish letters and numeric references', () => {
    const html = '<p>R&auml;ntan &amp;lt;5 %&amp;gt; &#246;kar&#x21;&nbsp;Sk&aring;ne &Ouml;l &unknown;</p>'
    expect(htmlToText(html)).toBe('Räntan &lt;5 %&gt; ökar! Skåne Öl &unknown;')
  })

  it('reads plain text as one page and refuses empty bodies', () => {
    expect(readTextDocument(Buffer.from('  '), 'text/plain')).toEqual([])
    expect(readTextDocument(Buffer.from('Hej'), 'text/plain')[0]).toMatchObject({ pageNo: 1, reader: 'text', text: 'Hej' })
  })
})

describe('htmlToText on mail as senders write it', () => {
  const READ: Record<string, string> = {
    'an Outlook invoice mail':
      'Hej,\n\nBifogat finns faktura 2025-0042 för november.\n\nAtt betala: 12 500,00 kr inkl. moms. Förfallodag 2025-12-31.\n\nBankgiro 123-4567, OCR 20250042.\n\nMed vänliga hälsningar\n\nAnna Exempel\n\nExempel Leverantör AB',
    'a web shop receipt':
      'Ditt kvitto från Exempelbutiken\n\nTack för ditt köp!\n\nOrdernummer: 100-2381\n\nKontorsstol Ergo & fotstöd 2 990,00 kr\n\nFrakt 49,00 kr\n\nTotalt 3 039,00 kr\n\nVarav moms 25 %: 607,80 kr',
    'a receipt forwarded from Gmail':
      '---------- Forwarded message ---------\nFrån: Exempel Hosting <faktura@hosting.example>\nDate: tis 25 nov. 2025 kl 09:14\nSubject: Kvitto för betalning #48213\nTo: <ekonomi@foretaget.example>\n\nHej!\nVi har tagit emot din betalning på 1 249,00 kr för perioden 2025-11-01 till 2025-11-30.\nWebbhotell Bas: 999,00 kr\nDomän foretaget.example: 250,00 kr\nKortet slutar på 4242.\nDetta mejl kan inte besvaras.',
    'a page saved from a supplier portal':
      'Faktura 7781\n\nExempel Leverantör AB\n\nFaktura 7781\n\nFakturadatum: 2025-11-03\nFörfallodag: 2025-12-03\n\nKonsulttimmar, 10 h 9 500,00\nMoms 25 % 2 375,00\n\nSumma att betala: 11 875,00 SEK\n\nBet.villkor 30 dagar netto. Dröjsmålsränta enligt räntelagen.\n\n<!-- generated 2025-11-03T08:00:00Z',
  }

  it.each(MAIL_HTML_FIXTURES)('reads %s as before', (name, html) => {
    expect(htmlToText(html)).toBe(READ[name])
  })

  // Each of these took seconds per 100 KB, searching the rest of the body
  // again from every opening. The bound is checked after each size, the
  // smaller first, so a slow step fails here instead of hanging the run.
  it.each([
    ['opening script tags without their >', '<script '],
    ['opening style tags without their >', '<style '],
    ['comments that never end', '<!--'],
    ['line breaks without their >', '<br '],
    ['tags without their >', '<'],
  ])('answers at once for a body made of %s', (_, unit) => {
    const started = Date.now()
    for (const kb of [256, 1024]) {
      htmlToText(unit.repeat(Math.floor((kb * 1024) / unit.length)))
      expect(Date.now() - started).toBeLessThan(2000)
    }
  })
})
