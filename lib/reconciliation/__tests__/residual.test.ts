import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const createEntryMock = vi.fn()
const findPeriodMock = vi.fn()
const matchMock = vi.fn()
const unmatchMock = vi.fn()

vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: (...args: unknown[]) => createEntryMock(...args),
  findFiscalPeriod: (...args: unknown[]) => findPeriodMock(...args),
}))
vi.mock('../actions', () => ({
  matchPairs: (...args: unknown[]) => matchMock(...args),
  unmatchLink: (...args: unknown[]) => unmatchMock(...args),
}))

import { bookResidualAndLink, ReconciliationResidualError } from '../residual'

const COMPANY = 'company-1'
const USER = 'user-1'
const CASH = '11111111-1111-4111-8111-111111111111'
const KEY = `bank:${CASH}`
const T1 = '22222222-2222-4222-8222-222222222222'
const E1 = '44444444-4444-4444-8444-444444444444'
const RES = '55555555-5555-4555-8555-555555555555'

function tx(overrides: Record<string, unknown> = {}) {
  return { id: T1, date: '2026-08-05', amount: -1010, description: 'Leverantör AB', journal_entry_id: null, is_ignored: false, cash_account_id: CASH, ...overrides }
}
function entry(net = -1000) {
  return {
    id: E1,
    status: 'posted',
    description: 'Faktura 1234',
    lines: [
      { account_number: '2440', debit_amount: 1000, credit_amount: 0 },
      { account_number: '1930', debit_amount: net > 0 ? net : 0, credit_amount: net < 0 ? -net : 0 },
    ],
  }
}

describe('bookResidualAndLink', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createEntryMock.mockReset()
    findPeriodMock.mockReset()
    matchMock.mockReset()
    unmatchMock.mockReset()
    findPeriodMock.mockResolvedValue('fp-1')
    matchMock.mockResolvedValue({ dry_run: false, considered: 1, applied: [{ external_id: T1, journal_entry_id: E1 }], skipped: [] })
    createEntryMock.mockResolvedValue({ id: RES })
  })

  it('returns null for an unknown account, refuses the skattekonto, refuses an unknown kind', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    expect(await bookResidualAndLink(supabase as never, COMPANY, USER, 'nope', { external_ids: [T1], journal_entry_id: E1, kind: 'bank_fee' })).toBeNull()
    await expect(
      bookResidualAndLink(supabase as never, COMPANY, USER, 'skattekonto', { external_ids: [T1], journal_entry_id: E1, kind: 'bank_fee' }),
    ).rejects.toMatchObject({ code: 'RESIDUAL_UNSUPPORTED_KIND' })
    enqueue({ data: null }) // cash account lookup: unknown for this company
    expect(await bookResidualAndLink(supabase as never, COMPANY, USER, KEY, { external_ids: [T1], journal_entry_id: E1, kind: 'bank_fee' })).toBeNull()
  })

  it('previews a bank fee: expense on 6570 against the bank account, dated on the transaction', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: CASH, ledger_account: '1930', currency: 'SEK' } })
    enqueue({ data: [tx()] })
    enqueue({ data: entry(-1000) })
    const result = await bookResidualAndLink(
      supabase as never,
      COMPANY,
      USER,
      KEY,
      { external_ids: [T1], journal_entry_id: E1, kind: 'bank_fee' },
      { dryRun: true },
    )
    expect(result).toMatchObject({
      dry_run: true,
      would_book: {
        residual_amount: -10,
        counter_account: '6570',
        entry_date: '2026-08-05',
        description: 'Bankavgift: Faktura 1234',
        lines: [
          { account_number: '6570', debit_amount: 10, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 10 },
        ],
      },
    })
    expect(matchMock).not.toHaveBeenCalled()
    expect(createEntryMock).not.toHaveBeenCalled()
  })

  it('links first, then books the residual, then anchors it through the junction', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: CASH, ledger_account: '1930', currency: 'SEK' } })
    enqueue({ data: [tx()] })
    enqueue({ data: entry(-1000) })
    enqueue({ data: null }) // junction insert
    const result = await bookResidualAndLink(supabase as never, COMPANY, USER, KEY, {
      external_ids: [T1],
      journal_entry_id: E1,
      kind: 'bank_fee',
    })
    expect(result).toMatchObject({ dry_run: false, residual_journal_entry_id: RES, residual_amount: -10 })
    expect(matchMock).toHaveBeenCalledWith(supabase, COMPANY, USER, KEY, { pairs: [{ external_ids: [T1], journal_entry_ids: [E1] }] }, { dryRun: false })
    expect(createEntryMock).toHaveBeenCalledWith(
      supabase,
      COMPANY,
      USER,
      expect.objectContaining({ fiscal_period_id: 'fp-1', entry_date: '2026-08-05', source_type: 'manual' }),
    )
    expect(findCall('transaction_voucher_links', 'insert')?.[0]).toMatchObject({
      transaction_id: T1,
      journal_entry_id: RES,
      allocated_amount: -10,
      role: 'other',
    })
  })

  it('refuses a zero residual, a residual above the cap, and a kind in the wrong direction', async () => {
    const { supabase, enqueue, reset } = createQueuedMockSupabase()
    enqueue({ data: { id: CASH, ledger_account: '1930', currency: 'SEK' } })
    enqueue({ data: [tx({ amount: -1000 })] })
    enqueue({ data: entry(-1000) })
    await expect(
      bookResidualAndLink(supabase as never, COMPANY, USER, KEY, { external_ids: [T1], journal_entry_id: E1, kind: 'bank_fee' }),
    ).rejects.toMatchObject({ code: 'RESIDUAL_ZERO' })

    reset()
    enqueue({ data: { id: CASH, ledger_account: '1930', currency: 'SEK' } })
    enqueue({ data: [tx({ amount: -9000 })] })
    enqueue({ data: entry(-1000) })
    await expect(
      bookResidualAndLink(supabase as never, COMPANY, USER, KEY, { external_ids: [T1], journal_entry_id: E1, kind: 'bank_fee' }),
    ).rejects.toMatchObject({ code: 'RESIDUAL_TOO_LARGE' })

    reset()
    enqueue({ data: { id: CASH, ledger_account: '1930', currency: 'SEK' } })
    enqueue({ data: [tx({ amount: 1005 })] })
    enqueue({ data: entry(1000) })
    // The bank received MORE than booked: a bank fee (expense) is the wrong kind.
    await expect(
      bookResidualAndLink(supabase as never, COMPANY, USER, KEY, { external_ids: [T1], journal_entry_id: E1, kind: 'bank_fee' }),
    ).rejects.toMatchObject({ code: 'RESIDUAL_DIRECTION' })
    expect(matchMock).not.toHaveBeenCalled()
  })

  it('books interest income on the income side when the bank received more', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: CASH, ledger_account: '1930', currency: 'SEK' } })
    enqueue({ data: [tx({ amount: 1002.5 })] })
    enqueue({ data: entry(1000) })
    const result = await bookResidualAndLink(
      supabase as never,
      COMPANY,
      USER,
      KEY,
      { external_ids: [T1], journal_entry_id: E1, kind: 'interest_income' },
      { dryRun: true },
    )
    expect(result).toMatchObject({
      dry_run: true,
      would_book: {
        residual_amount: 2.5,
        lines: [
          { account_number: '1930', debit_amount: 2.5, credit_amount: 0 },
          { account_number: '8310', debit_amount: 0, credit_amount: 2.5 },
        ],
      },
    })
  })

  it('undoes the links when the residual booking is refused', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: CASH, ledger_account: '1930', currency: 'SEK' } })
    enqueue({ data: [tx()] })
    enqueue({ data: entry(-1000) })
    createEntryMock.mockRejectedValue(new Error('Perioden är låst'))
    await expect(
      bookResidualAndLink(supabase as never, COMPANY, USER, KEY, { external_ids: [T1], journal_entry_id: E1, kind: 'bank_fee' }),
    ).rejects.toThrow(/låst/)
    expect(unmatchMock).toHaveBeenCalledWith(supabase, COMPANY, USER, KEY, T1)
  })

  it('reports a failed link without booking anything', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: CASH, ledger_account: '1930', currency: 'SEK' } })
    enqueue({ data: [tx()] })
    enqueue({ data: entry(-1000) })
    matchMock.mockResolvedValue({ dry_run: false, considered: 1, applied: [], skipped: [{ pair: { external_ids: [T1], journal_entry_ids: [E1] }, code: 'PAIR_NOT_CLOSED', message: 'Verifikationen saknar rad på 1930' }] })
    await expect(
      bookResidualAndLink(supabase as never, COMPANY, USER, KEY, { external_ids: [T1], journal_entry_id: E1, kind: 'bank_fee' }),
    ).rejects.toBeInstanceOf(ReconciliationResidualError)
    expect(createEntryMock).not.toHaveBeenCalled()
  })
})
