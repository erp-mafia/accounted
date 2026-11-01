import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { Logger } from '@/lib/logger'

const requireAdminMock = vi.fn()
vi.mock('@/lib/operations/access', () => ({
  requireCompanyAdmin: (...args: unknown[]) => requireAdminMock(...args),
}))

const activateMock = vi.fn()
const createAccountMock = vi.fn()
vi.mock('@/lib/bookkeeping/chart-of-accounts-service', () => ({
  activateAccounts: (...args: unknown[]) => activateMock(...args),
  createAccount: (...args: unknown[]) => createAccountMock(...args),
}))

const createDraftMock = vi.fn()
const findPeriodMock = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  createDraftEntry: (...args: unknown[]) => createDraftMock(...args),
  findFiscalPeriod: (...args: unknown[]) => findPeriodMock(...args),
}))

// Balance per account through the date, from the IB on: the huvudbok figure.
const balances = new Map<string, number | null>()
vi.mock('@/lib/reconciliation/gl-balance', () => ({
  findOpeningBalanceFloor: vi.fn(async () => null),
  sumAccountBalance: vi.fn(async (_s: unknown, _c: unknown, account: string) =>
    balances.has(account) ? balances.get(account) : 0,
  ),
}))

const resolveMock = vi.fn()
const deriveMock = vi.fn()
vi.mock('../skattekonto-account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../skattekonto-account')>()),
  resolveSkattekontoAccount: (...args: unknown[]) => resolveMock(...args),
  deriveSkattekontoAccountFromBooks: (...args: unknown[]) => deriveMock(...args),
}))

import {
  createSkattekontoTransferDraft,
  getSkattekontoAccountState,
  setSkattekontoAccount,
} from '../skattekonto-account-service'

const COMPANY = 'company-1'
const USER = 'user-1'
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger

function ctxWith(supabase: unknown) {
  return { supabase: supabase as never, companyId: COMPANY, userId: USER, log }
}

beforeEach(() => {
  vi.clearAllMocks()
  balances.clear()
  requireAdminMock.mockResolvedValue(null)
  activateMock.mockResolvedValue({ ok: true, data: { accounts: [], activated: 0, reactivated: 0, skipped: 1, unknown: [] } })
  createAccountMock.mockResolvedValue({ ok: true, data: {} })
  resolveMock.mockResolvedValue('1630')
  deriveMock.mockResolvedValue(null)
  findPeriodMock.mockResolvedValue('fp-2026')
  createDraftMock.mockResolvedValue({ id: 'je-draft' })
})

describe('getSkattekontoAccountState', () => {
  it('shows an enskild firma both accounts, what the books say and what sits on each', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { entity_type: 'enskild_firma', skattekonto_account: null } })
    deriveMock.mockResolvedValue('2012')
    balances.set('1630', 0)
    balances.set('2012', 1234.5)

    const outcome = await getSkattekontoAccountState(ctxWith(supabase), { asOf: '2026-10-14' })

    expect(outcome).toEqual({
      ok: true,
      data: {
        entity_type: 'enskild_firma',
        account: '1630',
        chosen: null,
        choices: ['1630', '2012'],
        books_suggest: '2012',
        as_of: '2026-10-14',
        balances: [
          { account: '1630', balance: 0 },
          { account: '2012', balance: 1234.5 },
        ],
      },
    })
  })

  it('offers an aktiebolag 1630 only', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { entity_type: 'aktiebolag', skattekonto_account: null } })
    const outcome = await getSkattekontoAccountState(ctxWith(supabase))
    expect(outcome.ok && !outcome.dryRun && outcome.data.choices).toEqual(['1630'])
  })

  it('fails rather than show a balance it could not read', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { entity_type: 'enskild_firma', skattekonto_account: null } })
    balances.set('2012', null)
    const outcome = await getSkattekontoAccountState(ctxWith(supabase))
    expect(outcome).toMatchObject({ ok: false, code: 'UNKNOWN_ERROR' })
  })
})

describe('setSkattekontoAccount', () => {
  it('stores 2012 for an enskild firma, adds 2012 to the chart with the K1 name, and says what stays on 1630', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { entity_type: 'enskild_firma', skattekonto_account: null } }) // before
    enqueue({ data: { company_id: COMPANY } }) // update
    enqueue({ data: { entity_type: 'enskild_firma', skattekonto_account: '2012' } }) // after
    balances.set('1630', 500)
    activateMock.mockResolvedValue({ ok: true, data: { accounts: [], activated: 0, reactivated: 0, skipped: 0, unknown: ['2012'] } })
    resolveMock.mockResolvedValueOnce('1630').mockResolvedValueOnce('2012')

    const outcome = await setSkattekontoAccount(ctxWith(supabase), '2012')

    expect(outcome.ok).toBe(true)
    if (!outcome.ok || outcome.dryRun) throw new Error('expected data')
    expect(outcome.data).toMatchObject({ previous_account: '1630', left_on_previous: 500 })
    expect(outcome.data.state).toMatchObject({ account: '2012', chosen: '2012' })
    expect(findCalls('company_settings', 'update')).toEqual([[{ skattekonto_account: '2012' }]])
    expect(createAccountMock).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: COMPANY }),
      expect.objectContaining({
        account_number: '2012',
        account_name: 'Avräkning för skatter och avgifter (skattekonto)',
        account_type: 'equity',
        plan_type: 'k1',
      }),
    )
    // Nothing in the ledger moves: no verifikat of any kind.
    expect(createDraftMock).not.toHaveBeenCalled()
  })

  it('refuses 2012 for an aktiebolag, with the accounts it allows', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { entity_type: 'aktiebolag', skattekonto_account: null } })
    const outcome = await setSkattekontoAccount(ctxWith(supabase), '2012')
    expect(outcome).toMatchObject({
      ok: false,
      code: 'SKATTEKONTO_ACCOUNT_NOT_ALLOWED',
      details: { allowed: ['1630'], entity_type: 'aktiebolag' },
    })
    expect(findCalls('company_settings', 'update')).toEqual([])
  })

  it('refuses any other account before reading anything', async () => {
    const { supabase } = createQueuedMockSupabase()
    const outcome = await setSkattekontoAccount(ctxWith(supabase), '1930')
    expect(outcome).toMatchObject({ ok: false, code: 'SKATTEKONTO_ACCOUNT_NOT_ALLOWED' })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('is for owners and admins only', async () => {
    const { supabase } = createQueuedMockSupabase()
    requireAdminMock.mockResolvedValue({ ok: false, code: 'FORBIDDEN', messageSv: 'Bara ägare' })
    const outcome = await setSkattekontoAccount(ctxWith(supabase), '2012')
    expect(outcome).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('a dry run writes nothing', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { entity_type: 'enskild_firma', skattekonto_account: null } })
    const outcome = await setSkattekontoAccount(ctxWith(supabase), '2012', { dryRun: true })
    expect(outcome).toMatchObject({ ok: true, dryRun: true, preview: { account: '2012', previous_account: '1630' } })
    expect(findCalls('company_settings', 'update')).toEqual([])
    expect(activateMock).not.toHaveBeenCalled()
  })
})

describe('createSkattekontoTransferDraft', () => {
  it('drafts, never posts, one verifikat moving what is left on 1630 to 2012', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { entity_type: 'enskild_firma', skattekonto_account: '2012' } })
    resolveMock.mockResolvedValue('2012')
    balances.set('1630', 1234.5)

    const outcome = await createSkattekontoTransferDraft(ctxWith(supabase), { entry_date: '2026-10-14' })

    expect(outcome).toEqual({
      ok: true,
      created: true,
      data: { journal_entry_id: 'je-draft', entry_date: '2026-10-14', from_account: '1630', to_account: '2012', amount: 1234.5 },
    })
    const [, , , input] = createDraftMock.mock.calls[0]
    expect(input).toMatchObject({ fiscal_period_id: 'fp-2026', entry_date: '2026-10-14', source_type: 'manual' })
    expect(input.lines).toEqual([
      expect.objectContaining({ account_number: '2012', debit_amount: 1234.5, credit_amount: 0 }),
      expect.objectContaining({ account_number: '1630', debit_amount: 0, credit_amount: 1234.5 }),
    ])
  })

  it('moves a credit balance the other way round', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { entity_type: 'enskild_firma', skattekonto_account: '1630' } })
    balances.set('2012', -800)
    await createSkattekontoTransferDraft(ctxWith(supabase), { entry_date: '2026-10-14' })
    const [, , , input] = createDraftMock.mock.calls[0]
    expect(input.lines).toEqual([
      expect.objectContaining({ account_number: '2012', debit_amount: 800, credit_amount: 0 }),
      expect.objectContaining({ account_number: '1630', debit_amount: 0, credit_amount: 800 }),
    ])
  })

  it('refuses when nothing is left on the old account, or no open period covers the date', async () => {
    const empty = createQueuedMockSupabase()
    empty.enqueue({ data: { entity_type: 'enskild_firma', skattekonto_account: '2012' } })
    resolveMock.mockResolvedValue('2012')
    expect(await createSkattekontoTransferDraft(ctxWith(empty.supabase))).toMatchObject({
      ok: false,
      code: 'SKATTEKONTO_TRANSFER_NOTHING_TO_MOVE',
    })

    const locked = createQueuedMockSupabase()
    locked.enqueue({ data: { entity_type: 'enskild_firma', skattekonto_account: '2012' } })
    balances.set('1630', 10)
    findPeriodMock.mockResolvedValue(null)
    expect(await createSkattekontoTransferDraft(ctxWith(locked.supabase))).toMatchObject({
      ok: false,
      code: 'PERIOD_LOCKED',
    })
    expect(createDraftMock).not.toHaveBeenCalled()
  })

  it('has nothing to move for an aktiebolag, whose skattekonto only ever runs 1630', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { entity_type: 'aktiebolag', skattekonto_account: null } })
    expect(await createSkattekontoTransferDraft(ctxWith(supabase))).toMatchObject({
      ok: false,
      code: 'SKATTEKONTO_TRANSFER_NOTHING_TO_MOVE',
    })
  })
})
