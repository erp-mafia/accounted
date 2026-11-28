import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { getActor } from '@/lib/bookkeeping/actor-context'
import type { ResultAppropriationPlan } from '@/lib/core/bookkeeping/result-appropriation-service'
import type { OpeningBalanceDifference } from '../types'

const service = vi.hoisted(() => ({ plan: vi.fn(), post: vi.fn() }))
vi.mock('@/lib/core/bookkeeping/result-appropriation-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/core/bookkeeping/result-appropriation-service')>()),
  planResultAppropriation: service.plan,
  postResultAppropriation: service.post,
}))
vi.mock('@/lib/bookkeeping/entry-lines', () => ({ fetchEntryLines: vi.fn() }))

import { fetchEntryLines } from '@/lib/bookkeeping/entry-lines'
import { bookFileResultTransfer, fileResultTransfer, resultTransferNotice } from '../sie-result-transfer'

/**
 * A year imported on top of the year before opens with last year's result on
 * 2099, while the file's #IB has moved it to 2091 or 2098. The import books
 * the year-end's omföring when that move is all that differs, and nothing
 * when anything else differs too.
 */

const AB = { result: '2099', carry: '2098', retained: '2091' }

// The books carry a profit of 48 211,37 on 2099; the file has it on 2091.
const PROFIT_ON_2091: OpeningBalanceDifference[] = [
  { account: '2091', file: -48211.37, books: 0, difference: 48211.37 },
  { account: '2099', file: 0, books: -48211.37, difference: -48211.37 },
]
// A loss of 591,64 the file carries on 2098.
const LOSS_ON_2098: OpeningBalanceDifference[] = [
  { account: '2098', file: 1204.5, books: 0, difference: -1204.5 },
  { account: '2099', file: 0, books: 1204.5, difference: 1204.5 },
]

describe('fileResultTransfer', () => {
  it('reads a profit the file carries on balanserat resultat', () => {
    expect(fileResultTransfer(PROFIT_ON_2091, AB)).toEqual({ to: 'retained', account: '2091', net: 48211.37 })
  })

  it('reads a loss the file carries on 2098', () => {
    expect(fileResultTransfer(LOSS_ON_2098, AB)).toEqual({ to: 'carry', account: '2098', net: -1204.5 })
  })

  it('reads part of 2099 moved when the file keeps the rest there', () => {
    // The file keeps this year's carry on 2099 and moves it by a voucher; the
    // books carry an older year on top, which the file has on 2098.
    const partial = [
      { account: '2098', file: 2000, books: -7000, difference: -9000 },
      { account: '2099', file: 6000, books: 15000, difference: 9000 },
    ]
    expect(fileResultTransfer(partial, AB)).toEqual({ to: 'carry', account: '2098', net: -9000 })
  })

  it('reads nothing when another account differs too: a revised closing is not an omföring', () => {
    const revised = [...PROFIT_ON_2091, { account: '1930', file: 5000, books: 4500, difference: -500 }]
    expect(fileResultTransfer(revised, AB)).toBeNull()
  })

  it('reads nothing when the two amounts do not cancel', () => {
    expect(fileResultTransfer([PROFIT_ON_2091[0], { ...PROFIT_ON_2091[1], difference: -205000 }], AB)).toBeNull()
  })

  it('reads nothing when the other account is not where a result is carried', () => {
    const elsewhere = [
      { account: '2099', file: 0, books: -1000, difference: -1000 },
      { account: '2440', file: -1000, books: 0, difference: 1000 },
    ]
    expect(fileResultTransfer(elsewhere, AB)).toBeNull()
  })

  it('reads nothing without a difference on the result account', () => {
    const disposition = [
      { account: '2091', file: -1000, books: 0, difference: 1000 },
      { account: '2098', file: 0, books: -1000, difference: -1000 },
    ]
    expect(fileResultTransfer(disposition, AB)).toBeNull()
    expect(fileResultTransfer([PROFIT_ON_2091[1]], AB)).toBeNull()
  })
})

const plan = (overrides: Partial<ResultAppropriationPlan> = {}): ResultAppropriationPlan => ({
  periodId: 'period-2026',
  periodName: '2026',
  periodStart: '2026-01-01',
  resultAccount: '2099',
  priorResultAccount: '2091',
  net: 48211.37,
  amount: 48211.37,
  direction: 'profit',
  lines: [
    { account_number: '2099', debit_amount: 48211.37, credit_amount: 0 },
    { account_number: '2091', debit_amount: 0, credit_amount: 48211.37 },
  ],
  ...overrides,
})

/** Lines of a live omföring in the period, as fetchEntryLines returns them. */
function omforing(id: string, voucher: number, lines: Array<[string, number, number]>) {
  return lines.map(([account_number, debit_amount, credit_amount]) => ({
    journal_entry_id: id, account_number, debit_amount, credit_amount,
    journal_entries: { id, voucher_series: 'A', voucher_number: voucher, entry_date: '2026-01-01' },
  }))
}

const SUBMITTER = { type: 'user' as const, userId: 'user-1' }

function input(differences: OpeningBalanceDifference[], actor: typeof SUBMITTER | null = SUBMITTER) {
  return { companyId: 'company-1', fiscalPeriodId: 'period-2026', userId: 'user-1', actor, differences }
}

describe('bookFileResultTransfer', () => {
  let mock: ReturnType<typeof createTableMockSupabase>
  let supabase: SupabaseClient

  beforeEach(() => {
    vi.clearAllMocks()
    mock = createTableMockSupabase({ companies: { data: { entity_type: 'aktiebolag' } } })
    supabase = mock.supabase as unknown as SupabaseClient
    vi.mocked(fetchEntryLines).mockResolvedValue([])
    service.plan.mockResolvedValue(plan())
    service.post.mockResolvedValue({ id: 'entry-1', voucher_series: 'A', voucher_number: 1 })
  })

  it('books the year-end\'s omföring onto the file\'s account, for the submitter, and names it', async () => {
    let actorWhilePosting: unknown
    service.post.mockImplementation(async () => {
      actorWhilePosting = getActor()
      return { id: 'entry-1', voucher_series: 'A', voucher_number: 1 }
    })

    const transfer = await bookFileResultTransfer(supabase, input(PROFIT_ON_2091))

    expect(service.plan).toHaveBeenCalledWith(supabase, 'company-1', 'period-2026', { to: 'retained' })
    expect(service.post).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', plan())
    expect(actorWhilePosting).toEqual(SUBMITTER)
    expect(transfer).toEqual({ entryId: 'entry-1', voucher: 'A1', date: '2026-01-01', from: '2099', to: '2091', amount: 48211.37 })
  })

  it('books nothing when the year-end would move another amount: the file\'s own voucher moved part of it', async () => {
    service.plan.mockResolvedValue(plan({ net: 5016.04, amount: 5016.04 }))

    expect(await bookFileResultTransfer(supabase, input(PROFIT_ON_2091))).toBeNull()
    expect(service.post).not.toHaveBeenCalled()
  })

  it('books nothing when the year-end has nothing to move', async () => {
    service.plan.mockResolvedValue(null)

    expect(await bookFileResultTransfer(supabase, input(PROFIT_ON_2091))).toBeNull()
    expect(service.post).not.toHaveBeenCalled()
  })

  it('names the omföring the year already has instead of booking a second one', async () => {
    vi.mocked(fetchEntryLines).mockResolvedValue(omforing('entry-9', 7, [['2099', 48211.37, 0], ['2091', 0, 48211.37]]) as never)

    const transfer = await bookFileResultTransfer(supabase, input(PROFIT_ON_2091))

    expect(transfer).toEqual({ entryId: 'entry-9', voucher: 'A7', date: '2026-01-01', from: '2099', to: '2091', amount: 48211.37 })
    expect(service.plan).not.toHaveBeenCalled()
    expect(service.post).not.toHaveBeenCalled()
  })

  it('books nothing and names nothing when the year\'s omföring went elsewhere', async () => {
    // The close moved the result to 2098; the file has it on 2091.
    vi.mocked(fetchEntryLines).mockResolvedValue(omforing('entry-9', 7, [['2099', 48211.37, 0], ['2098', 0, 48211.37]]) as never)

    expect(await bookFileResultTransfer(supabase, input(PROFIT_ON_2091))).toBeNull()
    expect(service.post).not.toHaveBeenCalled()
  })

  it('reads nothing for differences that are not the omföring', async () => {
    const revised = [...PROFIT_ON_2091, { account: '1930', file: 5000, books: 4500, difference: -500 }]

    expect(await bookFileResultTransfer(supabase, input(revised))).toBeNull()
    expect(mock.tables()).toEqual([])
    expect(service.plan).not.toHaveBeenCalled()
  })

  it('books nothing for an enskild firma, which closes straight into 2010', async () => {
    mock.setTable('companies', { data: { entity_type: 'enskild_firma' } })

    expect(await bookFileResultTransfer(supabase, input(PROFIT_ON_2091))).toBeNull()
    expect(service.plan).not.toHaveBeenCalled()
  })

  it('posts in the surrounding scope when the job sealed no submitter', async () => {
    service.plan.mockResolvedValue(plan({
      priorResultAccount: '2098', net: -1204.5, amount: 1204.5, direction: 'loss',
      lines: [
        { account_number: '2098', debit_amount: 1204.5, credit_amount: 0 },
        { account_number: '2099', debit_amount: 0, credit_amount: 1204.5 },
      ],
    }))
    let actorWhilePosting: unknown = 'unset'
    service.post.mockImplementation(async () => {
      actorWhilePosting = getActor()
      return { id: 'entry-1', voucher_series: 'A', voucher_number: 1 }
    })

    expect(await bookFileResultTransfer(supabase, input(LOSS_ON_2098, null))).not.toBeNull()
    expect(service.plan).toHaveBeenCalledWith(supabase, 'company-1', 'period-2026', { to: 'carry' })
    expect(actorWhilePosting).toBeUndefined()
  })

  it('never throws: a refused posting leaves the differences to the warning', async () => {
    service.post.mockRejectedValue(new Error('Accounts not in chart: 2091'))

    expect(await bookFileResultTransfer(supabase, input(PROFIT_ON_2091))).toBeNull()
  })
})

describe('resultTransferNotice', () => {
  it('says what was booked, in the legacy text and its structured twin', () => {
    const told = resultTransferNotice({ entryId: 'entry-1', voucher: 'A1', date: '2026-01-01', from: '2099', to: '2091', amount: 48211.37 })

    expect(told.text).toMatch(/^Föregående års resultat, 48\s211,37\skr, är omfört från konto 2099 till 2091 med verifikation A1 den 2026-01-01/)
    expect(told.notice).toEqual({
      code: 'sie_result_transferred',
      severity: 'info',
      params: { amount: expect.stringMatching(/^48\s211,37\skr$/), from: '2099', to: '2091', voucher: 'A1', date: '2026-01-01' },
    })
  })
})
