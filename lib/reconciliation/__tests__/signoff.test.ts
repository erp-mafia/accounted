import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const statusMock = vi.fn()
const latestMock = vi.fn()
const byIdMock = vi.fn()
const insertMock = vi.fn()
const stampMock = vi.fn()
const emitMock = vi.fn()

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

  it('returns null for an unknown or manual account key', async () => {
    const { supabase } = createQueuedMockSupabase()
    expect(await signOffAccount(supabase as never, COMPANY, USER, 'nope', { through_date: '2026-07-31' })).toBeNull()
    expect(await signOffAccount(supabase as never, COMPANY, USER, 'manual:1910', { through_date: '2026-07-31' })).toBeNull()
    expect(statusMock).not.toHaveBeenCalled()
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
