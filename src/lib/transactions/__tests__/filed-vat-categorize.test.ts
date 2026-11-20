/**
 * The question before a category booking of a bank row in a filed
 * momsperiod (../filed-vat-categorize.ts): the cheap date question first, the
 * booking's own dry run only for a row dated in a filed period, and the VAT
 * block's check asked about the lines that dry run built.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'

const filed = vi.hoisted(() => ({ dates: new Set<string>(), fail: false }))
vi.mock('@/lib/vat/filed-period-for-date', () => ({
  filedVatPeriodsOfDates: vi.fn(async (_s: unknown, _c: unknown, dates: readonly string[]) => {
    if (filed.fail) throw new Error('deadlines unreadable')
    const q3 = { tax_period: '2026-Q3', period_start: '2026-07-01', period_end: '2026-09-30', filed_on: '2026-11-11' }
    return new Map(dates.filter((d) => filed.dates.has(d)).map((d) => [d, q3]))
  }),
}))
const leaf = vi.hoisted(() => ({ filedPeriodVoucherWarning: vi.fn() }))
vi.mock('@/lib/vat/voucher-filed-period-warning', () => leaf)
const core = vi.hoisted(() => ({ categorizeTransaction: vi.fn() }))
vi.mock('../categorize-core', () => core)

import { filedPeriodCategorizeWarning } from '../filed-vat-categorize'

const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as Logger
const BOOKING = { is_business: true, category: 'expense_software' } as never
const LINES = [
  { account_number: '6540', debit_amount: 400, credit_amount: 0, line_description: 'Loopia' },
  { account_number: '2641', debit_amount: 100, credit_amount: 0 },
  { account_number: '1930', debit_amount: 0, credit_amount: 500 },
]
const WARNING = { code: 'VAT_PERIOD_ALREADY_FILED', message_sv: 'sv', message_en: 'en', details: {} }

function db(row: { date: string } | null, error: { message: string } | null = null) {
  const read = vi.fn(async (..._query: unknown[]) => ({ data: row, error }))
  const client = {
    from: (table: string) => ({
      select: (columns: string) => ({
        eq: (c1: string, v1: string) => ({
          eq: (c2: string, v2: string) => ({ maybeSingle: () => read(table, columns, { [c1]: v1, [c2]: v2 }) }),
        }),
      }),
    }),
  } as unknown as SupabaseClient
  return { client, read }
}
const ask = (client: SupabaseClient, options: { withoutReview?: boolean } = {}) =>
  filedPeriodCategorizeWarning(client, 'user-1', 'c-1', 'tx-1', BOOKING, { onBooked: 'update_flags', ...options, log })

beforeEach(() => {
  vi.clearAllMocks()
  filed.dates = new Set(['2026-09-27'])
  filed.fail = false
  core.categorizeTransaction.mockResolvedValue({
    ok: true,
    dryRun: true,
    preview: { lines: LINES, would_create_journal_entry: true },
  })
  leaf.filedPeriodVoucherWarning.mockResolvedValue(WARNING)
})

describe('filedPeriodCategorizeWarning', () => {
  it('asks about the lines the booking would post, on the row\'s own date, as a bank row', async () => {
    const { client, read } = db({ date: '2026-09-27' })

    expect(await ask(client)).toBe(WARNING)

    expect(read).toHaveBeenCalledWith('transactions', 'date', { id: 'tx-1', company_id: 'c-1' })
    expect(core.categorizeTransaction).toHaveBeenCalledWith(client, 'user-1', 'c-1', 'tx-1', BOOKING, {
      onBooked: 'update_flags',
      dryRun: true,
      log,
    })
    expect(leaf.filedPeriodVoucherWarning).toHaveBeenCalledWith(
      client,
      'c-1',
      {
        entry_date: '2026-09-27',
        lines: [
          { account_number: '6540', debit_amount: 400, credit_amount: 0 },
          { account_number: '2641', debit_amount: 100, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 500 },
        ],
      },
      'bank_row',
    )
  })

  it('builds the lines as a selection would book them when the row is one of a selection', async () => {
    await ask(db({ date: '2026-09-27' }).client, { withoutReview: true })

    expect(core.categorizeTransaction).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'c-1', 'tx-1', BOOKING,
      { onBooked: 'update_flags', withoutReview: true, dryRun: true, log },
    )
  })

  it('builds the lines with the booking options it is handed, and speaks of what it is told to (Inkorgen\'s Bokför valda)', async () => {
    const { client } = db({ date: '2026-09-27' })
    const exclude = { excludeTransactionIds: ['tx-0'], excludeJournalEntryIds: ['je-0'] }
    const loadChart = vi.fn()

    await filedPeriodCategorizeWarning(client, 'user-1', 'c-1', 'tx-1', BOOKING, {
      onBooked: 'refuse',
      exclude,
      loadChart: loadChart as never,
      invoiceMatchIntercept: false,
      withoutReview: true,
      subject: 'booking',
      log,
    })

    expect(core.categorizeTransaction).toHaveBeenCalledWith(client, 'user-1', 'c-1', 'tx-1', BOOKING, {
      onBooked: 'refuse',
      exclude,
      loadChart,
      invoiceMatchIntercept: false,
      withoutReview: true,
      dryRun: true,
      log,
    })
    expect(leaf.filedPeriodVoucherWarning).toHaveBeenCalledWith(client, 'c-1', expect.objectContaining({ entry_date: '2026-09-27' }), 'booking')
  })

  it('pays for no dry run when the row is dated in no filed period', async () => {
    expect(await ask(db({ date: '2026-10-20' }).client)).toBeNull()

    expect(core.categorizeTransaction).not.toHaveBeenCalled()
    expect(leaf.filedPeriodVoucherWarning).not.toHaveBeenCalled()
  })

  it('asks nothing when the booking would be refused or would post nothing: the booking says that itself', async () => {
    const { client } = db({ date: '2026-09-27' })
    core.categorizeTransaction.mockResolvedValueOnce({ ok: false, code: 'TX_CATEGORIZE_SUGGEST_SI_MATCH' })
    expect(await ask(client)).toBeNull()

    core.categorizeTransaction.mockResolvedValueOnce({
      ok: true,
      dryRun: true,
      preview: { lines: LINES, would_create_journal_entry: false },
    })
    expect(await ask(client)).toBeNull()
    expect(leaf.filedPeriodVoucherWarning).not.toHaveBeenCalled()
  })

  it('asks nothing of a row that is not there', async () => {
    expect(await ask(db(null).client)).toBeNull()
    expect(core.categorizeTransaction).not.toHaveBeenCalled()
  })

  it('never stops a booking when the check cannot be made: the row, the filing record, the dry run or the check itself', async () => {
    expect(await ask(db(null, { message: 'transactions unreadable' }).client)).toBeNull()

    filed.fail = true
    expect(await ask(db({ date: '2026-09-27' }).client)).toBeNull()
    filed.fail = false

    core.categorizeTransaction.mockRejectedValueOnce(new Error('mapping failed'))
    expect(await ask(db({ date: '2026-09-27' }).client)).toBeNull()

    leaf.filedPeriodVoucherWarning.mockRejectedValueOnce(new Error('voucher VAT impact unavailable'))
    expect(await ask(db({ date: '2026-09-27' }).client)).toBeNull()

    expect(log.warn).toHaveBeenCalledTimes(4)
  })
})
