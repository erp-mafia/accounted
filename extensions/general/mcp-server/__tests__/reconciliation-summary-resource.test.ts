import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const listMock = vi.fn()
vi.mock('@/lib/reconciliation/service', () => ({
  listReconciliationAccounts: (...args: unknown[]) => listMock(...args),
  getAccountStatus: vi.fn(),
}))

import { reconciliationSummaryResource } from '../resources/reconciliation-summary'

const CASH = '11111111-1111-4111-8111-111111111111'

function account(overrides: Record<string, unknown> = {}) {
  return {
    account_key: `bank:${CASH}`,
    kind: 'bank',
    account_number: '1930',
    name: 'Företagskonto',
    currency: 'SEK',
    logo_url: null,
    source: { type: 'psd2', synced_at: '2026-08-22T06:00:00Z', stale: false },
    status: {
      state: 'open',
      as_of: '2026-08-23T00:00:00Z',
      unexplained_difference: 250,
      open_counts: { proposed: 2, unmatched_external: 1, unmatched_ledger: 0 },
    },
    superseded_by: null,
    signed_off_through: '2026-06-30',
    ...overrides,
  }
}

describe('Accounted://reconciliation/summary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listMock.mockReset()
  })

  it('lists accounts with state, counts and sign-off, totals them, and points at the account with proposals', async () => {
    const { supabase } = createQueuedMockSupabase()
    listMock.mockResolvedValue([
      account(),
      account({
        account_key: 'skattekonto',
        kind: 'skattekonto',
        account_number: '1630',
        name: 'Skattekonto',
        status: { state: 'reconciled', as_of: '2026-08-23T04:00:00Z', unexplained_difference: 0, open_counts: { proposed: 0, unmatched_external: 0, unmatched_ledger: 0 } },
        signed_off_through: '2026-07-31',
      }),
      // A reconnect duplicate is listed but not counted.
      account({ account_key: 'bank:22222222-2222-4222-8222-222222222222', superseded_by: `bank:${CASH}` }),
    ])
    const out = (await reconciliationSummaryResource.read({
      supabase: supabase as never,
      companyId: 'company-1',
      userId: 'user-1',
      scopes: [],
      query: new URLSearchParams('date_from=2026-07-01&date_to=2026-07-31'),
    })) as Record<string, unknown>
    expect(listMock).toHaveBeenCalledWith(supabase, 'company-1', { withStatus: true, windowFrom: '2026-07-01', windowTo: '2026-07-31' })
    expect(out.totals).toMatchObject({ accounts: 2, reconciled: 1, open: 1, proposed: 2, unmatched_external: 1 })
    const accounts = out.accounts as Array<Record<string, unknown>>
    expect(accounts).toHaveLength(3)
    expect(accounts[0]).toMatchObject({ account_key: `bank:${CASH}`, state: 'open', signed_off_through: '2026-06-30' })
    expect(out.next).toMatchObject({ tool: 'gnubok_reconcile_match', args: { account_key: `bank:${CASH}`, use_proposals: true, dry_run: true } })
  })

  it('suggests signing off when everything is reconciled, and rejects a malformed window', async () => {
    const { supabase } = createQueuedMockSupabase()
    listMock.mockResolvedValue([
      account({ status: { state: 'reconciled', as_of: '2026-08-23T00:00:00Z', unexplained_difference: 0, open_counts: { proposed: 0, unmatched_external: 0, unmatched_ledger: 0 } } }),
    ])
    const out = (await reconciliationSummaryResource.read({
      supabase: supabase as never,
      companyId: 'company-1',
      userId: 'user-1',
      scopes: [],
    })) as Record<string, unknown>
    expect(out.next).toMatchObject({ tool: 'gnubok_reconcile_signoff' })

    await expect(
      reconciliationSummaryResource.read({
        supabase: supabase as never,
        companyId: 'company-1',
        userId: 'user-1',
        scopes: [],
        query: new URLSearchParams('date_from=20260701'),
      }),
    ).rejects.toThrow(/YYYY-MM-DD/)
  })
})
