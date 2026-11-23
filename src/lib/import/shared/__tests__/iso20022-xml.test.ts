import { describe, expect, it } from 'vitest'
import { extractAllText, extractAmount, extractTextContent, plainXml } from '../iso20022-xml'

describe('plainXml', () => {
  it('drops comments and leaves everything else as written', () => {
    expect(plainXml('<a><!-- one --><b>1</b><!-- two\nlines --></a>')).toBe('<a><b>1</b></a>')
    expect(plainXml('<a><b>1 &amp; 2</b></a>')).toBe('<a><b>1 &amp; 2</b></a>')
  })

  it('turns a CDATA section into the escaped text it stands for', () => {
    const xml = plainXml('<Ustrd><![CDATA[Faktura <1004> & mer]]></Ustrd>')
    expect(xml).toBe('<Ustrd>Faktura &lt;1004&gt; &amp; mer</Ustrd>')
    expect(extractTextContent(xml, 'Ustrd')).toBe('Faktura <1004> & mer')
  })

  it('reads a comment opener inside CDATA as text, and a CDATA opener inside a comment as comment', () => {
    const cdataFirst = plainXml('<a><b><![CDATA[x <!-- y]]></b><c>kept</c><!-- real --></a>')
    expect(extractAllText(cdataFirst, 'b')).toEqual(['x <!-- y'])
    expect(extractTextContent(cdataFirst, 'c')).toBe('kept')

    const commentFirst = plainXml('<a><!-- <![CDATA[ --><b>kept</b><c><![CDATA[1 < 2]]></c></a>')
    expect(commentFirst).toBe('<a><b>kept</b><c>1 &lt; 2</c></a>')
  })

  it('leaves a section that never closes as it is written', () => {
    expect(plainXml('<a><b>1</b><!-- open')).toBe('<a><b>1</b><!-- open')
    expect(plainXml('<a><!-- done --><![CDATA[open')).toBe('<a><![CDATA[open')
  })
})

describe('extractAmount', () => {
  it('reads the amount and its currency, however the attribute is spaced or quoted', () => {
    expect(extractAmount('<Amt Ccy="SEK">1234.56</Amt>')).toEqual({ value: '1234.56', currency: 'SEK' })
    expect(extractAmount("<Amt  Ccy = 'usd' >10</Amt>")).toEqual({ value: '10', currency: 'USD' })
    expect(extractAmount('<Amt>10</Amt>')).toEqual({ value: '10', currency: null })
  })

  it('matches the element name exactly', () => {
    const xml = '<RfrdDocAmt><RmtdAmt Ccy="SEK">5.00</RmtdAmt></RfrdDocAmt><Amt Ccy="SEK">7.00</Amt>'
    expect(extractAmount(xml)).toEqual({ value: '7.00', currency: 'SEK' })
    expect(extractAmount(xml, 'RmtdAmt')).toEqual({ value: '5.00', currency: 'SEK' })
    expect(extractAmount(xml, 'CdtNoteAmt')).toBeNull()
  })
})
