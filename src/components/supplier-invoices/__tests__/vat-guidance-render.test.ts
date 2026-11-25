/**
 * The editor's moms guidance as a person reads it, rendered under both
 * catalogues: a missing key or a broken ICU argument fails here, and the
 * sentences say what they must (the invoice's moms, where it belongs, and the
 * control for moms that is not wholly deductible).
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderInLocale, visibleText } from '@/tests/i18n-render'
import { InputVatRowHint, RowsCarryNoVatLine } from '../VatGuidanceLines'

/** The line as one sentence: its text nodes joined, spaces normalised. */
const read = (html: string) => visibleText(html).join(' ')

describe('RowsCarryNoVatLine', () => {
  const render = (locale: 'sv' | 'en', currency = 'SEK') =>
    renderInLocale(createElement(RowsCarryNoVatLine, { vat: 1012.5, currency }), locale)

  it('names the invoice moms, where it belongs and the control for a part that is not deductible', () => {
    expect(read(render('sv'))).toBe(
      'Fakturan har 1 012,50 kr moms, raderna ingen. Sätt momssatsen på kostnadsraden. ' +
        'Är inte hela momsen avdragsgill: välj Begränsat momsavdrag (%) på raden.',
    )
    expect(read(render('en'))).toBe(
      'The invoice has 1 012,50 kr VAT, the rows none. Set the VAT rate on the cost row. ' +
        'If not all of the VAT is deductible, use Limited VAT deduction (%) on the row.',
    )
  })

  it('is the red line it stands in for', () => {
    expect(render('sv')).toContain('text-destructive')
  })

  it('states a foreign invoice\'s moms in its own currency', () => {
    expect(read(render('sv', 'EUR'))).toContain('Fakturan har 1 012,50 € moms')
  })
})

describe('InputVatRowHint', () => {
  it('says the row is not the invoice\'s moms and where the moms belongs', () => {
    expect(read(renderInLocale(createElement(InputVatRowHint), 'sv'))).toBe(
      'Den här raden räknas inte som fakturans moms. Sätt momssatsen på kostnadsraden, så bokförs momsen därifrån.',
    )
    expect(read(renderInLocale(createElement(InputVatRowHint), 'en'))).toBe(
      'This row does not count as the invoice\'s VAT. Set the VAT rate on the cost row and the VAT is booked from there.',
    )
  })

  it('is a quiet caption: the row still books as typed', () => {
    const html = renderInLocale(createElement(InputVatRowHint), 'sv')
    expect(html).toContain('text-muted-foreground')
    expect(html).not.toContain('text-destructive')
  })
})
