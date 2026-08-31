import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { getLatestSignoffs, insertSignoff, listSignoffs, mapSignoffRow, stampReopen } from '../signoff-store'

const { supabase, enqueue, reset, findCall } = createQueuedMockSupabase()
const COMPANY = 'company-1'

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sig-1',
    account_key: 'skattekonto',
    through_date: '2026-07-31',
    external_balance: '1000.00',
    ledger_balance: 1000,
    unexplained_difference: '0.004',
    note: null,
    signed_by: 'user-1',
    signed_at: '2026-08-23T10:00:00Z',
    reopened_at: null,
    reopened_by: null,
    reopen_reason: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
})

describe('signoff-store', () => {
  it('maps numeric strings to öre-rounded numbers', () => {
    const mapped = mapSignoffRow(row())
    expect(mapped.external_balance).toBe(1000)
    expect(mapped.ledger_balance).toBe(1000)
    expect(mapped.unexplained_difference).toBe(0)
  })

  it('getLatestSignoffs keeps the first (newest) active row per account', async () => {
    enqueue({
      data: [
        row({ id: 'a', account_key: 'skattekonto', through_date: '2026-07-31' }),
        row({ id: 'b', account_key: 'skattekonto', through_date: '2026-06-30' }),
        row({ id: 'c', account_key: 'bank:11111111-1111-4111-8111-111111111111', through_date: '2026-07-31' }),
      ],
    })
    const latest = await getLatestSignoffs(supabase as never, COMPANY)
    expect(latest.get('skattekonto')?.id).toBe('a')
    expect(latest.get('bank:11111111-1111-4111-8111-111111111111')?.id).toBe('c')
    expect(supabase.from).toHaveBeenCalledWith('account_reconciliations')
  })

  it('listSignoffs excludes reopened rows unless asked and clamps the limit', async () => {
    enqueue({ data: [row()] })
    await listSignoffs(supabase as never, COMPANY, 'skattekonto', { limit: 5000 })
    expect(findCall('account_reconciliations', 'is')).toEqual(['reopened_at', null])
    expect(findCall('account_reconciliations', 'limit')).toEqual([200])

    reset()
    enqueue({ data: [row()] })
    await listSignoffs(supabase as never, COMPANY, 'skattekonto', { includeReopened: true })
    expect(findCall('account_reconciliations', 'is')).toBeUndefined()
  })

  it('insertSignoff returns the mapped row and throws on error', async () => {
    enqueue({ data: row() })
    const inserted = await insertSignoff(supabase as never, COMPANY, {
      account_key: 'skattekonto',
      through_date: '2026-07-31',
      external_balance: 1000,
      ledger_balance: 1000,
      unexplained_difference: 0,
      note: null,
      signed_by: 'user-1',
    })
    expect(inserted.id).toBe('sig-1')

    enqueue({ data: null, error: { message: 'duplicate key value violates unique constraint "ux_account_reconciliations_active"' } })
    await expect(
      insertSignoff(supabase as never, COMPANY, {
        account_key: 'skattekonto',
        through_date: '2026-07-31',
        external_balance: 1000,
        ledger_balance: 1000,
        unexplained_difference: 0,
        note: null,
        signed_by: 'user-1',
      }),
    ).rejects.toThrow(/ux_account_reconciliations_active/)
  })

  it('stampReopen guards on reopened_at IS NULL and returns null when nothing matched', async () => {
    enqueue({ data: null })
    const result = await stampReopen(supabase as never, COMPANY, 'sig-1', { reopened_by: 'user-1', reason: null })
    expect(result).toBeNull()
    expect(findCall('account_reconciliations', 'is')).toEqual(['reopened_at', null])
  })
})
