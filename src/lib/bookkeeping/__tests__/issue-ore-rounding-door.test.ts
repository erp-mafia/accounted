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
  const { supabase } = client()
  await createInvoiceJournalEntry(supabase, 'company-1', 'user-1', inv, 'aktiebolag')
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

/**
 * A client that answers the company setting read, the 3740 row of the
 * kontoplan (absent unless `account3740Active` says how it stands) and the
 * issue receivable RPC.
 */
function client(opts: {
  companyOreRounding?: boolean | null
  settingsError?: boolean
  account3740Active?: boolean
  issueRows?: unknown[]
} = {}) {
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
      maybeSingle: async () => {
        if (opts.settingsError) return { data: null, error: { message: 'statement timeout', code: '57014' } }
        if (table === 'chart_of_accounts') {
          return { data: opts.account3740Active === undefined ? null : { is_active: opts.account3740Active }, error: null }
        }
        return { data: opts.companyOreRounding === undefined ? null : { ore_rounding: opts.companyOreRounding }, error: null }
      },
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
    expect(reads).toEqual(['company_settings', 'chart_of_accounts'])
  })

  it('rounding off in the company: the exact total', async () => {
    const { supabase } = client({ companyOreRounding: false })
    await createInvoiceJournalEntry(supabase, 'company-1', 'user-1', invoice({ ore_rounding: null }), 'aktiebolag')
    const lines = mockedCreateEntry.mock.calls.at(-1)![3].lines
    expect(net(lines, '1510')).toBe(999.75)
    expect(lines.some((l) => l.account_number === '3740')).toBe(false)
  })

  it('3740 switched off in the kontoplan: the invoice still issues, at the exact total', async () => {
    const { supabase } = client({ companyOreRounding: true, account3740Active: false })
    await createInvoiceJournalEntry(supabase, 'company-1', 'user-1', invoice({ ore_rounding: null }), 'aktiebolag')
    const lines = mockedCreateEntry.mock.calls.at(-1)![3].lines
    expect(net(lines, '1510')).toBe(999.75)
    expect(lines.some((l) => l.account_number === '3740')).toBe(false)
  })

  it('3740 active or not yet in the kontoplan (the engine seeds it): the rounding is booked', async () => {
    for (const account3740Active of [true, undefined]) {
      const { supabase } = client({ account3740Active })
      await createInvoiceJournalEntry(supabase, 'company-1', 'user-1', invoice(), 'aktiebolag')
      expect(net(mockedCreateEntry.mock.calls.at(-1)![3].lines, '1510')).toBe(1000)
    }
  })

  it('a ROT/RUT invoice keeps the exact total and reads nothing', async () => {
    const { supabase, reads } = client({ companyOreRounding: true })
    await createInvoiceJournalEntry(
      supabase, 'company-1', 'user-1',
      invoice({
        ore_rounding: null,
        subtotal: 670, subtotal_sek: 670, vat_amount: 167.5, vat_amount_sek: 167.5, total: 837.5, total_sek: 837.5,
        deduction_total: 418,
        items: [item({ unit_price: 670, line_total: 670, vat_amount: 167.5, deduction_type: 'rut', deduction_amount: 418 })],
      }),
      'aktiebolag',
    )
    const lines = mockedCreateEntry.mock.calls.at(-1)![3].lines
    expect(net(lines, '1510')).toBe(419.5)
    expect(lines.some((l) => l.account_number === '3740')).toBe(false)
    expect(reads).toEqual([])
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
    // EUR 99,75 with öre: öresavrundning is for kronor only.
    await createInvoiceJournalEntry(
      supabase, 'company-1', 'user-1',
      invoice({
        ore_rounding: null, currency: 'EUR', exchange_rate: 11.5,
        subtotal: 79.8, subtotal_sek: 917.7, vat_amount: 19.95, vat_amount_sek: 229.43, total: 99.75, total_sek: 1147.13,
        items: [item({ unit_price: 79.8, line_total: 79.8, vat_amount: 19.95 })],
      }),
      'aktiebolag',
    )
    const foreign = mockedCreateEntry.mock.calls.at(-1)![3].lines
    expect(foreign.some((l) => l.account_number === '3740')).toBe(false)
    expect(reads).toEqual([])
    const selfBilled = mockedCreateEntry.mock.calls.at(-2)![3].lines
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

  it('mirrors exactly what the original booked: 1 000,50 booked at 1 000 is credited 1 000 and 0,50', async () => {
    const odd = credit({
      subtotal: -800.4, subtotal_sek: -800.4, vat_amount: -200.1, vat_amount_sek: -200.1, total: -1000.5, total_sek: -1000.5,
      items: [item({ unit_price: -800.4, line_total: -800.4, vat_amount: -200.1 })],
    })
    const { supabase } = client({ issueRows: [{ invoice_id: 'inv-1', sek: 1000, currency: 'SEK', total: 1000.5, deduction_total: 0 }] })
    await createCreditNoteJournalEntry(supabase, 'company-1', 'user-1', odd, 'aktiebolag', undefined, 'A-1')
    const lines = mockedCreateEntry.mock.calls.at(-1)![3].lines
    // Not 1 001 and another 0,50: the pair nets to zero on 1510 and 3740.
    expect(net(lines, '1510')).toBe(-1000)
    expect(net(lines, '3740')).toBe(-0.5)
  })

  it('a credit of part of the original reverses its exact amounts', async () => {
    const part = credit({
      subtotal: -399.9, subtotal_sek: -399.9, vat_amount: -99.98, vat_amount_sek: -99.98, total: -499.88, total_sek: -499.88,
      items: [item({ unit_price: -399.9, line_total: -399.9, vat_amount: -99.98 })],
    })
    const { supabase } = client({ issueRows: issued(1000) })
    await createCreditNoteJournalEntry(supabase, 'company-1', 'user-1', part, 'aktiebolag', undefined, 'A-1')
    const lines = mockedCreateEntry.mock.calls.at(-1)![3].lines
    expect(net(lines, '1510')).toBe(-499.88)
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
