import { describe, it, expect, vi, beforeEach } from 'vitest'
import { roundOre } from '@/lib/money'
import type { CreateJournalEntryInput, CreateJournalEntryLineInput, Invoice, InvoiceItem } from '@/types'

/**
 * The issue verifikat books the öresavrundning (crm#2283): an invoice of
 * 999,75 kr with öresavrundning asks the customer for 1 000 kr, so 1510 is
 * debited 1 000 and 3740 Öres- och kronutjämning credited 0,25 when it is
 * issued, not when the payment arrives. Its kreditfaktura mirrors that, but
 * only when the original's own issue booked the öre.
 */

vi.mock('../engine', () => ({
  findFiscalPeriod: vi.fn().mockResolvedValue('period-1'),
  createJournalEntry: vi.fn().mockImplementation(
    async (_supabase: unknown, _companyId: string, _userId: string, input: CreateJournalEntryInput) => ({
      id: 'entry-1',
      ...input,
      lines: input.lines,
    }),
  ),
}))

const { createJournalEntry } = await import('../engine')
const mockedCreateEntry = vi.mocked(createJournalEntry)
const { createInvoiceJournalEntry, createCreditNoteJournalEntry } = await import('../invoice-entries')
const { buildInvoiceRegistrationLines } = await import('../invoice-lines')

function makeInvoice(overrides: Partial<Invoice> & { items?: InvoiceItem[] }): Invoice {
  return {
    id: 'inv-1',
    user_id: 'user-1',
    customer_id: 'cust-1',
    invoice_number: '1001',
    invoice_date: '2026-11-13',
    due_date: '2026-12-13',
    currency: 'SEK',
    exchange_rate: null,
    subtotal: 799.8,
    subtotal_sek: null,
    vat_amount: 199.95,
    vat_amount_sek: null,
    total: 999.75,
    total_sek: null,
    vat_treatment: 'standard_25',
    status: 'sent',
    credited_invoice_id: null,
    journal_entry_id: null,
    document_type: 'invoice',
    ore_rounding: true,
    items: [makeItem({})],
    ...overrides,
  } as Invoice
}

function makeItem(overrides: Partial<InvoiceItem>): InvoiceItem {
  return {
    id: 'item-1',
    invoice_id: 'inv-1',
    sort_order: 0,
    description: 'Tjänst',
    quantity: 1,
    unit: 'st',
    unit_price: 799.8,
    line_total: 799.8,
    vat_rate: 25,
    vat_amount: 199.95,
    created_at: '2026-11-13T00:00:00Z',
    ...overrides,
  } as InvoiceItem
}

function line(lines: CreateJournalEntryLineInput[], account: string) {
  return lines.find((l) => l.account_number === account)
}

function expectBalanced(lines: CreateJournalEntryLineInput[]) {
  const debit = roundOre(lines.reduce((sum, l) => sum + l.debit_amount, 0))
  const credit = roundOre(lines.reduce((sum, l) => sum + l.credit_amount, 0))
  expect(debit).toBe(credit)
  for (const l of lines) {
    expect(l.debit_amount).toBeGreaterThanOrEqual(0)
    expect(l.credit_amount).toBeGreaterThanOrEqual(0)
  }
}

/** A client that answers the company setting read and, for a credit, the original and its issue verifikat. */
function client(opts: {
  companyOreRounding?: boolean | null
  original?: Record<string, unknown> | null
  issueReceivableSek?: number | null
}) {
  const reads: string[] = []
  const supabase = {
    from: vi.fn((table: string) => {
      reads.push(table)
      const row =
        table === 'company_settings'
          ? opts.companyOreRounding === undefined
            ? null
            : { ore_rounding: opts.companyOreRounding }
          : table === 'invoices'
            ? (opts.original ?? null)
            : null
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: row, error: null }),
      }
      return chain
    }),
    rpc: vi.fn(async (name: string, args: { p_invoice_ids: string[] }) => {
      reads.push(name)
      return {
        data:
          opts.issueReceivableSek == null ? [] : args.p_invoice_ids.map((id) => ({ invoice_id: id, sek: opts.issueReceivableSek })),
        error: null,
      }
    }),
  }
  return { supabase: supabase as never, reads }
}

async function issued(invoice: Invoice, supabase: never = null as never) {
  mockedCreateEntry.mockClear()
  await createInvoiceJournalEntry(supabase, 'company-1', 'user-1', invoice, 'aktiebolag')
  return mockedCreateEntry.mock.calls[0][3].lines
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('the issue verifikat books the öresavrundning (crm#2283)', () => {
  it('999,75 invoiced as 1 000: D 1510 1 000, K 3740 0,25, revenue and moms unchanged', async () => {
    const lines = await issued(makeInvoice({}))

    expect(line(lines, '1510')?.debit_amount).toBe(1000)
    expect(line(lines, '3740')).toMatchObject({ debit_amount: 0, credit_amount: 0.25, line_description: 'Öresavrundning' })
    expect(line(lines, '3001')?.credit_amount).toBe(799.8)
    expect(line(lines, '2611')?.credit_amount).toBe(199.95)
    expectBalanced(lines)
  })

  it('a total rounded down debits 3740: 1 000,40 books D 1510 1 000, D 3740 0,40', async () => {
    const lines = await issued(
      makeInvoice({
        subtotal: 800.32,
        vat_amount: 200.08,
        total: 1000.4,
        items: [makeItem({ unit_price: 800.32, line_total: 800.32, vat_amount: 200.08 })],
      }),
    )

    expect(line(lines, '1510')?.debit_amount).toBe(1000)
    expect(line(lines, '3740')).toMatchObject({ debit_amount: 0.4, credit_amount: 0 })
    expectBalanced(lines)
  })

  it('a ROT/RUT invoice puts the rounded customer share on 1510 and leaves 1513 alone', async () => {
    // 670 + 25 % moms = 837,50, RUT 418: Att betala is 838 - 418 = 420.
    const lines = await issued(
      makeInvoice({
        subtotal: 670,
        vat_amount: 167.5,
        total: 837.5,
        deduction_total: 418,
        items: [makeItem({ unit_price: 670, line_total: 670, vat_amount: 167.5, deduction_type: 'rut', deduction_amount: 418 } as Partial<InvoiceItem>)],
      }),
    )

    expect(line(lines, '1513')?.debit_amount).toBe(418)
    expect(line(lines, '1510')?.debit_amount).toBe(420)
    expect(line(lines, '3740')?.credit_amount).toBe(0.5)
    expectBalanced(lines)
  })

  it('the 3740 line carries the invoice default dimensions like the other generated lines', async () => {
    const lines = await issued(makeInvoice({ default_dimensions: { '1': 'THP' } }))

    expect(line(lines, '3740')?.dimensions).toEqual({ '1': 'THP' })
  })

  it('rounding switched off on the invoice books the exact total, as before', async () => {
    const lines = await issued(makeInvoice({ ore_rounding: false }))

    expect(line(lines, '1510')?.debit_amount).toBe(999.75)
    expect(line(lines, '3740')).toBeUndefined()
  })

  it('a row without its own choice follows the company setting, read once', async () => {
    const on = client({ companyOreRounding: true })
    expect(line(await issued(makeInvoice({ ore_rounding: null }), on.supabase), '1510')?.debit_amount).toBe(1000)
    expect(on.reads).toEqual(['company_settings'])

    const off = client({ companyOreRounding: false })
    expect(line(await issued(makeInvoice({ ore_rounding: null }), off.supabase), '1510')?.debit_amount).toBe(999.75)

    // No settings row: the default the PDF's "Att betala" uses (on).
    const none = client({})
    expect(line(await issued(makeInvoice({ ore_rounding: null }), none.supabase), '1510')?.debit_amount).toBe(1000)
  })

  it('a whole-krona total books no 3740 and reads no setting', async () => {
    const { supabase, reads } = client({ companyOreRounding: true })
    const lines = await issued(
      makeInvoice({ ore_rounding: null, subtotal: 800, vat_amount: 200, total: 1000, items: [makeItem({ unit_price: 800, line_total: 800, vat_amount: 200 })] }),
      supabase,
    )

    expect(line(lines, '1510')?.debit_amount).toBe(1000)
    expect(line(lines, '3740')).toBeUndefined()
    expect(reads).toEqual([])
  })

  it('a foreign-currency invoice is never rounded', async () => {
    const lines = await issued(
      makeInvoice({
        currency: 'EUR',
        exchange_rate: 11,
        subtotal: 79.98,
        vat_amount: 19.995,
        total: 99.975,
        items: [makeItem({ unit_price: 79.98, line_total: 79.98, vat_amount: 19.995 })],
      }),
    )

    expect(line(lines, '3740')).toBeUndefined()
  })

  it('a received självfaktura is booked as the buyer stated it', async () => {
    const lines = await issued(makeInvoice({ is_self_billed: true } as Partial<Invoice>))

    expect(line(lines, '1510')?.debit_amount).toBe(999.75)
    expect(line(lines, '3740')).toBeUndefined()
  })

  it('the kontantmetoden year-end carry (no rounding option) keeps the exact total', () => {
    const lines = buildInvoiceRegistrationLines(makeInvoice({}), 'aktiebolag', null, { deferAccruals: false })

    expect(line(lines, '1510')?.debit_amount).toBe(999.75)
    expect(line(lines, '3740')).toBeUndefined()
  })
})

describe('the kreditfaktura mirrors what the original issue booked (crm#2283)', () => {
  const creditNote = () =>
    makeInvoice({
      id: 'credit-1',
      invoice_number: 'KR-1001',
      credited_invoice_id: 'inv-1',
      subtotal: -799.8,
      vat_amount: -199.95,
      total: -999.75,
      items: [makeItem({ invoice_id: 'credit-1', unit_price: -799.8, line_total: -799.8, vat_amount: -199.95 })],
    })
  const original = { id: 'inv-1', currency: 'SEK', total: 999.75, deduction_total: 0 }

  async function credited(supabase: never) {
    mockedCreateEntry.mockClear()
    await createCreditNoteJournalEntry(supabase, 'company-1', 'user-1', creditNote(), 'aktiebolag', 'Kund AB', 'A-42')
    return mockedCreateEntry.mock.calls[0][3].lines
  }

  it('an original whose issue booked 1 000 is credited K 1510 1 000, D 3740 0,25', async () => {
    const lines = await credited(client({ original, issueReceivableSek: 1000 }).supabase)

    expect(line(lines, '1510')).toMatchObject({ debit_amount: 0, credit_amount: 1000 })
    expect(line(lines, '3740')).toMatchObject({ debit_amount: 0.25, credit_amount: 0 })
    expect(line(lines, '3001')?.debit_amount).toBe(799.8)
    expect(line(lines, '2611')?.debit_amount).toBe(199.95)
    expectBalanced(lines)
  })

  it('mirrors the original even when the credit note’s own flag or the company setting now says off', async () => {
    mockedCreateEntry.mockClear()
    await createCreditNoteJournalEntry(
      client({ original, issueReceivableSek: 1000, companyOreRounding: false }).supabase,
      'company-1',
      'user-1',
      { ...creditNote(), ore_rounding: false },
      'aktiebolag',
    )
    const lines = mockedCreateEntry.mock.calls[0][3].lines

    expect(line(lines, '1510')?.credit_amount).toBe(1000)
    expect(line(lines, '3740')?.debit_amount).toBe(0.25)
    expectBalanced(lines)
  })

  it('an original issued at the exact total (before crm#2283) is credited at the exact total', async () => {
    const lines = await credited(client({ original, issueReceivableSek: 999.75 }).supabase)

    expect(line(lines, '1510')?.credit_amount).toBe(999.75)
    expect(line(lines, '3740')).toBeUndefined()
  })

  it('an original without an issue verifikat is credited at the exact total', async () => {
    const lines = await credited(client({ original, issueReceivableSek: null }).supabase)

    expect(line(lines, '1510')?.credit_amount).toBe(999.75)
    expect(line(lines, '3740')).toBeUndefined()
  })
})
