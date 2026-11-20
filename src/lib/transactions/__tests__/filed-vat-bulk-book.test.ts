/**
 * The question before a new samlingsverifikat dated in a filed momsperiod
 * (../filed-vat-bulk-book.ts): a link asks nothing, the cheap date question
 * comes first, the booking's own dry run runs only for rows dated in a filed
 * period, and the VAT block's check is asked about the lines that dry run
 * built.
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
const core = vi.hoisted(() => ({ bulkBookTransactions: vi.fn() }))
vi.mock('../bulk-book', () => core)
const lock = vi.hoisted(() => ({ checkPeriodLock: vi.fn() }))
vi.mock('@/lib/api/v1/check-period-lock', () => lock)

import { filedPeriodBulkBookWarning } from '../filed-vat-bulk-book'
import { filedVatPeriodsOfDates } from '@/lib/vat/filed-period-for-date'

const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as Logger
const TX1 = '11111111-1111-4111-8111-111111111111'
const TX2 = '22222222-2222-4222-8222-222222222222'
const BODY = { tx_ids: [TX1, TX2], template_id: 'tpl-1', mode: 'sum_per_account', entry_description: 'Kortköp' } as never
const LINES = [
  { account_number: '6540', account_name: 'IT-tjänster', debit_amount: 800, credit_amount: 0, currency: 'SEK' },
  { account_number: '2641', account_name: 'Ingående moms', debit_amount: 200, credit_amount: 0, currency: 'SEK' },
  { account_number: '1930', account_name: 'Företagskonto', debit_amount: 0, credit_amount: 1000, currency: 'SEK' },
]
const WARNING = { code: 'VAT_PERIOD_ALREADY_FILED', message_sv: 'sv', message_en: 'en', details: {} }

function db(rows: Array<{ date: string | null }>, error: { message: string } | null = null) {
  const read = vi.fn(async (..._query: unknown[]) => ({ data: error ? null : rows, error }))
  const client = {
    from: (table: string) => ({
      select: (columns: string) => ({
        in: (c1: string, v1: string[]) => ({
          eq: (c2: string, v2: string) => read(table, columns, { [c1]: v1, [c2]: v2 }),
        }),
      }),
    }),
  } as unknown as SupabaseClient
  return { client, read }
}
const ctx = (client: SupabaseClient) => ({ supabase: client, companyId: 'c-1', userId: 'user-1', log })

beforeEach(() => {
  vi.clearAllMocks()
  filed.dates = new Set(['2026-09-27'])
  filed.fail = false
  core.bulkBookTransactions.mockResolvedValue({
    ok: true,
    dryRun: true,
    preview: { mode: 'create_new', tx_date: '2026-09-27', lines: LINES },
  })
  leaf.filedPeriodVoucherWarning.mockResolvedValue(WARNING)
  lock.checkPeriodLock.mockResolvedValue({ locked: false })
})

describe('filedPeriodBulkBookWarning', () => {
  it('asks about the lines the samlingsverifikat would post, on the rows\' date, as a booking', async () => {
    const { client, read } = db([{ date: '2026-09-27' }, { date: '2026-09-27' }])
    const context = ctx(client)

    expect(await filedPeriodBulkBookWarning(context, BODY)).toBe(WARNING)

    expect(read).toHaveBeenCalledWith('transactions', 'date', { id: [TX1, TX2], company_id: 'c-1' })
    expect(core.bulkBookTransactions).toHaveBeenCalledWith(context, BODY, { dryRun: true })
    expect(leaf.filedPeriodVoucherWarning).toHaveBeenCalledWith(
      client,
      'c-1',
      {
        entry_date: '2026-09-27',
        lines: [
          { account_number: '6540', debit_amount: 800, credit_amount: 0 },
          { account_number: '2641', debit_amount: 200, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
        ],
      },
      'booking',
    )
  })

  it('asks nothing about rows linked to a verifikat already posted, and reads nothing', async () => {
    const { client, read } = db([{ date: '2026-09-27' }])

    expect(
      await filedPeriodBulkBookWarning(ctx(client), { tx_ids: [TX1], existing_journal_entry_id: 'je-1' } as never),
    ).toBeNull()

    expect(read).not.toHaveBeenCalled()
    expect(filedVatPeriodsOfDates).not.toHaveBeenCalled()
    expect(core.bulkBookTransactions).not.toHaveBeenCalled()
  })

  it('pays for no dry run when the rows are dated in no filed period', async () => {
    const { client } = db([{ date: '2026-10-20' }, { date: '2026-10-20' }])

    expect(await filedPeriodBulkBookWarning(ctx(client), BODY)).toBeNull()

    expect(core.bulkBookTransactions).not.toHaveBeenCalled()
    expect(leaf.filedPeriodVoucherWarning).not.toHaveBeenCalled()
  })

  it('asks nothing about rows of several dates: the booking itself refuses them', async () => {
    const { client } = db([{ date: '2026-09-27' }, { date: '2026-09-28' }])

    expect(await filedPeriodBulkBookWarning(ctx(client), BODY)).toBeNull()

    expect(filedVatPeriodsOfDates).not.toHaveBeenCalled()
    expect(core.bulkBookTransactions).not.toHaveBeenCalled()
  })

  it('asks nothing about a filed period that is also locked: the lock refuses the booking, and no dry run is paid for', async () => {
    const { client } = db([{ date: '2026-09-27' }])
    lock.checkPeriodLock.mockResolvedValue({ locked: true, reason: 'company_lock_date_covers' })

    expect(await filedPeriodBulkBookWarning(ctx(client), BODY)).toBeNull()

    expect(lock.checkPeriodLock).toHaveBeenCalledWith(client, 'c-1', '2026-09-27')
    expect(core.bulkBookTransactions).not.toHaveBeenCalled()
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('logs a dry run that failed on a read, which would otherwise let the booking through unasked and unseen', async () => {
    const { client } = db([{ date: '2026-09-27' }])
    core.bulkBookTransactions.mockResolvedValue({ ok: false, code: 'UNKNOWN_ERROR', error: new Error('cash accounts unreadable') })

    expect(await filedPeriodBulkBookWarning(ctx(client), BODY)).toBeNull()

    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ error: 'cash accounts unreadable' }))
  })

  it('asks nothing when the booking would be refused: the booking says why', async () => {
    const { client } = db([{ date: '2026-09-27' }])
    core.bulkBookTransactions.mockResolvedValue({ ok: false, code: 'TRANSACTION_BOOK_POSSIBLE_DUPLICATE' })

    expect(await filedPeriodBulkBookWarning(ctx(client), BODY)).toBeNull()
    expect(leaf.filedPeriodVoucherWarning).not.toHaveBeenCalled()
    // An ordinary refusal is the booking's to tell, not a failed check.
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('asks nothing when the dry run states no lines', async () => {
    const { client } = db([{ date: '2026-09-27' }])
    core.bulkBookTransactions.mockResolvedValue({ ok: true, dryRun: true, preview: { mode: 'create_new', lines: [] } })

    expect(await filedPeriodBulkBookWarning(ctx(client), BODY)).toBeNull()
    expect(leaf.filedPeriodVoucherWarning).not.toHaveBeenCalled()
  })

  it.each([
    ['the rows cannot be read', () => db([], { message: 'boom' }).client, () => undefined],
    ['the filing record cannot be read', () => db([{ date: '2026-09-27' }]).client, () => { filed.fail = true }],
    ['the lock cannot be read', () => db([{ date: '2026-09-27' }]).client, () => { lock.checkPeriodLock.mockRejectedValue(new Error('boom')) }],
    ['the dry run throws', () => db([{ date: '2026-09-27' }]).client, () => { core.bulkBookTransactions.mockRejectedValue(new Error('boom')) }],
    ['the check throws', () => db([{ date: '2026-09-27' }]).client, () => { leaf.filedPeriodVoucherWarning.mockRejectedValue(new Error('boom')) }],
  ])('never stops a booking when %s (logged, no warning)', async (_name, client, arrange) => {
    arrange()

    expect(await filedPeriodBulkBookWarning(ctx(client()), BODY)).toBeNull()
    expect(log.warn).toHaveBeenCalledTimes(1)
  })
})
