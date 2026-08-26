import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn(),
}))

vi.mock('@/lib/bookkeeping/entry-lines', () => ({
  fetchEntryLines: vi.fn(),
}))

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  assertRepairAttributionUser,
  classifyHistoricalResultRepair,
  getHistoricalResultRepairScopeError,
  type HistoricalResultRepairSnapshot,
} from '../result-appropriation-repair'

function snapshot(
  overrides: Partial<HistoricalResultRepairSnapshot> = {},
): HistoricalResultRepairSnapshot {
  return {
    companyId: 'company-1',
    periodId: 'period-2025',
    periodName: '2025',
    periodStart: '2025-01-01',
    entityType: 'aktiebolag',
    isClosed: false,
    lockedAt: null,
    openingBalanceEntryId: 'opening-1',
    openingBalanceEntryValid: true,
    openingBalanceVoucherLabel: 'A1',
    requiredAccountsActive: true,
    existingPostedAppropriation: false,
    resultAccountLines: [
      {
        journal_entry_id: 'opening-1',
        debit_amount: 0,
        credit_amount: 125_000,
      },
    ],
    ...overrides,
  }
}

describe('classifyHistoricalResultRepair', () => {
  it('plans the current posted profit from 2099 to 2098 when it still equals the explicit opening balance', () => {
    const result = classifyHistoricalResultRepair(snapshot())

    expect(result.status).toBe('safe')
    expect(result.reason).toBe('ready')
    expect(result.openingNet).toBe(125_000)
    expect(result.currentNet).toBe(125_000)
    expect(result.plan?.direction).toBe('profit')
    expect(result.plan?.lines).toEqual([
      expect.objectContaining({
        account_number: '2099',
        debit_amount: 125_000,
        credit_amount: 0,
      }),
      expect.objectContaining({
        account_number: '2098',
        debit_amount: 0,
        credit_amount: 125_000,
      }),
    ])
    expect(result.plan?.openingBalanceEntryId).toBe('opening-1')
    expect(result.plan?.openingBalanceVoucherLabel).toBe('A1')
  })

  it('plans the current posted loss in the opposite direction', () => {
    const result = classifyHistoricalResultRepair(
      snapshot({
        resultAccountLines: [
          {
            journal_entry_id: 'opening-1',
            debit_amount: 42_500.25,
            credit_amount: 0,
          },
        ],
      }),
    )

    expect(result.status).toBe('safe')
    expect(result.plan?.direction).toBe('loss')
    expect(result.plan?.amount).toBe(42_500.25)
    expect(result.plan?.lines).toEqual([
      expect.objectContaining({
        account_number: '2098',
        debit_amount: 42_500.25,
        credit_amount: 0,
      }),
      expect.objectContaining({
        account_number: '2099',
        debit_amount: 0,
        credit_amount: 42_500.25,
      }),
    ])
  })

  it('skips an already-disposed result when current posted 2099 is zero', () => {
    const result = classifyHistoricalResultRepair(
      snapshot({
        resultAccountLines: [
          {
            journal_entry_id: 'opening-1',
            debit_amount: 0,
            credit_amount: 125_000,
          },
          {
            journal_entry_id: 'manual-disposition',
            debit_amount: 125_000,
            credit_amount: 0,
          },
        ],
      }),
    )

    expect(result).toMatchObject({
      status: 'skipped',
      reason: 'already_disposed',
      openingNet: 125_000,
      currentNet: 0,
      plan: null,
    })
  })

  it('sends a changed current balance to manual review instead of moving the frozen opening amount', () => {
    const result = classifyHistoricalResultRepair(
      snapshot({
        resultAccountLines: [
          {
            journal_entry_id: 'opening-1',
            debit_amount: 0,
            credit_amount: 125_000,
          },
          {
            journal_entry_id: 'later-2099-entry',
            debit_amount: 25_000,
            credit_amount: 0,
          },
        ],
      }),
    )

    expect(result).toMatchObject({
      status: 'manual_review',
      reason: 'current_balance_differs',
      openingNet: 125_000,
      currentNet: 100_000,
      nonOpeningActivityEntries: 1,
      plan: null,
    })
  })

  it('treats offsetting non-opening 2099 activity as ambiguous even when the net still matches', () => {
    const result = classifyHistoricalResultRepair(
      snapshot({
        resultAccountLines: [
          {
            journal_entry_id: 'opening-1',
            debit_amount: 0,
            credit_amount: 125_000,
          },
          {
            journal_entry_id: 'later-debit',
            debit_amount: 10_000,
            credit_amount: 0,
          },
          {
            journal_entry_id: 'later-credit',
            debit_amount: 0,
            credit_amount: 10_000,
          },
        ],
      }),
    )

    expect(result).toMatchObject({
      status: 'manual_review',
      reason: 'intervening_2099_activity',
      openingNet: 125_000,
      currentNet: 125_000,
      nonOpeningActivityEntries: 2,
      plan: null,
    })
  })

  it.each([
    {
      label: 'missing opening-balance pointer',
      overrides: { openingBalanceEntryId: null },
      status: 'manual_review',
      reason: 'missing_explicit_opening_balance',
    },
    {
      label: 'invalid opening-balance entry',
      overrides: { openingBalanceEntryValid: false },
      status: 'manual_review',
      reason: 'invalid_opening_balance_entry',
    },
    {
      label: 'missing required BAS account',
      overrides: { requiredAccountsActive: false },
      status: 'manual_review',
      reason: 'missing_required_accounts',
    },
    {
      label: 'existing posted correction',
      overrides: { existingPostedAppropriation: true },
      status: 'skipped',
      reason: 'already_corrected',
    },
    {
      label: 'closed period',
      overrides: { isClosed: true },
      status: 'skipped',
      reason: 'period_closed',
    },
    {
      label: 'locked period',
      overrides: { lockedAt: '2025-06-01T00:00:00Z' },
      status: 'skipped',
      reason: 'period_locked',
    },
    {
      label: 'enskild firma',
      overrides: { entityType: 'enskild_firma' },
      status: 'skipped',
      reason: 'non_aktiebolag',
    },
  ])('does not auto-post for $label', ({ overrides, status, reason }) => {
    const result = classifyHistoricalResultRepair(
      snapshot(overrides as Partial<HistoricalResultRepairSnapshot>),
    )

    expect(result.status).toBe(status)
    expect(result.reason).toBe(reason)
    expect(result.plan).toBeNull()
  })

  it('skips an explicit zero opening result', () => {
    const result = classifyHistoricalResultRepair(
      snapshot({
        resultAccountLines: [
          {
            journal_entry_id: 'opening-1',
            debit_amount: 0,
            credit_amount: 0,
          },
        ],
      }),
    )

    expect(result).toMatchObject({
      status: 'skipped',
      reason: 'no_result_to_move',
      plan: null,
    })
  })
})

function membershipSupabase(row: { user_id: string } | null, error: { message: string } | null = null) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: row, error })
  const limit = vi.fn().mockReturnValue({ maybeSingle })
  const eqUser = vi.fn().mockReturnValue({ limit })
  const eqCompany = vi.fn().mockReturnValue({ eq: eqUser })
  const select = vi.fn().mockReturnValue({ eq: eqCompany })
  const from = vi.fn().mockReturnValue({ select })
  return { client: { from } as unknown as SupabaseClient, from }
}

describe('assertRepairAttributionUser', () => {
  it('accepts a user with a membership row in the company', async () => {
    const { client, from } = membershipSupabase({ user_id: 'user-1' })

    await expect(
      assertRepairAttributionUser(client, 'company-1', 'user-1'),
    ).resolves.toBeUndefined()
    expect(from).toHaveBeenCalledWith('company_members')
  })

  it('refuses to attribute the entry to a non-member', async () => {
    const { client } = membershipSupabase(null)

    await expect(
      assertRepairAttributionUser(client, 'company-1', 'outsider'),
    ).rejects.toThrow('not a member of company')
  })

  it('surfaces membership lookup failures instead of posting blind', async () => {
    const { client } = membershipSupabase(null, { message: 'connection reset' })

    await expect(
      assertRepairAttributionUser(client, 'company-1', 'user-1'),
    ).rejects.toThrow('Failed to verify company membership: connection reset')
  })
})

describe('getHistoricalResultRepairScopeError', () => {
  it('allows global and company-scoped dry-runs', () => {
    expect(getHistoricalResultRepairScopeError({ commit: false })).toBeNull()
    expect(
      getHistoricalResultRepairScopeError({ commit: false, companyId: 'company-1' }),
    ).toBeNull()
  })

  it('requires a company when a dry-run targets one period', () => {
    expect(
      getHistoricalResultRepairScopeError({ commit: false, periodId: 'period-1' }),
    ).toBe('--period-id requires --company-id')
  })

  it('requires one exact company, period, and user for commit mode', () => {
    expect(
      getHistoricalResultRepairScopeError({ commit: true, companyId: 'company-1' }),
    ).toMatch('--commit requires')
    expect(
      getHistoricalResultRepairScopeError({
        commit: true,
        companyId: 'company-1',
        periodId: 'period-1',
        userId: 'user-1',
      }),
    ).toBeNull()
  })
})
