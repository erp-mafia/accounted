import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { loadSelfBillingBranding } from '../branding'
import { selfBillingPayToLines, selfBillingVatSummary, type SelfBillingPdfItem } from '../pdf-template'
import { renderSelfBillingPdfBuffer, selfBillingPdfFilename } from '../render'
import { buildSelfBillingSnapshot } from '../snapshot'

const ITEMS: SelfBillingPdfItem[] = [
  { sort_order: 0, description: 'Flexintäkt augusti', quantity: 1, unit: 'st', unit_price: 17564.15, line_total: 17564.15, vat_rate: 0.25, vat_amount: 4391.03 },
  { sort_order: 1, description: 'Handelsavgift', quantity: 1, unit: 'st', unit_price: -2107.7, line_total: -2107.7, vat_rate: 0.25, vat_amount: -526.92 },
  { sort_order: 2, description: 'Öresavrundning', quantity: 1, unit: 'st', unit_price: 0.44, line_total: 0.44, vat_rate: 0, vat_amount: 0 },
]

describe('selfBillingVatSummary', () => {
  it('sums base and VAT per rate from the stored lines, highest rate first', () => {
    expect(selfBillingVatSummary(ITEMS)).toEqual([
      { ratePercent: 25, base: 15456.45, vat: 3864.11 },
      { ratePercent: 0, base: 0.44, vat: 0 },
    ])
  })

  it('reads a rate stored as a percentage the same as a fraction', () => {
    expect(selfBillingVatSummary([{ ...ITEMS[0], vat_rate: 25 }])).toEqual([{ ratePercent: 25, base: 17564.15, vat: 4391.03 }])
  })
})

describe('selfBillingPayToLines', () => {
  it('prints the giros, a Swedish account and IBAN with BIC', () => {
    expect(
      selfBillingPayToLines({ bankgiro: '5050-1055', plusgiro: '12345-6', iban: 'SE4550000000058398257466', bic: 'ESSESESS', clearing_number: '8327', account_number: '123456789' }),
    ).toEqual(['Bankgiro 5050-1055', 'Plusgiro 12345-6', 'Bankkonto 8327-123456789', 'IBAN SE4550000000058398257466, BIC ESSESESS'])
    expect(selfBillingPayToLines({ bankgiro: null, plusgiro: null, iban: null, bic: null, clearing_number: '8327', account_number: null })).toEqual([])
  })
})

describe('selfBillingPdfFilename', () => {
  it('names the kind, the number and the seller', () => {
    expect(selfBillingPdfFilename({ number: 'SF-007', isCreditNote: false, sellerName: 'Crayfish Energy AB' })).toBe(
      'Självfaktura SF-007 Crayfish Energy AB.pdf',
    )
    expect(selfBillingPdfFilename({ number: 'SF-008', isCreditNote: true, sellerName: 'A/B "X"' })).toBe('Kreditfaktura SF-008 A B X.pdf')
  })
})

describe('renderSelfBillingPdfBuffer', () => {
  it('renders a PDF of the invoice and of its credit note', async () => {
    const built = buildSelfBillingSnapshot({
      supplier: {
        name: 'Crayfish Energy AB', org_number: '5594774076', vat_number: 'SE559477407601', address_line1: 'Bruksvägen 2',
        address_line2: null, postal_code: '662 30', city: 'Åmål', country: 'SE', bankgiro: '5050-1055', plusgiro: null,
        iban: null, bic: null, clearing_number: null, account_number: null,
      },
      company: {
        company_name: 'Oppy Balancing Services AB', org_number: '5594105693', vat_number: null, address_line1: 'Storgatan 1',
        address_line2: null, postal_code: '111 22', city: 'Stockholm', country: 'SE',
      },
      agreementRef: 'Flexavtal 2026',
      chargesVat: true,
    })
    if (!built.ok) throw new Error('expected a snapshot')
    const invoice = {
      supplier_invoice_number: 'SF-007', invoice_date: '2026-09-30', due_date: '2026-10-30', delivery_date: null,
      currency: 'SEK', subtotal: 15456.89, vat_amount: 3864.11, total: 19321, is_credit_note: false,
    }
    const pdf = await renderSelfBillingPdfBuffer({ invoice, items: ITEMS, snapshot: built.snapshot })
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')

    const credit = await renderSelfBillingPdfBuffer({
      invoice: { ...invoice, supplier_invoice_number: 'SF-008', is_credit_note: true },
      items: ITEMS,
      snapshot: { ...built.snapshot, credits: { number: 'SF-007', invoice_date: '2026-09-30' } },
    })
    expect(credit.subarray(0, 5).toString('latin1')).toBe('%PDF-')

    // The issuer's logo is drawn when the branding carries one.
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#336699' } }).png().toBuffer()
    const withLogo = await renderSelfBillingPdfBuffer({
      invoice,
      items: ITEMS,
      snapshot: built.snapshot,
      branding: { primaryColor: '#1a1a1a', accentColor: '#666666', logoUrl: `data:image/png;base64,${png.toString('base64')}` },
    })
    expect(withLogo.toString('latin1')).toContain('/Subtype /Image')
    expect(pdf.toString('latin1')).not.toContain('/Subtype /Image')
  }, 30_000)
})

describe('loadSelfBillingBranding', () => {
  const DATA_URL = 'data:image/png;base64,iVBORw0KGgo='

  it('carries the logo the company shows on its own invoices', async () => {
    const branding = await loadSelfBillingBranding({ invoice_primary_color: '#112233', logo_url: DATA_URL })
    expect(branding).toEqual({ primaryColor: '#112233', accentColor: '#666666', logoUrl: DATA_URL })
  })

  it('leaves the logo out when the company switched it off or has none', async () => {
    expect((await loadSelfBillingBranding({ logo_url: DATA_URL, invoice_show_logo: false })).logoUrl).toBeNull()
    expect((await loadSelfBillingBranding({ logo_url: null })).logoUrl).toBeNull()
    expect((await loadSelfBillingBranding(null)).logoUrl).toBeNull()
  })
})
