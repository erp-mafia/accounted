import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const statusMock = vi.fn()
const latestMock = vi.fn()
const byIdMock = vi.fn()
const insertMock = vi.fn()
const stampMock = vi.fn()
const emitMock = vi.fn()
const bookedOnDayMock = vi.fn()

vi.mock('../service', () => ({
  getAccountStatus: (...args: unknown[]) => statusMock(...args),
}))
vi.mock('../signoff-store', () => ({
  getLatestSignoff: (...args: unknown[]) => latestMock(...args),
  getSignoffById: (...args: unknown[]) => byIdMock(...args),
  insertSignoff: (...args: unknown[]) => insertMock(...args),
  stampReopen: (...args: unknown[]) => stampMock(...args),
}))
vi.mock('@/lib/events/bus', () => ({ eventBus: { emit: (...args: unknown[]) => emitMock(...args) } }))
vi.mock('../bank-balance-check', () => ({
  bookedBalanceOnDay: (...args: unknown[]) => bookedOnDayMock(...args),
}))

import { ReconciliationSignoffError, reopenSignoff, signOffAccount } from '../signoff'

const COMPANY = 'company-1'
const USER = 'user-1'
const TODAY = '2026-08-23'
const SIGNOFF_ID = '77777777-7777-4777-8777-777777777777'

function status(overrides: Record<string, unknown> = {}) {
  return {
    account_key: 'skattekonto',
    kind: 'skattekonto',
    account_number: '1630',
    currency: 'SEK',
    as_of: '2026-08-20T06:00:00Z',
    stale: false,
    external_balance: 1000,
    ledger_balance: 1000,
    difference: 0,
    unexplained_difference: 0,
    is_reconciled: true,
    bridge: [],
    counts: { proposed: 0, unmatched_external: 0, unmatched_ledger: 0, matched: 0, ignored: 0 },
    skattekonto: null,
    bank: null,
    ...overrides,
  }
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: SIGNOFF_ID,
    account_key: 'skattekonto',
    through_date: '2026-07-31',
    external_balance: 1000,
    ledger_balance: 1000,
    unexplained_difference: 0,
    note: null,
    signed_by: USER,
    signed_at: '2026-08-23T10:00:00Z',
    reopened_at: null,
    reopened_by: null,
    reopen_reason: null,
    ...overrides,
  }
}

describe('signOffAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    statusMock.mockReset()
    latestMock.mockReset()
    insertMock.mockReset()
    emitMock.mockResolvedValue(undefined)
    statusMock.mockResolvedValue(status())
    latestMock.mockResolvedValue(null)
    insertMock.mockImplementation(async (_s: unknown, _c: unknown, input: Record<string, unknown>) =>
      row({ through_date: input.through_date, note: input.note, unexplained_difference: input.unexplained_difference }),
    )
  })

  it('returns null for an unknown account key and for a key the engine does not resolve', async () => {
    const { supabase } = createQueuedMockSupabase()
    expect(await signOffAccount(supabase as never, COMPANY, USER, 'nope', { through_date: '2026-07-31' })).toBeNull()
    expect(statusMock).not.toHaveBeenCalled()
    statusMock.mockResolvedValue(null)
    expect(
      await signOffAccount(supabase as never, COMPANY, USER, 'manual:1910', { through_date: '2026-07-31' }, { today: TODAY }),
    ).toBeNull()
    expect(statusMock).toHaveBeenCalledWith(supabase, COMPANY, 'manual:1910', { today: TODAY, windowTo: '2026-07-31' })
  })

  describe('manual accounts', () => {
    function manualStatus(overrides: Record<string, unknown> = {}) {
      return status({
        account_key: 'manual:2350',
        kind: 'manual',
        account_number: '2350',
        as_of: '2026-07-31T00:00:00.000Z',
        external_balance: null,
        ledger_balance: -250000,
        difference: null,
        unexplained_difference: null,
        is_reconciled: false,
        manual: { specification: null },
        ...overrides,
      })
    }

    it('signs with the stated balance when it equals the booked one, recording both', async () => {
      const { supabase } = createQueuedMockSupabase()
      statusMock.mockResolvedValue(manualStatus())
      const result = await signOffAccount(
        supabase as never,
        COMPANY,
        USER,
        'manual:2350',
        { through_date: '2026-07-31', external_balance: -250000, note: 'Enligt engagemangsbesked' },
        { today: TODAY },
      )
      expect(result).toMatchObject({ dry_run: false })
      expect(insertMock).toHaveBeenCalledWith(
        supabase,
        COMPANY,
        expect.objectContaining({
          account_key: 'manual:2350',
          external_balance: -250000,
          ledger_balance: -250000,
          unexplained_difference: 0,
        }),
      )
    })

    it('treats the gap between stated and booked as the unexplained difference', async () => {
      const { supabase } = createQueuedMockSupabase()
      statusMock.mockResolvedValue(manualStatus())
      await expect(
        signOffAccount(
          supabase as never,
          COMPANY,
          USER,
          'manual:2350',
          { through_date: '2026-07-31', external_balance: -249500 },
          { today: TODAY },
        ),
      ).rejects.toMatchObject({ code: 'NOT_RECONCILED' })
      const forced = await signOffAccount(
        supabase as never,
        COMPANY,
        USER,
        'manual:2350',
        { through_date: '2026-07-31', external_balance: -249500, force: true, note: 'Amortering bokförs i augusti.' },
        { today: TODAY, dryRun: true },
      )
      expect(forced).toMatchObject({
        dry_run: true,
        would_sign: { external_balance: -249500, ledger_balance: -250000, unexplained_difference: -500, forced: true },
      })
    })

    it('still needs force + note when no balance is stated', async () => {
      const { supabase } = createQueuedMockSupabase()
      statusMock.mockResolvedValue(manualStatus())
      await expect(
        signOffAccount(supabase as never, COMPANY, USER, 'manual:2350', { through_date: '2026-07-31' }, { today: TODAY }),
      ).rejects.toMatchObject({ code: 'OUTSIDE_UNKNOWN' })
    })

    it('refuses a stated balance where the system already has an outside truth', async () => {
      const { supabase } = createQueuedMockSupabase()
      statusMock.mockResolvedValue(
        manualStatus({
          account_key: 'manual:1510',
          account_number: '1510',
          external_balance: 12000,
          ledger_balance: 12000,
          unexplained_difference: 0,
          is_reconciled: true,
          manual: { specification: { provider: 'ar', amount: 12000 } },
        }),
      )
      await expect(
        signOffAccount(
          supabase as never,
          COMPANY,
          USER,
          'manual:1510',
          { through_date: '2026-07-31', external_balance: 12000 },
          { today: TODAY },
        ),
      ).rejects.toMatchObject({ code: 'EXTERNAL_BALANCE_NOT_ALLOWED' })
      statusMock.mockResolvedValue(status())
      await expect(
        signOffAccount(
          supabase as never,
          COMPANY,
          USER,
          'skattekonto',
          { through_date: '2026-07-31', external_balance: 1000 },
          { today: TODAY },
        ),
      ).rejects.toMatchObject({ code: 'EXTERNAL_BALANCE_NOT_ALLOWED' })
      expect(insertMock).not.toHaveBeenCalled()
    })
  })

  it('rejects a malformed date and a date in the future', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      signOffAccount(supabase as never, COMPANY, USER, 'skattekonto', { through_date: '31/07/2026' }, { today: TODAY }),
    ).rejects.toMatchObject({ code: 'INVALID_DATE' })
    await expect(
      signOffAccount(supabase as never, COMPANY, USER, 'skattekonto', { through_date: '2026-09-01' }, { today: TODAY }),
    ).rejects.toMatchObject({ code: 'DATE_IN_FUTURE' })
    expect(insertMock).not.toHaveBeenCalled()
  })

  it('signs a reconciled account, records the numbers, and emits reconciliation.signed_off', async () => {
    const { supabase } = createQueuedMockSupabase()
    const result = await signOffAccount(
      supabase as never,
      COMPANY,
      USER,
      'skattekonto',
      { through_date: '2026-07-31' },
      { today: TODAY },
    )
    expect(result).toMatchObject({ dry_run: false, signoff: { through_date: '2026-07-31', unexplained_difference: 0 } })
    // The bridge is asked for through the requested date.
    expect(statusMock).toHaveBeenCalledWith(supabase, COMPANY, 'skattekonto', { today: TODAY, windowTo: '2026-07-31' })
    expect(insertMock).toHaveBeenCalledWith(
      supabase,
      COMPANY,
      expect.objectContaining({ account_key: 'skattekonto', through_date: '2026-07-31', signed_by: USER, note: null }),
    )
    expect(emitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'reconciliation.signed_off',
        payload: expect.objectContaining({ accountKey: 'skattekonto', throughDate: '2026-07-31', signoffId: SIGNOFF_ID }),
      }),
    )
  })

  it('dry run previews without writing', async () => {
    const { supabase } = createQueuedMockSupabase()
    const result = await signOffAccount(
      supabase as never,
      COMPANY,
      USER,
      'skattekonto',
      { through_date: '2026-07-31' },
      { today: TODAY, dryRun: true },
    )
    expect(result).toMatchObject({
      dry_run: true,
      would_sign: { through_date: '2026-07-31', is_reconciled: true, forced: false, previous_through_date: null },
    })
    expect(insertMock).not.toHaveBeenCalled()
    expect(emitMock).not.toHaveBeenCalled()
  })

  it('previews the status\'s own is_reconciled: explained but rows still open signs unforced and says is_reconciled false (crm#1183)', async () => {
    const { supabase } = createQueuedMockSupabase()
    statusMock.mockResolvedValue(
      status({
        unexplained_difference: 0,
        is_reconciled: false,
        counts: { proposed: 0, unmatched_external: 1, unmatched_ledger: 2, matched: 0, ignored: 0 },
      }),
    )
    const result = await signOffAccount(
      supabase as never,
      COMPANY,
      USER,
      'skattekonto',
      { through_date: '2026-07-31' },
      { today: TODAY, dryRun: true },
    )
    expect(result).toMatchObject({
      dry_run: true,
      would_sign: { unexplained_difference: 0, is_reconciled: false, forced: false },
    })
    expect(insertMock).not.toHaveBeenCalled()
  })

  it('refuses an unexplained difference unless forced with a note, then records the difference', async () => {
    const { supabase } = createQueuedMockSupabase()
    statusMock.mockResolvedValue(status({ unexplained_difference: 12.5, is_reconciled: false }))
    await expect(
      signOffAccount(supabase as never, COMPANY, USER, 'skattekonto', { through_date: '2026-07-31' }, { today: TODAY }),
    ).rejects.toMatchObject({ code: 'NOT_RECONCILED' })
    await expect(
      signOffAccount(
        supabase as never,
        COMPANY,
        USER,
        'skattekonto',
        { through_date: '2026-07-31', force: true },
        { today: TODAY },
      ),
    ).rejects.toMatchObject({ code: 'NOTE_REQUIRED' })
    const forced = await signOffAccount(
      supabase as never,
      COMPANY,
      USER,
      'skattekonto',
      { through_date: '2026-07-31', force: true, note: 'Bankavgift 12,50 bokförs i augusti.' },
      { today: TODAY },
    )
    expect(forced).toMatchObject({ dry_run: false })
    expect(insertMock).toHaveBeenCalledWith(
      supabase,
      COMPANY,
      expect.objectContaining({ unexplained_difference: 12.5, note: 'Bankavgift 12,50 bokförs i augusti.' }),
    )
  })

  it('refuses when the outside balance is unknown', async () => {
    const { supabase } = createQueuedMockSupabase()
    statusMock.mockResolvedValue(status({ external_balance: null, unexplained_difference: null, is_reconciled: false }))
    await expect(
      signOffAccount(supabase as never, COMPANY, USER, 'skattekonto', { through_date: '2026-07-31' }, { today: TODAY }),
    ).rejects.toMatchObject({ code: 'OUTSIDE_UNKNOWN' })
  })

  it('refuses a skattekonto date past the snapshot', async () => {
    const { supabase } = createQueuedMockSupabase()
    statusMock.mockResolvedValue(status({ as_of: '2026-07-15T06:00:00Z' }))
    await expect(
      signOffAccount(supabase as never, COMPANY, USER, 'skattekonto', { through_date: '2026-07-31' }, { today: TODAY }),
    ).rejects.toMatchObject({ code: 'NOT_FETCHED_THROUGH' })
  })

  it('refuses a date at or before the latest active sign-off', async () => {
    const { supabase } = createQueuedMockSupabase()
    latestMock.mockResolvedValue(row({ through_date: '2026-07-31' }))
    await expect(
      signOffAccount(supabase as never, COMPANY, USER, 'skattekonto', { through_date: '2026-07-31' }, { today: TODAY }),
    ).rejects.toMatchObject({ code: 'ALREADY_SIGNED_OFF' })
    await expect(
      signOffAccount(supabase as never, COMPANY, USER, 'skattekonto', { through_date: '2026-06-30' }, { today: TODAY }),
    ).rejects.toMatchObject({ code: 'ALREADY_SIGNED_OFF' })
    // A later date is fine and the preview names what it supersedes.
    const later = await signOffAccount(
      supabase as never,
      COMPANY,
      USER,
      'skattekonto',
      { through_date: '2026-08-15' },
      { today: TODAY, dryRun: true },
    )
    expect(later).toMatchObject({ dry_run: true, would_sign: { previous_through_date: '2026-07-31' } })
  })

  it('maps a unique-index collision to SIGNOFF_RACE', async () => {
    const { supabase } = createQueuedMockSupabase()
    insertMock.mockRejectedValue(new Error('duplicate key value violates unique constraint "ux_account_reconciliations_active"'))
    await expect(
      signOffAccount(supabase as never, COMPANY, USER, 'skattekonto', { through_date: '2026-07-31' }, { today: TODAY }),
    ).rejects.toMatchObject({ code: 'SIGNOFF_RACE' })
  })

  it('judges a bank account from the start of the fiscal period that covers the date', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    // A September-to-August company: judging from 1 January would drop the
    // opening balance and the autumn movements the page window includes.
    enqueue({ data: { period_start: '2025-09-01' } })
    statusMock.mockResolvedValue(
      status({ account_key: 'bank:11111111-1111-4111-8111-111111111111', kind: 'bank', account_number: '1930', as_of: '2026-09-02T10:00:00Z' }),
    )
    await signOffAccount(
      supabase as never,
      COMPANY,
      USER,
      'bank:11111111-1111-4111-8111-111111111111',
      { through_date: '2026-08-31' },
      { today: '2026-09-02' },
    )
    expect(statusMock).toHaveBeenCalledWith(supabase, COMPANY, 'bank:11111111-1111-4111-8111-111111111111', {
      today: '2026-09-02',
      windowFrom: '2025-09-01',
      windowTo: '2026-08-31',
      balanceCheckOn: '2026-08-31',
    })
  })

  it('leaves the window default alone when no fiscal period covers the date, and never for non-bank keys', async () => {
    const { supabase } = createQueuedMockSupabase()
    await signOffAccount(
      supabase as never,
      COMPANY,
      USER,
      'bank:11111111-1111-4111-8111-111111111111',
      { through_date: '2026-07-31' },
      { today: TODAY },
    )
    expect(statusMock).toHaveBeenLastCalledWith(supabase, COMPANY, 'bank:11111111-1111-4111-8111-111111111111', {
      today: TODAY,
      windowTo: '2026-07-31',
      balanceCheckOn: '2026-07-31',
    })
    await signOffAccount(supabase as never, COMPANY, USER, 'skattekonto', { through_date: '2026-07-31' }, { today: TODAY })
    expect(statusMock).toHaveBeenLastCalledWith(supabase, COMPANY, 'skattekonto', { today: TODAY, windowTo: '2026-07-31' })
  })

  it('names the unexplained amount on a NOT_RECONCILED refusal so a dialog can show it', async () => {
    const { supabase } = createQueuedMockSupabase()
    statusMock.mockResolvedValue(status({ unexplained_difference: 53717, is_reconciled: false }))
    await expect(
      signOffAccount(supabase as never, COMPANY, USER, 'skattekonto', { through_date: '2026-07-31' }, { today: TODAY }),
    ).rejects.toMatchObject({ code: 'NOT_RECONCILED', details: { unexplained_difference: 53717 } })
  })

  it('404s (null) when the status says the account does not exist for the company', async () => {
    const { supabase } = createQueuedMockSupabase()
    statusMock.mockResolvedValue(null)
    expect(
      await signOffAccount(
        supabase as never,
        COMPANY,
        USER,
        'bank:11111111-1111-4111-8111-111111111111',
        { through_date: '2026-07-31' },
        { today: TODAY },
      ),
    ).toBeNull()
  })
})

describe('signOffAccount: the bank balance on the through-date', () => {
  const BANK_KEY = 'bank:11111111-1111-4111-8111-111111111111'

  function bankStatus(bank: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
    return status({
      account_key: BANK_KEY,
      kind: 'bank',
      account_number: '1930',
      as_of: '2026-11-24T08:00:00Z',
      external_balance: null,
      ledger_balance: 4200,
      difference: 0,
      unexplained_difference: 0,
      bank,
      ...overrides,
    })
  }

  function check(bankBalance: number, bookedBalance: number) {
    return {
      as_of: '2026-10-31',
      fetched_at: null,
      balance_type: null,
      bank_balance: bankBalance,
      booked_balance: bookedBalance,
      difference: bankBalance - bookedBalance,
      unbooked: { count: 0, total: 0 },
      before_history: null,
      ignored: { count: 0, total: 0 },
      rest: bankBalance - bookedBalance,
    }
  }

  const sign = (supabase: unknown, dryRun = false, input: Record<string, unknown> = {}) =>
    signOffAccount(supabase as never, COMPANY, USER, BANK_KEY, { through_date: '2026-10-31', ...input }, { today: '2026-11-24', dryRun })

  beforeEach(() => {
    vi.clearAllMocks()
    statusMock.mockReset()
    latestMock.mockReset()
    insertMock.mockReset()
    bookedOnDayMock.mockReset()
    emitMock.mockResolvedValue(undefined)
    latestMock.mockResolvedValue(null)
    insertMock.mockImplementation(async (_s: unknown, _c: unknown, input: Record<string, unknown>) =>
      row({ account_key: BANK_KEY, through_date: input.through_date, note: input.note, external_balance: input.external_balance }),
    )
  })

  it('shows the balances side by side and warns about nothing when they match', async () => {
    const { supabase } = createQueuedMockSupabase()
    statusMock.mockResolvedValue(bankStatus({ balance_check: check(12345, 12345), balance_check_refusal: null }))
    const result = await sign(supabase, true)
    expect(result).toMatchObject({
      dry_run: true,
      would_sign: {
        bank_balance: { as_of: '2026-10-31', bank_balance: 12345, booked_balance: 12345, difference: 0 },
        warning: null,
      },
    })
    expect(bookedOnDayMock).not.toHaveBeenCalled()
  })

  it('warns in plain Swedish when they differ, and still records the sign-off with nothing else changed', async () => {
    const { supabase } = createQueuedMockSupabase()
    statusMock.mockResolvedValue(bankStatus({ balance_check: check(12345, 12000), balance_check_refusal: null }))
    const result = await sign(supabase)
    if (!result || result.dry_run) throw new Error('expected a sign-off')
    expect(result.warning?.code).toBe('BANK_BALANCE_DIFFERS')
    expect(result.warning?.message).toMatch(/^Bankens saldo per 2026-10-31 är 12\s345\skr, men 1930 visar 12\s000\skr samma dag: en skillnad på 345\skr\./)
    expect(result.bank_balance).toEqual({
      as_of: '2026-10-31',
      bank_balance: 12345,
      booked_balance: 12000,
      difference: 345,
      unbooked: { count: 0, total: 0 },
      before_history: null,
      rest: 345,
    })
    // The bridge still decides; the stored row carries no bank balance.
    expect(insertMock).toHaveBeenCalledWith(
      supabase,
      COMPANY,
      expect.objectContaining({ through_date: '2026-10-31', external_balance: null, ledger_balance: 4200, unexplained_difference: 0 }),
    )
    expect(result.signoff.through_date).toBe('2026-10-31')
  })

  it('warns that the bank has no balance for the date, gives the booked one, and still signs', async () => {
    const { supabase } = createQueuedMockSupabase()
    statusMock.mockResolvedValue(bankStatus({ balance_check: null, balance_check_refusal: 'NO_BANK_BALANCE' }))
    bookedOnDayMock.mockResolvedValue(12000)
    const result = await sign(supabase)
    if (!result || result.dry_run) throw new Error('expected a sign-off')
    expect(bookedOnDayMock).toHaveBeenCalledWith(supabase, COMPANY, '1930', '2026-10-31')
    expect(result.bank_balance).toEqual({
      as_of: '2026-10-31',
      bank_balance: null,
      booked_balance: 12000,
      difference: null,
      unbooked: null,
      before_history: null,
      rest: null,
    })
    expect(result.warning).toEqual({
      code: 'NO_BANK_BALANCE',
      message: expect.stringMatching(/^Det finns inget saldo från banken per 2026-10-31 att jämföra 1930 med \(bokfört samma dag: 12\s000\skr\)\./),
    })
    expect(insertMock).toHaveBeenCalledTimes(1)
  })

  it('names the parts of the difference: rows without a verifikat, and what lies before the bank\'s first row', async () => {
    const { supabase } = createQueuedMockSupabase()
    statusMock.mockResolvedValue(
      bankStatus({
        balance_check: {
          ...check(62345, 12000),
          unbooked: { count: 2, total: 345 },
          before_history: { history_start: '2026-10-13', bank_balance: 50000, booked_balance: 0, difference: 50000 },
          rest: 0,
        },
        balance_check_refusal: null,
      }),
    )
    const result = await sign(supabase, true)
    if (!result || !result.dry_run) throw new Error('expected a preview')
    expect(result.would_sign.bank_balance).toMatchObject({
      unbooked: { count: 2, total: 345 },
      before_history: { history_start: '2026-10-13', difference: 50000 },
      rest: 0,
    })
    expect(result.would_sign.warning?.message).toMatch(
      /2 banktransaktioner utan verifikation står för 345\skr\. Av skillnaden ligger 50\s000\skr före bankens första transaktion 2026-10-13, oftast ett ingående saldo som aldrig bokfördes\. Signeringen stoppas inte av det/,
    )
  })

  it('claims nothing for an account in another currency than the books, and warns when the check failed', async () => {
    const { supabase } = createQueuedMockSupabase()
    statusMock.mockResolvedValue(bankStatus({ balance_check: null, balance_check_refusal: 'FOREIGN_CURRENCY_ACCOUNT' }, { currency: 'EUR' }))
    const foreign = await sign(supabase, true)
    expect(foreign).toMatchObject({ would_sign: { bank_balance: null, warning: null } })
    statusMock.mockResolvedValue(bankStatus({ balance_check: null, balance_check_refusal: 'NO_FISCAL_PERIOD' }))
    expect(await sign(supabase, true)).toMatchObject({ would_sign: { bank_balance: null, warning: null } })
    statusMock.mockResolvedValue(bankStatus({ balance_check: null, balance_check_refusal: null }))
    const failed = await sign(supabase, true)
    expect(failed).toMatchObject({ would_sign: { warning: { code: 'NO_BANK_BALANCE' } } })
    expect(bookedOnDayMock).not.toHaveBeenCalled()
  })

  it('puts the comparison on a NOT_RECONCILED refusal too, so the dialog shows it before a forced sign-off', async () => {
    const { supabase } = createQueuedMockSupabase()
    statusMock.mockResolvedValue(
      bankStatus({ balance_check: check(12345, 12000), balance_check_refusal: null }, { unexplained_difference: 345, is_reconciled: false }),
    )
    await expect(sign(supabase, true)).rejects.toMatchObject({
      code: 'NOT_RECONCILED',
      details: {
        unexplained_difference: 345,
        bank_balance: { bank_balance: 12345, booked_balance: 12000, difference: 345 },
        warning: { code: 'BANK_BALANCE_DIFFERS' },
      },
    })
  })

  describe('a stated balance on a bank account no bank connection feeds', () => {
    // signOffAccount reads the fiscal period first, then the cash account.
    function supabaseFor(cashAccount: { bank_connection_id: string | null } | null) {
      const mock = createQueuedMockSupabase()
      mock.enqueueMany([{ data: null }, { data: cashAccount }])
      return mock
    }
    const unconnected = () => supabaseFor({ bank_connection_id: null })
    const noBankBalance = (overrides: Record<string, unknown> = {}) =>
      bankStatus(
        { balance_check: null, balance_check_refusal: 'NO_BANK_BALANCE' },
        { account_number: '1940', unexplained_difference: 640, is_reconciled: false, ...overrides },
      )

    it('signs against the booked balance at the end of the date, as a manual account does, and records both', async () => {
      const { supabase, findCalls } = unconnected()
      statusMock.mockResolvedValue(noBankBalance())
      bookedOnDayMock.mockResolvedValue(8150.5)
      const result = await sign(supabase, false, { external_balance: 8150.5 })
      if (!result || result.dry_run) throw new Error('expected a sign-off')
      expect(findCalls('cash_accounts', 'eq')).toEqual([
        ['company_id', COMPANY],
        ['id', '11111111-1111-4111-8111-111111111111'],
      ])
      expect(bookedOnDayMock).toHaveBeenCalledWith(supabase, COMPANY, '1940', '2026-10-31')
      // The bridge's 640 is not what is judged: the stated balance is.
      expect(insertMock).toHaveBeenCalledWith(
        supabase,
        COMPANY,
        expect.objectContaining({ through_date: '2026-10-31', external_balance: 8150.5, ledger_balance: 8150.5, unexplained_difference: 0 }),
      )
      // The statement's balance answers the bank having none.
      expect(result.warning).toBeNull()
    })

    it('refuses a stated balance that differs from the books unless forced, and then records the difference', async () => {
      statusMock.mockResolvedValue(noBankBalance())
      bookedOnDayMock.mockResolvedValue(8150.5)
      await expect(sign(unconnected().supabase, true, { external_balance: 8000 })).rejects.toMatchObject({
        code: 'NOT_RECONCILED',
        details: { unexplained_difference: 150.5 },
      })
      const result = await sign(unconnected().supabase, true, { external_balance: 8000, force: true, note: 'Kortköp som bokförs i november.' })
      expect(result).toMatchObject({
        dry_run: true,
        would_sign: { external_balance: 8000, ledger_balance: 8150.5, unexplained_difference: 150.5, forced: true, warning: null },
      })
    })

    it('still refuses it on a bank account a bank connection feeds', async () => {
      const { supabase } = supabaseFor({ bank_connection_id: '33333333-3333-4333-8333-333333333333' })
      statusMock.mockResolvedValue(noBankBalance())
      await expect(sign(supabase, false, { external_balance: 8150.5 })).rejects.toMatchObject({ code: 'EXTERNAL_BALANCE_NOT_ALLOWED' })
      expect(insertMock).not.toHaveBeenCalled()
    })

    it('takes none for an account whose row is gone by the time it is read', async () => {
      statusMock.mockResolvedValue(noBankBalance())
      await expect(sign(supabaseFor(null).supabase, false, { external_balance: 8150.5 })).rejects.toMatchObject({
        code: 'EXTERNAL_BALANCE_NOT_ALLOWED',
      })
      expect(insertMock).not.toHaveBeenCalled()
    })

    it('refuses it on an account kept in another currency than the books', async () => {
      statusMock.mockResolvedValue(
        bankStatus({ balance_check: null, balance_check_refusal: 'FOREIGN_CURRENCY_ACCOUNT' }, { account_number: '1932', currency: 'EUR' }),
      )
      await expect(sign(unconnected().supabase, false, { external_balance: 700 })).rejects.toMatchObject({
        code: 'EXTERNAL_BALANCE_NOT_ALLOWED',
        message: expect.stringMatching(/annan valuta än bokföringen/),
      })
      expect(insertMock).not.toHaveBeenCalled()
    })

    it('without a stated balance judges the bridge as before and reads no cash account', async () => {
      const { supabase, findCall } = createQueuedMockSupabase()
      statusMock.mockResolvedValue(noBankBalance({ unexplained_difference: 0, is_reconciled: true }))
      bookedOnDayMock.mockResolvedValue(8150.5)
      const result = await sign(supabase, true)
      expect(result).toMatchObject({ would_sign: { external_balance: null, unexplained_difference: 0, warning: { code: 'NO_BANK_BALANCE' } } })
      expect(findCall('cash_accounts', 'select')).toBeUndefined()
    })
  })

  it('carries no bank comparison for the skattekonto or a manual account', async () => {
    const { supabase } = createQueuedMockSupabase()
    statusMock.mockResolvedValue(status())
    const result = await signOffAccount(
      supabase as never,
      COMPANY,
      USER,
      'skattekonto',
      { through_date: '2026-07-31' },
      { today: TODAY, dryRun: true },
    )
    expect(result).toMatchObject({ would_sign: { bank_balance: null, warning: null } })
  })
})

describe('reopenSignoff', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    byIdMock.mockReset()
    stampMock.mockReset()
    emitMock.mockResolvedValue(undefined)
  })

  it('stamps the row, emits reconciliation.reopened, and returns the updated row', async () => {
    const { supabase } = createQueuedMockSupabase()
    byIdMock.mockResolvedValue(row())
    stampMock.mockResolvedValue(row({ reopened_at: '2026-08-24T08:00:00Z', reopened_by: USER, reopen_reason: 'sen rad' }))
    const result = await reopenSignoff(supabase as never, COMPANY, USER, 'skattekonto', SIGNOFF_ID, { reason: ' sen rad ' })
    expect(result).toMatchObject({ reopened_by: USER, reopen_reason: 'sen rad' })
    expect(stampMock).toHaveBeenCalledWith(supabase, COMPANY, SIGNOFF_ID, { reopened_by: USER, reason: 'sen rad' })
    expect(emitMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'reconciliation.reopened', payload: expect.objectContaining({ signoffId: SIGNOFF_ID, reason: 'sen rad' }) }),
    )
  })

  it('refuses a missing or already reopened sign-off, and reports a lost race', async () => {
    const { supabase } = createQueuedMockSupabase()
    byIdMock.mockResolvedValue(null)
    await expect(reopenSignoff(supabase as never, COMPANY, USER, 'skattekonto', SIGNOFF_ID)).rejects.toMatchObject({
      code: 'SIGNOFF_NOT_FOUND',
    })
    byIdMock.mockResolvedValue(row({ reopened_at: '2026-08-24T08:00:00Z', reopened_by: USER }))
    await expect(reopenSignoff(supabase as never, COMPANY, USER, 'skattekonto', SIGNOFF_ID)).rejects.toMatchObject({
      code: 'ALREADY_REOPENED',
    })
    byIdMock.mockResolvedValue(row())
    stampMock.mockResolvedValue(null)
    await expect(reopenSignoff(supabase as never, COMPANY, USER, 'skattekonto', SIGNOFF_ID)).rejects.toBeInstanceOf(
      ReconciliationSignoffError,
    )
  })

  it('returns null for an unknown account key', async () => {
    const { supabase } = createQueuedMockSupabase()
    expect(await reopenSignoff(supabase as never, COMPANY, USER, 'nope', SIGNOFF_ID)).toBeNull()
  })
})
