import { describe, it, expect } from 'vitest'
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
