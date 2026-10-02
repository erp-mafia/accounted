/**
 * Moving a supplier-invoice line to another account keeps its dimensions.
 *
 * The registration verifikat aggregates the cost per (account, dimensions
 * bag). The move used to add every replacement line untagged and, on an
 * aggregated verifikat, strike every line on the old account whatever its
 * bag: the moved cost lost its projekt, and the costs of OTHER items on the
 * same account were merged into one untagged rest line.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'

const { strikeLines } = vi.hoisted(() => ({ strikeLines: vi.fn() }))
vi.mock('@/lib/core/bookkeeping/journal-entry-corrections', () => ({
  strikeJournalEntryLines: (...args: unknown[]) => strikeLines(...args),
}))
vi.mock('@/lib/bookkeeping/account-backfill', () => ({
  backfillStandardBASAccounts: vi.fn().mockResolvedValue([]),
}))

import { planAccountMove, bookedItemDimensions, moveSupplierInvoiceItemAccount } from '../item-account'
import { buildSupplierInvoiceRegistrationEntryInput } from '@/lib/bookkeeping/supplier-invoice-entries'
import type { SupplierInvoice, SupplierInvoiceItem } from '@/types'

const line = (
  id: string,
  account_number: string,
  debit_amount: number,
  dimensions: Record<string, string> = {},
  line_description: string | null = 'Leverantörsfaktura F-1',
) => ({ id, account_number, debit_amount, credit_amount: 0, line_description, dimensions })

describe('planAccountMove keeps the moved cost tagged and leaves other bags alone', () => {
  it('exact, tagged: of two equal amounts on the account, the line with the item\'s bag is moved, bag and all', () => {
    const plan = planAccountMove(
      [line('l1', '6110', 100, { '6': 'P001' }), line('l2', '6110', 100, { '6': 'P002' }), line('l3', '2641', 50)],
      '6110', '6550', 100, 'Kablar', { '6': 'P002' },
    )

    expect(plan).toEqual({
      strike: ['l2'],
      add: [{ account_number: '6550', debit_amount: 100, credit_amount: 0, line_description: 'Leverantörsfaktura F-1', dimensions: { '6': 'P002' } }],
    })
  })

  it('exact, retagged after posting: the replacement keeps the struck line\'s current bag', () => {
    const plan = planAccountMove(
      [line('l1', '6110', 100, { '6': 'P009' }), line('l2', '2641', 25)],
      '6110', '6550', 100, 'Kablar', { '6': 'P001' },
    )

    expect(plan?.strike).toEqual(['l1'])
    expect(plan?.add).toEqual([expect.objectContaining({ account_number: '6550', debit_amount: 100, dimensions: { '6': 'P009' } })])
  })

  it('aggregate with two bags on the account: only the matching bag\'s line is split, the other stays', () => {
    // Items A (P001, 100) and C (P001, 200) were aggregated on one line; item
    // B (P002, 100) has its own. The old planner took B's line for A, since
    // it carries exactly A's amount.
    const plan = planAccountMove(
      [line('l1', '6110', 300, { '6': 'P001' }), line('l2', '6110', 100, { '6': 'P002' })],
      '6110', '6550', 100, 'Kablar', { '6': 'P001' },
    )

    expect(plan).toEqual({
      strike: ['l1'],
      add: [
        { account_number: '6110', debit_amount: 200, credit_amount: 0, line_description: 'Leverantörsfaktura F-1', dimensions: { '6': 'P001' } },
        { account_number: '6550', debit_amount: 100, credit_amount: 0, line_description: 'Kablar', dimensions: { '6': 'P001' } },
      ],
    })
  })

  it('an untagged item never takes a tagged neighbour\'s cost into its untagged rest line', () => {
    const plan = planAccountMove(
      [line('l1', '6110', 300), line('l2', '6110', 500, { '6': 'P001' })],
      '6110', '6550', 100, 'Kablar',
    )

    expect(plan).toEqual({
      strike: ['l1'],
      add: [
        { account_number: '6110', debit_amount: 200, credit_amount: 0, line_description: 'Leverantörsfaktura F-1' },
        { account_number: '6550', debit_amount: 100, credit_amount: 0, line_description: 'Kablar' },
      ],
    })
  })

  it('keys an account dimension rule added at booking stay on the moved line', () => {
    const plan = planAccountMove(
      [line('l1', '6110', 100, { '1': 'KS01', '6': 'P001' }), line('l2', '6110', 100, { '1': 'KS01', '6': 'P002' })],
      '6110', '6550', 100, 'Kablar', { '6': 'P001' },
    )

    expect(plan?.strike).toEqual(['l1'])
    expect(plan?.add[0]?.dimensions).toEqual({ '1': 'KS01', '6': 'P001' })
  })

  it('refuses rather than guesses when two other bags could each be the item\'s', () => {
    expect(
      planAccountMove(
        [line('l1', '6110', 100, { '6': 'P002' }), line('l2', '6110', 100, { '6': 'P003' })],
        '6110', '6550', 100, 'Kablar', { '6': 'P001' },
      ),
    ).toBeNull()
  })

  it('bookedItemDimensions merges the item\'s bag over the invoice default, as the registration did', () => {
    expect(bookedItemDimensions({ '1': 'KS01', '6': 'P001' }, { '6': 'P002' })).toEqual({ '1': 'KS01', '6': 'P002' })
    expect(bookedItemDimensions(null, null)).toEqual({})
  })
})

describe('moveSupplierInvoiceItemAccount carries the bag into the rättelse', () => {
  const invoiceRow = {
    id: 'inv-1',
    status: 'registered',
    registration_journal_entry_id: 'je-1',
    default_dimensions: { '1': 'KS01' },
  }
  const itemRow = { id: 'item-1', account_number: '6110', line_total: 100, description: 'Kablar', dimensions: { '6': 'P001' } }
  const verifikat = [
    line('l1', '6110', 300, { '1': 'KS01', '6': 'P001' }),
    line('l2', '6110', 100, { '1': 'KS01', '6': 'P002' }),
    line('l3', '2641', 100, { '1': 'KS01' }),
  ]
  const ctx = (supabase: unknown) => ({
    supabase: supabase as never,
    companyId: 'company-1',
    userId: 'user-1',
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('strikes only the item\'s line and adds the split lines with its bag', async () => {
    const { supabase } = createTableMockSupabase({
      supplier_invoices: { data: invoiceRow },
      supplier_invoice_items: [{ data: itemRow }, { data: [{ id: 'item-1' }] }],
      journal_entry_lines: { data: verifikat },
    })
    strikeLines.mockResolvedValue({ ok: true, data: {} })

    const outcome = await moveSupplierInvoiceItemAccount(ctx(supabase), 'inv-1', 'item-1', '6550')

    expect(outcome).toEqual({ ok: true, data: { changed: true, corrected: true } })
    expect(strikeLines).toHaveBeenCalledWith(expect.anything(), 'je-1', {
      strike_line_ids: ['l1'],
      lines: [
        { account_number: '6110', debit_amount: 200, credit_amount: 0, line_description: 'Leverantörsfaktura F-1', dimensions: { '1': 'KS01', '6': 'P001' } },
        { account_number: '6550', debit_amount: 100, credit_amount: 0, line_description: 'Kablar', dimensions: { '1': 'KS01', '6': 'P001' } },
      ],
    })
  })

  it('the dry run shows the bag the moved cost keeps and hands the tagged lines to the rättelse preview', async () => {
    const { supabase } = createTableMockSupabase({
      supplier_invoices: { data: invoiceRow },
      supplier_invoice_items: { data: itemRow },
      journal_entry_lines: { data: verifikat },
    })
    strikeLines.mockImplementation(async (_ctx, _entryId, input) => ({ ok: true, dryRun: true, preview: { added_lines: input.lines } }))

    const outcome = await moveSupplierInvoiceItemAccount(ctx(supabase), 'inv-1', 'item-1', '6550', { dryRun: true })

    if (!outcome.ok || !outcome.dryRun) throw new Error('expected a dry-run preview')
    const preview = outcome.preview as {
      dimensions: Record<string, string>
      rattelse: { added_lines: Array<{ dimensions: Record<string, string> }> }
    }
    expect(preview.dimensions).toEqual({ '1': 'KS01', '6': 'P001' })
    expect(preview.rattelse.added_lines.map((l) => l.dimensions)).toEqual([
      { '1': 'KS01', '6': 'P001' },
      { '1': 'KS01', '6': 'P001' },
    ])
    expect(strikeLines).toHaveBeenCalledWith(expect.anything(), 'je-1', expect.objectContaining({ strike_line_ids: ['l1'] }), { dryRun: true })
  })

  it('reverts the item and answers SI_ITEM_ACCOUNT_NO_MATCHING_LINE when the lines are ambiguous', async () => {
    const { supabase, findCalls } = createTableMockSupabase({
      supplier_invoices: { data: { ...invoiceRow, default_dimensions: {} } },
      supplier_invoice_items: [{ data: itemRow }, { data: [{ id: 'item-1' }] }, { data: null }],
      journal_entry_lines: { data: [line('l1', '6110', 100, { '6': 'P002' }), line('l2', '6110', 100, { '6': 'P003' })] },
    })

    const outcome = await moveSupplierInvoiceItemAccount(ctx(supabase), 'inv-1', 'item-1', '6550')

    expect(outcome).toMatchObject({ ok: false, code: 'SI_ITEM_ACCOUNT_NO_MATCHING_LINE' })
    expect(strikeLines).not.toHaveBeenCalled()
    expect(findCalls('supplier_invoice_items', 'update').map((c) => c[0])).toEqual([
      { account_number: '6550' },
      { account_number: '6110' },
    ])
  })
})

// A foreign-currency invoice: the registration verifikat books each line in
// SEK (toSekOrThrow at the invoice's stored rate, rounded per line), while
// supplier_invoice_items.line_total stays in the invoice currency. The move
// used to compare and move the foreign figure as if it were kronor.
describe('moveSupplierInvoiceItemAccount on a foreign-currency invoice', () => {
  const RATE = 11.45237
  const ctx = (supabase: unknown) => ({
    supabase: supabase as never,
    companyId: 'company-1',
    userId: 'user-1',
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  })
  const eurInvoice = {
    id: 'inv-1',
    status: 'registered',
    registration_journal_entry_id: 'je-1',
    default_dimensions: {},
    currency: 'EUR',
    exchange_rate: RATE,
  }
  const eurItem = (id: string, account_number: string, line_total: number) => ({
    id,
    account_number,
    line_total,
    description: `Rad ${id}`,
    dimensions: {},
    vat_rate: 0.25,
    vat_amount: Math.round(line_total * 0.25 * 100) / 100,
    sort_order: 0,
  })

  /** The registration verifikat the real generator books for these items. */
  async function registrationLines(items: ReturnType<typeof eurItem>[]) {
    const { supabase } = createTableMockSupabase({ fiscal_periods: { data: [{ id: 'fp-1' }] } })
    const input = await buildSupplierInvoiceRegistrationEntryInput(
      supabase as never,
      'company-1',
      {
        ...eurInvoice,
        supplier_invoice_number: 'F-1',
        arrival_number: 7,
        invoice_date: '2026-09-01',
        reverse_charge: false,
        vat_treatment: 'standard_25',
        total: items.reduce((s, i) => s + i.line_total + i.vat_amount, 0),
      } as unknown as SupplierInvoice,
      items as unknown as SupplierInvoiceItem[],
      'swedish_business',
      'Leverantör AB',
    )
    return input!.lines.map((l, index) => ({ id: `l${index}`, ...l, dimensions: l.dimensions ?? {} }))
  }
  const bookedOn = (lines: Array<{ account_number: string; debit_amount: number }>, account: string) =>
    lines.find((l) => l.account_number === account)!.debit_amount

  beforeEach(() => {
    vi.clearAllMocks()
    strikeLines.mockResolvedValue({ ok: true, data: {} })
  })

  it('exact: strikes and re-adds the kronor the registration booked for the line', async () => {
    const itemA = eurItem('a', '6110', 100.5)
    const verifikat = await registrationLines([itemA, eurItem('b', '6540', 25)])
    const { supabase } = createTableMockSupabase({
      supplier_invoices: { data: eurInvoice },
      supplier_invoice_items: [{ data: itemA }, { data: [{ id: 'a' }] }],
      journal_entry_lines: { data: verifikat },
    })

    const outcome = await moveSupplierInvoiceItemAccount(ctx(supabase), 'inv-1', 'a', '6550')

    expect(outcome).toEqual({ ok: true, data: { changed: true, corrected: true } })
    const booked6110 = bookedOn(verifikat, '6110')
    expect(booked6110).toBe(1150.96) // 100.50 EUR at 11.45237, rounded to the öre
    const { strike_line_ids, lines } = strikeLines.mock.calls[0][2]
    expect(strike_line_ids).toEqual([verifikat.find((l) => l.account_number === '6110')!.id])
    expect(lines).toEqual([expect.objectContaining({ account_number: '6550', debit_amount: booked6110, credit_amount: 0 })])
  })

  it('aggregate: the split moves exactly what the registration books for the line alone', async () => {
    const itemA = eurItem('a', '6110', 100.5)
    const itemC = eurItem('c', '6110', 40)
    const verifikat = await registrationLines([itemA, itemC])
    const { supabase } = createTableMockSupabase({
      supplier_invoices: { data: eurInvoice },
      supplier_invoice_items: [{ data: itemA }, { data: [{ id: 'a' }] }],
      journal_entry_lines: { data: verifikat },
    })

    await moveSupplierInvoiceItemAccount(ctx(supabase), 'inv-1', 'a', '6550')

    // Parity with the generator itself: what it books for A alone moves, what
    // it books for C alone stays.
    const aloneA = bookedOn(await registrationLines([itemA]), '6110')
    const aloneC = bookedOn(await registrationLines([itemC]), '6110')
    const { lines } = strikeLines.mock.calls[0][2]
    expect(lines).toEqual([
      expect.objectContaining({ account_number: '6110', debit_amount: aloneC }),
      expect.objectContaining({ account_number: '6550', debit_amount: aloneA }),
    ])
    expect(Math.round((aloneA + aloneC) * 100) / 100).toBe(bookedOn(verifikat, '6110'))
  })

  it('refuses a verifikat-booked invoice whose rate cannot be determined, writing nothing', async () => {
    const { supabase, findCalls } = createTableMockSupabase({
      supplier_invoices: { data: { ...eurInvoice, exchange_rate: null } },
      supplier_invoice_items: { data: eurItem('a', '6110', 100.5) },
    })

    const outcome = await moveSupplierInvoiceItemAccount(ctx(supabase), 'inv-1', 'a', '6550')
    const preview = await moveSupplierInvoiceItemAccount(ctx(supabase), 'inv-1', 'a', '6550', { dryRun: true })

    expect(outcome).toMatchObject({ ok: false, code: 'SI_ITEM_ACCOUNT_FX_RATE_UNKNOWN' })
    expect(preview).toMatchObject({ ok: false, code: 'SI_ITEM_ACCOUNT_FX_RATE_UNKNOWN' })
    expect(findCalls('supplier_invoice_items', 'update')).toEqual([])
    expect(strikeLines).not.toHaveBeenCalled()
  })

  it('an invoice with no verifikat yet still moves the line (no kronor to match)', async () => {
    const { supabase } = createTableMockSupabase({
      supplier_invoices: { data: { ...eurInvoice, exchange_rate: null, registration_journal_entry_id: null } },
      supplier_invoice_items: [{ data: eurItem('a', '6110', 100.5) }, { data: [{ id: 'a' }] }],
    })

    expect(await moveSupplierInvoiceItemAccount(ctx(supabase), 'inv-1', 'a', '6550')).toEqual({
      ok: true,
      data: { changed: true, corrected: false },
    })
  })

  it('a SEK invoice moves line_total exactly as before, whatever rate is on file', async () => {
    const { supabase } = createTableMockSupabase({
      supplier_invoices: { data: { ...eurInvoice, currency: 'SEK', exchange_rate: 1.5 } },
      supplier_invoice_items: [{ data: eurItem('a', '6110', 499.99) }, { data: [{ id: 'a' }] }],
      journal_entry_lines: { data: [line('l1', '6110', 499.99), line('l2', '2641', 125)] },
    })

    await moveSupplierInvoiceItemAccount(ctx(supabase), 'inv-1', 'a', '6550')

    expect(strikeLines.mock.calls[0][2]).toEqual({
      strike_line_ids: ['l1'],
      lines: [{ account_number: '6550', debit_amount: 499.99, credit_amount: 0, line_description: 'Leverantörsfaktura F-1', dimensions: {} }],
    })
  })
})
