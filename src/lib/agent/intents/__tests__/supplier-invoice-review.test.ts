import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { supplierInvoiceReview } from '../supplier-invoice-review'

// This sheet is read by an LLM agent that decides whether to attest a supplier
// invoice, and the "KÄNDA FAKTA" block is explicitly labelled "fråga INTE om
// dessa". A magnitude printed there without its unit is worse than a missing
// value: it reads as confirmation of the registered amount, so a 1 200 EUR
// invoice gets attested on the number 1 200 and booked at SEK face value.
// These tests lock every amount to its real currency, and keep any amount that
// cannot be confirmed out of the "do not ask" block entirely.

const INVOICE_ID = '11111111-1111-1111-1111-111111111111'
const DOC_ID = '22222222-2222-2222-2222-222222222222'

type Captured = Parameters<typeof supplierInvoiceReview.promptTemplate>[0]['captured']

const sv = (n: number) => n.toLocaleString('sv-SE')

interface Fixture {
  currency: string | null
  total_sek?: number | null
  vat_amount_sek?: number | null
  exchange_rate?: number | null
  // Currency the AI extraction reports for the PDF. `undefined` = the
  // extraction carries no currency at all (legacy / partial extraction).
  extractionCurrency?: string | null
  withItems?: boolean
  withRecent?: boolean
}

function makeCaptured(f: Fixture): Captured {
  return {
    invoice: {
      id: INVOICE_ID,
      arrival_number: 7,
      supplier_invoice_number: 'F-2026-0042',
      invoice_date: '2026-05-12',
      due_date: '2026-06-11',
      status: 'registered',
      currency: f.currency,
      subtotal: 960,
      vat_amount: 240,
      total: 1200,
      vat_amount_sek: f.vat_amount_sek ?? null,
      total_sek: f.total_sek ?? null,
      exchange_rate: f.exchange_rate ?? null,
      vat_treatment: 'standard_25',
      reverse_charge: false,
      payment_reference: null,
      is_credit_note: false,
      document_id: DOC_ID,
    },
    supplier: {
      id: 'supplier-1',
      name: 'Nordvind Molntjänst BV',
      org_number: null,
      vat_number: 'NL123456789B01',
      country: 'NL',
    },
    items: f.withItems
      ? [
          {
            description: 'Molnlagring maj',
            quantity: 1,
            unit_price: 960,
            line_total: 960,
            vat_rate: 25,
            account_number: null,
          },
        ]
      : [],
    recent_invoices_from_supplier: f.withRecent
      ? [
          {
            invoice_number: 'F-2026-0031',
            invoice_date: '2026-04-12',
            total: 1100,
            total_sek: f.total_sek == null ? null : 12650,
            currency: f.currency,
            exchange_rate: f.exchange_rate ?? null,
            status: 'paid',
          },
        ]
      : [],
    inbox_extraction: {
      supplier: { name: 'Nordvind Molntjänst BV', orgNumber: null, vatNumber: 'NL123456789B01' },
      // `extractionCurrency: undefined` leaves the currency key out entirely.
      invoice:
        'extractionCurrency' in f ? { currency: f.extractionCurrency } : { currency: f.currency },
      totals: { subtotal: 960, vatAmount: 240, total: 1200 },
      vatBreakdown: [{ rate: 25, base: 960, amount: 240 }],
    },
    document_extraction: null,
  }
}

function render(f: Fixture): string {
  return supplierInvoiceReview.promptTemplate({
    captured: makeCaptured(f),
    profileSummary: null,
    activeMemory: [],
  })
}

// The single line that states the invoice's own amount.
function beloppLine(out: string): string {
  return out.split('\n').find((l) => l.startsWith('- Belopp:')) ?? ''
}

// Everything under the "fråga INTE om dessa" header, up to the blank line that
// closes the block. This is the text the agent is told not to question.
function knownFactsBlock(out: string): string {
  const all = out.split('\n')
  const start = all.findIndex((l) => l.startsWith('KÄNDA FAKTA'))
  if (start === -1) return ''
  const rest = all.slice(start + 1)
  const end = rest.findIndex((l) => l === '')
  return rest.slice(0, end === -1 ? rest.length : end).join('\n')
}

describe('supplier_invoice.review currency rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders a 1200 EUR invoice in EUR with the SEK equivalent beside it', () => {
    const out = render({
      currency: 'EUR',
      total_sek: 13800,
      vat_amount_sek: 2760,
      exchange_rate: 11.5,
    })

    expect(beloppLine(out)).toBe(`- Belopp: ${sv(1200)} EUR (moms ${sv(240)} EUR)`)
    expect(beloppLine(out)).not.toContain('SEK')
    expect(out).toContain(`I SEK (bokföringen sker i SEK): ${sv(13800)} SEK`)
    expect(out).toContain(`moms ${sv(2760)} SEK`)
    expect(out).toContain('växelkurs 11.5')
  })

  it('derives the SEK leg from exchange_rate when total_sek is absent', () => {
    const out = render({ currency: 'EUR', total_sek: null, exchange_rate: 11.5 })

    expect(out).toContain(`I SEK (bokföringen sker i SEK): ${sv(13800)} SEK`)
    expect(out).not.toContain('SEK-BELOPP SAKNAS')
  })

  it('says the SEK amount is missing instead of implying SEK when no rate is stored', () => {
    // Neither total_sek nor exchange_rate: there is NO known SEK value. Printing
    // the face value as kronor here is precisely the bug.
    const out = render({ currency: 'EUR', total_sek: null, exchange_rate: null })

    expect(beloppLine(out)).toBe(`- Belopp: ${sv(1200)} EUR (moms ${sv(240)} EUR)`)
    expect(out).toContain('SEK-BELOPP SAKNAS')
    expect(out).toContain(`${sv(1200)} EUR är INTE ${sv(1200)} SEK`)
    expect(out).toContain('Attestera inte på det nominella beloppet')
  })

  it('carries the currency into the KÄNDA FAKTA block for a 1200 EUR invoice', () => {
    // The finding: the PDF total printed as a bare "1 200" three lines under a
    // labelled "Belopp: 1200 EUR", inside a block the agent is told not to
    // question. It must carry EUR.
    const out = render({
      currency: 'EUR',
      total_sek: 13800,
      vat_amount_sek: 2760,
      exchange_rate: 11.5,
      extractionCurrency: 'EUR',
    })
    const known = knownFactsBlock(out)

    expect(known).toContain(`- Total (PDF): ${sv(1200)} EUR`)
    expect(known).toContain(`- Moms (PDF): ${sv(240)} EUR`)
    expect(known).toContain(`- Momsuppdelning: 25%: ${sv(240)} EUR`)
    // No bare magnitude anywhere in the "do not ask" block.
    expect(known).not.toMatch(new RegExp(`${sv(1200)}(?! EUR)`))
    expect(known).not.toContain(`${sv(1200)} SEK`)
  })

  it('keeps a currency-less extracted amount OUT of the known-facts block', () => {
    // A number with no unit cannot confirm a EUR registration. Under a "fråga
    // INTE om dessa" header it reads as confirmation, so it does not belong
    // there at all: it moves to a block that tells the agent to settle it first.
    const out = render({
      currency: 'EUR',
      total_sek: 13800,
      exchange_rate: 11.5,
      extractionCurrency: null,
    })
    const known = knownFactsBlock(out)

    // The supplier identity is still a known fact; the amounts are not.
    expect(known).toContain('- Leverantör (PDF): Nordvind Molntjänst BV')
    expect(known).not.toContain('Total (PDF)')
    expect(known).not.toContain('Moms (PDF)')
    expect(known).not.toContain('Momsuppdelning')

    expect(out).toContain('EJ BEKRÄFTADE BELOPP')
    expect(out).toContain(`- Total (PDF): ${sv(1200)} (valuta okänd)`)
    expect(out).toContain('Extraktionen anger ingen valuta')
    expect(out).toContain('Behandla det ALDRIG som kronor')
    expect(out).toContain(`gnubok_get_document_content(document_id=${DOC_ID})`)
    // And it is never dressed up as kronor.
    expect(out).not.toContain(`Total (PDF): ${sv(1200)} SEK`)
  })

  it('flags a genuine currency conflict between registration and extraction', () => {
    const out = render({
      currency: 'EUR',
      total_sek: 13800,
      exchange_rate: 11.5,
      extractionCurrency: 'USD',
    })

    expect(knownFactsBlock(out)).not.toContain('Total (PDF)')
    expect(out).toContain('EJ BEKRÄFTADE BELOPP')
    expect(out).toContain('VALUTAKONFLIKT')
    expect(out).toContain('registrerad i EUR men underlaget anger USD')
    expect(out).toContain(`- Total (PDF): ${sv(1200)} USD`)
  })

  it('renders a plain SEK invoice unchanged', () => {
    const out = render({
      currency: 'SEK',
      extractionCurrency: 'SEK',
      withItems: true,
      withRecent: true,
    })

    expect(beloppLine(out)).toBe(`- Belopp: ${sv(1200)} SEK (moms ${sv(240)} SEK)`)
    expect(out).not.toContain('I SEK (bokföringen sker i SEK)')
    expect(out).not.toContain('SEK-BELOPP SAKNAS')
    expect(out).not.toContain('EJ BEKRÄFTADE BELOPP')
    expect(out).not.toContain('VALUTAKONFLIKT')
    expect(out).not.toContain('valuta okänd')
    // Amounts still carry their unit, and the extraction stays a known fact.
    expect(knownFactsBlock(out)).toContain(`- Total (PDF): ${sv(1200)} SEK`)
    expect(out).toContain(`  • Molnlagring maj: ${sv(960)} SEK (25%)`)
    expect(out).toContain(`F-2026-0031 (2026-04-12, paid): ${sv(1100)} SEK`)
  })

  it('labels line items and supplier history in the invoice currency, never bare', () => {
    const out = render({
      currency: 'EUR',
      total_sek: 13800,
      exchange_rate: 11.5,
      withItems: true,
      withRecent: true,
    })

    expect(out).toContain(`  • Molnlagring maj: ${sv(960)} EUR (25%)`)
    // Supplier history is what the anomaly check compares against, so the SEK
    // leg travels with it: comparing 1 100 EUR to a SEK figure says nothing.
    expect(out).toContain(`F-2026-0031 (2026-04-12, paid): ${sv(1100)} EUR (${sv(12650)} SEK)`)
    expect(out).not.toContain(`${sv(960)} SEK`)
  })

  it('tells the agent that a foreign invoice is booked on the SEK amount', () => {
    const out = render({ currency: 'EUR', total_sek: 13800, exchange_rate: 11.5 })

    expect(out).toContain('bokföringen sker i SEK')
    expect(out).toContain('Ett belopp utan angiven valuta är inte ett SEK-belopp')
    expect(out).toContain('Jämför i SEK när valutorna skiljer sig åt')
  })
})

describe('supplier_invoice.review capture', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('threads the SEK columns and the exchange rate through capture', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      // 1. the invoice itself
      {
        data: {
          id: INVOICE_ID,
          supplier_id: 'supplier-1',
          arrival_number: 7,
          supplier_invoice_number: 'F-2026-0042',
          invoice_date: '2026-05-12',
          due_date: '2026-06-11',
          status: 'registered',
          currency: 'EUR',
          exchange_rate: 11.5,
          subtotal: 960,
          vat_amount: 240,
          vat_amount_sek: 2760,
          total: 1200,
          total_sek: 13800,
          vat_treatment: 'standard_25',
          reverse_charge: false,
          payment_reference: null,
          is_credit_note: false,
          document_id: DOC_ID,
        },
      },
      // 2. supplier
      { data: { id: 'supplier-1', name: 'Nordvind Molntjänst BV', org_number: null, vat_number: null, country: 'NL' } },
      // 3. items
      { data: [] },
      // 4. recent invoices from the same supplier
      {
        data: [
          {
            supplier_invoice_number: 'F-2026-0031',
            invoice_date: '2026-04-12',
            total: 1100,
            total_sek: 12650,
            currency: 'EUR',
            exchange_rate: 11.5,
            status: 'paid',
          },
        ],
      },
      // 5. inbox extraction
      { data: null },
      // 6. document extraction
      { data: null },
    ])

    const captured = await supplierInvoiceReview.capture(
      { supplier_invoice_id: INVOICE_ID },
      {
        supabase: supabase as unknown as SupabaseClient,
        userId: 'user-1',
        companyId: 'company-1',
      },
    )

    expect(captured.invoice?.currency).toBe('EUR')
    expect(captured.invoice?.total).toBe(1200)
    expect(captured.invoice?.total_sek).toBe(13800)
    expect(captured.invoice?.vat_amount_sek).toBe(2760)
    expect(captured.invoice?.exchange_rate).toBe(11.5)
    expect(captured.recent_invoices_from_supplier[0].total_sek).toBe(12650)
    expect(captured.recent_invoices_from_supplier[0].exchange_rate).toBe(11.5)
  })
})
