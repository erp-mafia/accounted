import { describe, it, expect, vi, beforeEach } from 'vitest'
import { roundOre } from '@/lib/money'
import type { CreateJournalEntryInput, CreateJournalEntryLineInput, Invoice, InvoiceItem } from '@/types'

/**
 * The issue door of a SEK customer invoice with öresavrundning: the verifikat
 * books the receivable the invoice states (1510 at the rounded "Att betala",
 * the öre on 3740, no moms on it), so 1510 and the result are right from the
 * day the invoice is issued, not only from the day it is paid.
 */

vi.mock('../engine', () => ({
  findFiscalPeriod: vi.fn().mockResolvedValue('period-1'),
  createJournalEntry: vi.fn().mockImplementation(
    async (_supabase: unknown, _companyId: string, _userId: string, input: CreateJournalEntryInput) => ({
      id: 'entry-1',
      ...input,
    }),
  ),
}))

const { createJournalEntry } = await import('../engine')
const mockedCreateEntry = vi.mocked(createJournalEntry)
const { createInvoiceJournalEntry, createCreditNoteJournalEntry } = await import('../invoice-entries')

function item(overrides: Partial<InvoiceItem> = {}): InvoiceItem {
  return {
    id: 'item-1',
    invoice_id: 'inv-1',
    sort_order: 0,
    description: 'Konsult',
    quantity: 1,
    unit: 'st',
    unit_price: 799.8,
    line_total: 799.8,
    vat_rate: 25,
    vat_amount: 199.95,
    created_at: '2026-03-01T00:00:00Z',
    ...overrides,
  }
}

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-1',
    user_id: 'user-1',
    customer_id: 'cust-1',
    invoice_number: '1001',
    invoice_date: '2026-03-01',
    due_date: '2026-03-31',
    currency: 'SEK',
    exchange_rate: null,
    subtotal: 799.8,
    subtotal_sek: 799.8,
    vat_amount: 199.95,
    vat_amount_sek: 199.95,
    total: 999.75,
    total_sek: 999.75,
    vat_treatment: 'standard_25',
    vat_rate: 25,
    status: 'sent',
    credited_invoice_id: null,
    journal_entry_id: null,
    document_type: 'invoice',
    ore_rounding: true,
    items: [item()],
    ...overrides,
  } as Invoice
}

function net(lines: CreateJournalEntryLineInput[], account: string): number {
  return roundOre(lines.filter((l) => l.account_number === account).reduce((s, l) => s + l.debit_amount - l.credit_amount, 0))
}

async function issue(inv: Invoice): Promise<CreateJournalEntryLineInput[]> {
  await createInvoiceJournalEntry(null as never, 'company-1', 'user-1', inv, 'aktiebolag')
  return mockedCreateEntry.mock.calls.at(-1)![3].lines
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('createInvoiceJournalEntry: an invoice with öresavrundning books what it asks for', () => {
  it('999,75 with rounding on: Dr 1510 1 000, Cr 3740 0,25, revenue and moms as before', async () => {
    const lines = await issue(invoice())
    expect(net(lines, '1510')).toBe(1000)
    expect(net(lines, '3740')).toBe(-0.25)
    expect(net(lines, '3001')).toBe(-799.8)
    expect(net(lines, '2611')).toBe(-199.95)
  })

  it('1 000,40 with rounding on: Dr 1510 1 000, Dr 3740 0,40', async () => {
    const lines = await issue(
      invoice({
        subtotal: 800.32,
        vat_amount: 200.08,
        total: 1000.4,
        total_sek: 1000.4,
        items: [item({ unit_price: 800.32, line_total: 800.32, vat_amount: 200.08 })],
      }),
    )
    expect(net(lines, '1510')).toBe(1000)
    expect(net(lines, '3740')).toBe(0.4)
    expect(net(lines, '2611')).toBe(-200.08)
  })

  it('rounding off on the invoice: the exact total, no 3740', async () => {
    const lines = await issue(invoice({ ore_rounding: false }))
    expect(net(lines, '1510')).toBe(999.75)
    expect(lines.some((l) => l.account_number === '3740')).toBe(false)
  })
})

/** A client that answers the company setting read and the issue receivable RPC. */
function client(opts: { companyOreRounding?: boolean | null; settingsError?: boolean; issueRows?: unknown[] } = {}) {
  const reads: string[] = []
  const rpc = vi.fn(async (name: string) => {
    reads.push(`rpc:${name}`)
    return { data: opts.issueRows ?? [], error: null }
  })
  const from = vi.fn((table: string) => {
    reads.push(table)
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () =>
        opts.settingsError
          ? { data: null, error: { message: 'statement timeout', code: '57014' } }
          : { data: opts.companyOreRounding === undefined ? null : { ore_rounding: opts.companyOreRounding }, error: null },
    }
    return chain
  })
  return { supabase: { rpc, from } as never, reads }
}

describe('createInvoiceJournalEntry: the company setting when the invoice has no choice of its own', () => {
  it('rounding on in the company: 1510 at 1 000', async () => {
    const { supabase, reads } = client({ companyOreRounding: true })
    await createInvoiceJournalEntry(supabase, 'company-1', 'user-1', invoice({ ore_rounding: null }), 'aktiebolag')
    const lines = mockedCreateEntry.mock.calls.at(-1)![3].lines
    expect(net(lines, '1510')).toBe(1000)
    expect(reads).toEqual(['company_settings'])
  })

  it('rounding off in the company: the exact total', async () => {
    const { supabase } = client({ companyOreRounding: false })
    await createInvoiceJournalEntry(supabase, 'company-1', 'user-1', invoice({ ore_rounding: null }), 'aktiebolag')
    const lines = mockedCreateEntry.mock.calls.at(-1)![3].lines
    expect(net(lines, '1510')).toBe(999.75)
    expect(lines.some((l) => l.account_number === '3740')).toBe(false)
  })

  it('a failed read books nothing on a guess', async () => {
    const { supabase } = client({ settingsError: true })
    await expect(
      createInvoiceJournalEntry(supabase, 'company-1', 'user-1', invoice({ ore_rounding: null }), 'aktiebolag'),
    ).rejects.toThrow()
    expect(mockedCreateEntry).not.toHaveBeenCalled()
  })

  it('no read for a whole-krona total, a foreign invoice or a received självfaktura', async () => {
    const { supabase, reads } = client({ companyOreRounding: true })
    await createInvoiceJournalEntry(
      supabase, 'company-1', 'user-1',
      invoice({ ore_rounding: null, subtotal: 800, vat_amount: 200, total: 1000, total_sek: 1000, items: [item({ unit_price: 800, line_total: 800, vat_amount: 200 })] }),
      'aktiebolag',
    )
    await createInvoiceJournalEntry(
      supabase, 'company-1', 'user-1',
      invoice({ ore_rounding: null, is_self_billed: true, invoice_number: null, external_invoice_number: 'S-9' }),
      'aktiebolag',
      undefined,
      { descriptionPrefix: 'Självfaktura', numberOverride: 'S-9' },
    )
    expect(reads).toEqual([])
    const selfBilled = mockedCreateEntry.mock.calls.at(-1)![3].lines
    expect(net(selfBilled, '1510')).toBe(999.75)
    expect(selfBilled.some((l) => l.account_number === '3740')).toBe(false)
  })

  it('a received självfaktura with rounding on keeps the buyer\'s exact amount', async () => {
    const lines = await issue(invoice({ is_self_billed: true, invoice_number: null, external_invoice_number: 'S-9' }))
    expect(net(lines, '1510')).toBe(999.75)
    expect(lines.some((l) => l.account_number === '3740')).toBe(false)
  })
})

describe('createCreditNoteJournalEntry: the credit mirrors what its original\'s issue booked', () => {
  const credit = (overrides: Partial<Invoice> = {}) =>
    invoice({
      id: 'cr-1',
      invoice_number: 'K-1',
      credited_invoice_id: 'inv-1',
      subtotal: -799.8,
      subtotal_sek: -799.8,
      vat_amount: -199.95,
      vat_amount_sek: -199.95,
      total: -999.75,
      total_sek: -999.75,
      items: [item({ unit_price: -799.8, line_total: -799.8, vat_amount: -199.95 })],
      ...overrides,
    })
  const issued = (sek: number) => [{ invoice_id: 'inv-1', sek, currency: 'SEK', total: 999.75, deduction_total: 0 }]

  it('an original issued at 1 000: Cr 1510 1 000, Dr 3740 0,25', async () => {
    const { supabase, reads } = client({ issueRows: issued(1000) })
    await createCreditNoteJournalEntry(supabase, 'company-1', 'user-1', credit(), 'aktiebolag', undefined, 'A-1')
    const lines = mockedCreateEntry.mock.calls.at(-1)![3].lines
    expect(net(lines, '1510')).toBe(-1000)
    expect(net(lines, '3740')).toBe(0.25)
    expect(reads).toEqual(['rpc:invoice_issue_receivable_sek'])
  })

  it('an original issued before the change, at the exact total: Cr 1510 999,75, no 3740', async () => {
    const { supabase } = client({ issueRows: issued(999.75) })
    await createCreditNoteJournalEntry(supabase, 'company-1', 'user-1', credit(), 'aktiebolag', undefined, 'A-1')
    const lines = mockedCreateEntry.mock.calls.at(-1)![3].lines
    expect(net(lines, '1510')).toBe(-999.75)
    expect(lines.some((l) => l.account_number === '3740')).toBe(false)
  })

  it('mirrors from the ledger even when the credit\'s own flag is off', async () => {
    const { supabase } = client({ issueRows: issued(1000) })
    await createCreditNoteJournalEntry(supabase, 'company-1', 'user-1', credit({ ore_rounding: false }), 'aktiebolag', undefined, 'A-1')
    const lines = mockedCreateEntry.mock.calls.at(-1)![3].lines
    expect(net(lines, '1510')).toBe(-1000)
  })

  it('a whole-krona credit costs no read', async () => {
    const { supabase, reads } = client({ issueRows: issued(1000) })
    await createCreditNoteJournalEntry(
      supabase, 'company-1', 'user-1',
      credit({ subtotal: -800, subtotal_sek: -800, vat_amount: -200, vat_amount_sek: -200, total: -1000, total_sek: -1000, items: [item({ unit_price: -800, line_total: -800, vat_amount: -200 })] }),
      'aktiebolag',
    )
    expect(reads).toEqual([])
  })
})
