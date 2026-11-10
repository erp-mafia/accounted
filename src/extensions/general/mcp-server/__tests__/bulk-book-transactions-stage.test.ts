/**
 * Staging gnubok_bulk_book_transactions, generated from the operation
 * transactions.bulk-book (lib/operations/transactions.ts). The staging dry
 * run is the service's own (lib/transactions/bulk-book.ts), so a template
 * booking, which the hand-written tool could not stage, works the same way
 * it does through v1 and the dashboard, and the link to an existing
 * verifikat reports the period of the later of the two dates.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { detectBookingDuplicate } from '@/lib/transactions/booking-duplicate-detection'
import { tools } from '../server'

// Booking review rules (accounted#130): none in these tests; the queued mock
// would otherwise hand their read a response queued for the operation.
vi.mock('@/lib/booking-review/rules', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/booking-review/rules')>()),
  loadActiveBookingReviewRules: vi.fn(async () => []),
}))
vi.mock('@/lib/transactions/booking-duplicate-detection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/transactions/booking-duplicate-detection')>()
  return { ...actual, detectBookingDuplicate: vi.fn() }
})

const bulkBook = tools.find((t) => t.name === 'gnubok_bulk_book_transactions')!

const TX_1 = '11111111-1111-4111-8111-111111111111'
const TX_2 = '22222222-2222-4222-8222-222222222222'
const JE = '33333333-3333-4333-8333-333333333333'
const TEMPLATE = '44444444-4444-4444-8444-444444444444'

const rows = [
  { id: TX_1, amount: 100, currency: 'SEK', description: 'Swish 0701', merchant_name: null, date: '2026-05-12', journal_entry_id: null },
  { id: TX_2, amount: 150, currency: 'SEK', description: 'Swish 0702', merchant_name: null, date: '2026-05-12', journal_entry_id: null },
]

/** A posted verifikat whose 1930 leg moves by `sum`: the bank net a link of rows summing to it needs. */
const bankLegOf = (sum: number) => [
  { account_number: '1930', debit_amount: Math.max(sum, 0), credit_amount: Math.max(-sum, 0) },
  { account_number: '6570', debit_amount: Math.max(-sum, 0), credit_amount: Math.max(sum, 0) },
]

type Staged = { staged: boolean; preview: Record<string, unknown> }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(detectBookingDuplicate).mockResolvedValue(null)
})

describe('gnubok_bulk_book_transactions: staged from the operation', () => {
  it('stages a template booking on the summed amount, named on the approval card', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: rows, error: null }) // transactions
    enqueue({ data: [], error: null }) // the gate: no posted verifikat booked from the rows (#203)
    enqueue({
      data: {
        id: TEMPLATE,
        name: 'Swish-försäljning',
        is_active: true,
        is_system: true,
        company_id: null,
        team_id: null,
        lines: [
          { account: '1930', label: 'Bank', side: 'debit', type: 'settlement' },
          { account: '3001', label: 'Försäljning', side: 'credit', type: 'business' },
        ],
      },
      error: null,
    }) // booking_template_library
    enqueue({
      data: [
        { account_number: '1930', is_active: true },
        { account_number: '3001', is_active: true },
      ],
      error: null,
    }) // chart_of_accounts: the template's accounts are active
    enqueue({ data: [], error: null }) // account_dimension_rules
    enqueue({ data: [], error: null }) // the rows' ledger: no cash account, 1930
    enqueue({
      data: [
        { account_number: '1930', account_name: 'Företagskonto' },
        { account_number: '3001', account_name: 'Försäljning varor 25 %' },
      ],
      error: null,
    }) // chart_of_accounts names
    enqueue({ data: null, error: null }) // resolvePeriodStatusForDate: 2 layers
    enqueue({ data: null, error: null })
    enqueue({ data: [], error: null }) // open operations on these rows: none (crm#1264)
    enqueue({ data: { id: 'op-bulk-tpl' }, error: null }) // pending_operations insert

    const result = (await bulkBook.execute(
      { tx_ids: [TX_1, TX_2], template_id: TEMPLATE, mode: 'sum_per_account', entry_description: 'Swish 2026-05-12' },
      'company-1',
      'user-1',
      supabase as never,
    )) as Staged

    expect(result.staged).toBe(true)
    expect(result.preview).toMatchObject({
      tx_count: 2,
      tx_date: '2026-05-12',
      tx_sum: 250,
      direction: 'income',
      mode: 'create_new',
      entry_description: 'Swish 2026-05-12',
    })
    const lines = result.preview.lines as Array<Record<string, unknown>>
    expect(lines.map((l) => [l.account_number, l.account_name])).toEqual([
      ['1930', 'Företagskonto'],
      ['3001', 'Försäljning varor 25 %'],
    ])
    // Aggregate-only preview: no per-row text.
    expect(result.preview).not.toHaveProperty('lead_description')
    const inserted = findCall('pending_operations', 'insert')?.[0] as Record<string, unknown>
    expect(inserted.operation_type).toBe('bulk_book_transactions')
    expect(inserted.title).toMatch(/^Samlingsverifikation \+250,00 SEK 2026-05-12: Swish 0701 \(\+1 till\)$/)
    expect(inserted.params).toEqual({
      tx_ids: [TX_1, TX_2],
      template_id: TEMPLATE,
      mode: 'sum_per_account',
      entry_description: 'Swish 2026-05-12',
    })
  })

  it('links to an existing verifikat and reports the period of the later date', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: rows, error: null }) // transactions
    enqueue({ data: { id: JE, status: 'posted', entry_date: '2026-06-02', journal_entry_lines: bankLegOf(250) }, error: null }) // link target
    enqueue({ data: [], error: null }) // the rows' ledger: no cash account, 1930
    enqueue({ data: null, error: null }) // resolvePeriodStatusForDate: 2 layers
    enqueue({ data: null, error: null })
    enqueue({ data: [], error: null }) // open operations on these rows: none (crm#1264)
    enqueue({ data: { id: 'op-bulk-link' }, error: null }) // pending_operations insert

    await bulkBook.execute(
      { tx_ids: [TX_1, TX_2], existing_journal_entry_id: JE },
      'company-1',
      'user-1',
      supabase as never,
    )

    expect(findCall('fiscal_periods', 'lte')).toEqual(['period_start', '2026-06-02'])
    const inserted = findCall('pending_operations', 'insert')?.[0] as Record<string, unknown>
    expect(inserted.title).toMatch(/^Länka 2 transaktioner \+250,00 SEK 2026-05-12 till verifikat: Swish 0701/)
  })

  it('links rows of several dates (a month of Stripe fee rows) to one posted verifikat', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({
      data: [
        { ...rows[0], amount: -3.25, description: 'Stripe-avgift', date: '2026-09-03' },
        { ...rows[1], amount: -12, description: 'Stripe: Billing - Usage Fee', date: '2026-10-02' },
      ],
      error: null,
    }) // transactions
    enqueue({ data: { id: JE, status: 'posted', entry_date: '2026-09-30', journal_entry_lines: bankLegOf(-15.25) }, error: null }) // link target
    enqueue({ data: [], error: null }) // the rows' ledger: no cash account, 1930
    enqueue({ data: null, error: null }) // resolvePeriodStatusForDate: 2 layers
    enqueue({ data: null, error: null })
    enqueue({ data: [], error: null }) // open operations on these rows: none (crm#1264)
    enqueue({ data: { id: 'op-bulk-link-month' }, error: null }) // pending_operations insert

    const result = (await bulkBook.execute(
      { tx_ids: [TX_1, TX_2], existing_journal_entry_id: JE },
      'company-1',
      'user-1',
      supabase as never,
    )) as Staged

    expect(result.staged).toBe(true)
    expect(result.preview).toMatchObject({
      tx_count: 2,
      tx_date: '2026-09-03',
      tx_date_to: '2026-10-02',
      tx_sum: -15.25,
      direction: 'expense',
      mode: 'link_existing',
    })
    // The period of the latest row, which here is later than the verifikat.
    expect(findCall('fiscal_periods', 'lte')).toEqual(['period_start', '2026-10-02'])
    const inserted = findCall('pending_operations', 'insert')?.[0] as Record<string, unknown>
    expect(inserted.title).toMatch(/^Länka 2 transaktioner -15,25 SEK 2026-09-03 t\.o\.m\. 2026-10-02 till verifikat: Stripe-avgift/)
  })

  it('still refuses rows of several dates for a new samlingsverifikat, before staging', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: [rows[0], { ...rows[1], date: '2026-05-13' }], error: null })

    await expect(
      bulkBook.execute(
        {
          tx_ids: [TX_1, TX_2],
          entry_description: 'Swish',
          manual_lines: [
            { account_number: '1930', debit_amount: 250, credit_amount: 0, currency: 'SEK' },
            { account_number: '3001', debit_amount: 0, credit_amount: 250, currency: 'SEK' },
          ],
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toMatchObject({ code: 'BULK_BOOK_DATE_MISMATCH' })
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('refuses a row that already has a verifikat, before staging', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: [rows[0], { ...rows[1], journal_entry_id: 'je-other' }], error: null })

    await expect(
      bulkBook.execute({ tx_ids: [TX_1, TX_2], existing_journal_entry_id: JE }, 'company-1', 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'BULK_BOOK_TX_ALREADY_BOOKED' })
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })
})
