/**
 * The send dialog previews the faktureringsmetoden verifikat and, once the
 * user edits any row, books its rows verbatim (customLines). The preview must
 * therefore be the entry the server books on every other door:
 * buildInvoiceJournalEntryInput for an invoice, createCreditNoteJournalEntry
 * for a credit note. These pin that parity on the shapes the old hand-kept
 * copy (rate-grouped, default revenue account only) got wrong.
 */
import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CreateJournalEntryInput, CreateJournalEntryLineInput, Invoice, InvoiceItem, VatTreatment } from '@/types'
import type { FormLine } from '@/components/bookkeeping/JournalEntryForm'

vi.mock('../engine', () => ({
  findFiscalPeriod: vi.fn().mockResolvedValue('period-1'),
  createJournalEntry: vi.fn().mockImplementation(
    async (_supabase: unknown, _companyId: string, _userId: string, input: CreateJournalEntryInput) => ({
      id: 'entry-1',
      ...input,
    }),
  ),
}))

const { buildInvoiceJournalEntryInput, createCreditNoteJournalEntry } = await import('../invoice-entries')
const { proposeSendLines } = await import('../propose-send-lines')

const supabase = {} as SupabaseClient

function item(overrides: Partial<InvoiceItem> = {}): InvoiceItem {
  return {
    id: 'item-1',
    invoice_id: 'inv-1',
    description: 'Konsulttjänst',
    quantity: 1,
    unit: 'st',
    unit_price: 1000,
    line_total: 1000,
    vat_rate: 25,
    vat_amount: 250,
    sort_order: 0,
    created_at: '2026-09-01',
    ...overrides,
  }
}

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-1',
    invoice_number: '2026-042',
    invoice_date: '2026-09-15',
    total: 1250,
    total_sek: null,
    subtotal: 1000,
    subtotal_sek: null,
    vat_amount: 250,
    vat_amount_sek: null,
    currency: 'SEK',
    exchange_rate: null,
    vat_treatment: 'standard_25' as VatTreatment,
    credited_invoice_id: null,
    items: [item()],
    ...overrides,
  } as Invoice
}

/** A credit note as build-credit-note-item.ts writes it: every amount negated. */
function creditNote(original: Invoice, overrides: Partial<Invoice> = {}): Invoice {
  return {
    ...original,
    id: 'cn-1',
    invoice_number: 'KR-2026-007',
    credited_invoice_id: original.id,
    total: -Math.abs(original.total),
    subtotal: -Math.abs(original.subtotal),
    vat_amount: -Math.abs(original.vat_amount),
    items: (original.items ?? []).map((i) => ({
      ...i,
      quantity: -Math.abs(i.quantity),
      line_total: -Math.abs(i.line_total),
      vat_amount: -Math.abs(i.vat_amount),
    })),
    ...overrides,
  } as Invoice
}

type AnyLine = Pick<FormLine, 'account_number' | 'dimensions'> & {
  debit_amount: number | string
  credit_amount: number | string
  line_description?: string
}

const signature = (lines: AnyLine[]) =>
  lines.map((l) => ({
    account: l.account_number,
    debit: Number(l.debit_amount) || 0,
    credit: Number(l.credit_amount) || 0,
    description: l.line_description ?? '',
    dimensions: l.dimensions && Object.keys(l.dimensions).length > 0 ? l.dimensions : undefined,
  }))

const accounts = (lines: AnyLine[]) => lines.map((l) => l.account_number)

function propose(inv: Invoice) {
  return proposeSendLines({ invoice: inv, entityType: 'aktiebolag' })
}

async function booked(inv: Invoice): Promise<CreateJournalEntryLineInput[]> {
  if (inv.credited_invoice_id) {
    const entry = await createCreditNoteJournalEntry(supabase, 'company-1', 'user-1', inv, 'aktiebolag')
    return entry!.lines as unknown as CreateJournalEntryLineInput[]
  }
  const input = await buildInvoiceJournalEntryInput(supabase, 'company-1', inv, 'aktiebolag')
  return input!.lines
}

async function expectParity(inv: Invoice) {
  const proposed = propose(inv)
  expect(proposed.length).toBeGreaterThan(0)
  expect(signature(proposed)).toEqual(signature(await booked(inv)))
  return proposed
}

describe('proposeSendLines proposes what the server books', () => {
  it('credits an item on its own revenue account, not the VAT rate default', async () => {
    const inv = invoice({ items: [item({ revenue_account: '3041' })] })
    const proposed = await expectParity(inv)
    expect(accounts(proposed)).toEqual(['1510', '3041', '2611'])
  })

  it('goods delivered to another EU country book 3108, not 3308 (#2906)', async () => {
    const inv = invoice({
      vat_treatment: 'reverse_charge',
      delivery_country: 'DE',
      total: 1000,
      vat_amount: 0,
      items: [item({ vat_rate: 0, vat_amount: 0 })],
    })
    const proposed = await expectParity(inv)
    expect(accounts(proposed)).toEqual(['1510', '3108'])
  })

  it('goods exported outside the EU book 3105, not 3305 (#2906)', async () => {
    const inv = invoice({
      vat_treatment: 'export',
      delivery_country: 'NO',
      total: 1000,
      vat_amount: 0,
      items: [item({ vat_rate: 0, vat_amount: 0 })],
    })
    const proposed = await expectParity(inv)
    expect(accounts(proposed)).toEqual(['1510', '3105'])
  })

  it('items tagged differently keep their own revenue lines and merged bags', async () => {
    const inv = invoice({
      total: 2500,
      subtotal: 2000,
      vat_amount: 500,
      default_dimensions: { '6': 'P1' },
      items: [
        item({ id: 'a', dimensions: { '1': 'K1' } }),
        item({ id: 'b', dimensions: { '1': 'K2' } }),
      ],
    })
    const proposed = await expectParity(inv)
    expect(proposed.filter((l) => l.account_number === '3001').map((l) => l.dimensions)).toEqual([
      { '6': 'P1', '1': 'K1' },
      { '6': 'P1', '1': 'K2' },
    ])
    expect(proposed.find((l) => l.account_number === '1510')?.dimensions).toEqual({ '6': 'P1' })
  })

  it('a negative row on its own account books as a debit, never a negative credit', async () => {
    const inv = invoice({
      total: 1000,
      subtotal: 800,
      vat_amount: 200,
      items: [
        item(),
        item({ id: 'rabatt', description: 'Rabatt', revenue_account: '3730', unit_price: -200, line_total: -200, vat_amount: -50 }),
      ],
    })
    const proposed = await expectParity(inv)
    expect(proposed.find((l) => l.account_number === '3730')).toMatchObject({ debit_amount: '200', credit_amount: '' })
    for (const line of proposed) {
      expect(parseFloat(line.debit_amount) || 0).toBeGreaterThanOrEqual(0)
      expect(parseFloat(line.credit_amount) || 0).toBeGreaterThanOrEqual(0)
    }
  })

  it('ROT: 1513 per item, 1510 carries the customer share', async () => {
    // 1 000 labour + 25 % = 1 250; ROT 30 % = 375.
    const inv = invoice({ items: [item({ deduction_type: 'rot', revenue_account: '3041' })] })
    const proposed = await expectParity(inv)
    expect(accounts(proposed)).toEqual(['1510', '1513', '3041', '2611'])
    expect(proposed.find((l) => l.account_number === '1510')?.debit_amount).toBe('875')
  })

  it('a periodiserad row previews the 29xx interim account it books', async () => {
    const inv = invoice({
      items: [item({ accrual_period_start: '2026-10-01', accrual_period_end: '2027-09-30' })],
    })
    const proposed = await expectParity(inv)
    expect(accounts(proposed)).toEqual(['1510', '2970', '2611'])
  })

  it('a credit note reverses the original item account (3041), not 3001', async () => {
    const inv = creditNote(invoice({ items: [item({ revenue_account: '3041' })] }))
    const proposed = await expectParity(inv)
    expect(proposed.find((l) => l.account_number === '3041')?.debit_amount).toBe('1000')
    expect(proposed.find((l) => l.account_number === '1510')?.credit_amount).toBe('1250')
    expect(accounts(proposed)).not.toContain('3001')
  })

  it('a credit note on a periodiserad row reverses the 29xx interim account', async () => {
    const inv = creditNote(invoice({
      items: [item({ accrual_period_start: '2026-10-01', accrual_period_end: '2027-09-30' })],
    }))
    const proposed = await expectParity(inv)
    expect(accounts(proposed)).toEqual(['2970', '2611', '1510'])
  })

  it('a credit note of goods abroad reverses 3108 with item bags', async () => {
    const inv = creditNote(invoice({
      vat_treatment: 'reverse_charge',
      delivery_country: 'DE',
      total: 1000,
      vat_amount: 0,
      default_dimensions: { '6': 'P1' },
      items: [item({ vat_rate: 0, vat_amount: 0, dimensions: { '1': 'K1' } })],
    }))
    const proposed = await expectParity(inv)
    expect(proposed.find((l) => l.account_number === '3108')?.dimensions).toEqual({ '6': 'P1', '1': 'K1' })
  })

  it('EUR with a rate converts every leg the way the server does', async () => {
    const inv = invoice({ currency: 'EUR', exchange_rate: 11.5, items: [item({ revenue_account: '3041' })] })
    const proposed = await expectParity(inv)
    expect(proposed.find((l) => l.account_number === '1510')?.debit_amount).toBe('14375')
  })

  it('an invoice without items proposes the header fallback the server books', async () => {
    const inv = invoice({ items: [] })
    const proposed = await expectParity(inv)
    expect(accounts(proposed)).toEqual(['1510', '3001', '2611'])
  })
})
