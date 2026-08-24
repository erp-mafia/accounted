import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const skvStatusMock = vi.fn()
const fetchUnlinkedMock = vi.fn()

vi.mock('../skattekonto-reconciliation', () => ({
  getSkattekontoReconciliationStatus: (...args: unknown[]) => skvStatusMock(...args),
}))
vi.mock('../bank-reconciliation', () => ({
  fetchUnlinkedGLLines: (...args: unknown[]) => fetchUnlinkedMock(...args),
  scopeTransactionsToAccount: (q: unknown) => q,
}))

import { listAccountItems } from '../items'

const COMPANY = 'company-1'
const CASH = '11111111-1111-4111-8111-111111111111'

function item(id: string, bucket: string) {
  return { item_id: id, bucket, side: 'external', item_type: 'skattekonto_transaction', date: '2026-08-01', description: id, amount: 1, currency: 'SEK', actions: [] }
}

describe('listAccountItems', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    skvStatusMock.mockReset()
    fetchUnlinkedMock.mockReset()
  })

  it('returns null for an invalid key', async () => {
    const { supabase } = createQueuedMockSupabase()
    expect(await listAccountItems(supabase as never, COMPANY, 'nope')).toBeNull()
  })

  it('pages skattekonto buckets in work order and carries the older count', async () => {
    const { supabase } = createQueuedMockSupabase()
    skvStatusMock.mockResolvedValue({
      older_unmatched_count: 2,
      items: {
        proposed: [item('p1', 'proposed')],
        unmatched_external: [item('u1', 'unmatched_external'), item('u2', 'unmatched_external')],
        unmatched_ledger: [item('l1', 'unmatched_ledger')],
        matched: [item('m1', 'matched')],
        ignored: [],
        upcoming: [],
      },
    })

    const all = await listAccountItems(supabase as never, COMPANY, 'skattekonto', { limit: 3, offset: 0 })
    expect(all?.items.map((i) => i.item_id)).toEqual(['p1', 'u1', 'u2'])
    expect(all).toMatchObject({ count: 3, total_count: 5, has_more: true, next_offset: 3, older_unmatched_count: 2 })

    const page2 = await listAccountItems(supabase as never, COMPANY, 'skattekonto', { limit: 3, offset: 3 })
    expect(page2?.items.map((i) => i.item_id)).toEqual(['l1', 'm1'])
    expect(page2?.has_more).toBe(false)

    const onlyLedger = await listAccountItems(supabase as never, COMPANY, 'skattekonto', { bucket: 'unmatched_ledger' })
    expect(onlyLedger?.items.map((i) => i.item_id)).toEqual(['l1'])
    expect(skvStatusMock).toHaveBeenLastCalledWith(supabase, COMPANY, { today: undefined, windowFrom: null, windowTo: null })
  })

  it('buckets bank transactions by ignored / linked / proposed / open and nets unlinked ledger lines per entry', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: CASH, ledger_account: '1930', currency: 'SEK', is_primary: true } })
    enqueue({
      data: [
        { id: 't-ign', date: '2026-08-04', description: 'Dubblett', merchant_name: null, amount: -10, currency: 'SEK', journal_entry_id: null, potential_journal_entry_id: null, potential_match_method: null, potential_match_confidence: null, is_ignored: true, reconciliation_method: null },
        { id: 't-link', date: '2026-08-03', description: 'Lön', merchant_name: null, amount: -31200, currency: 'SEK', journal_entry_id: 'e-1', potential_journal_entry_id: null, potential_match_method: 'manual', potential_match_confidence: null, is_ignored: false, reconciliation_method: 'manual' },
        { id: 't-prop', date: '2026-08-02', description: 'Swish', merchant_name: 'Swish 123', amount: 2400, currency: 'SEK', journal_entry_id: null, potential_journal_entry_id: 'e-2', potential_match_method: 'auto_fuzzy', potential_match_confidence: '0.82', is_ignored: false, reconciliation_method: null },
        { id: 't-open', date: '2026-08-01', description: 'Elgiganten', merchant_name: null, amount: -1046, currency: 'SEK', journal_entry_id: null, potential_journal_entry_id: null, potential_match_method: null, potential_match_confidence: null, is_ignored: false, reconciliation_method: null },
      ],
    })
    fetchUnlinkedMock.mockResolvedValue([
      { line_id: 'l1', journal_entry_id: 'e-3', debit_amount: 0, credit_amount: 600, line_description: null, entry_date: '2026-08-18', voucher_number: 231, voucher_series: 'A', entry_description: 'Elgiganten', source_type: 'manual' },
      { line_id: 'l2', journal_entry_id: 'e-3', debit_amount: 0, credit_amount: 400, line_description: null, entry_date: '2026-08-18', voucher_number: 231, voucher_series: 'A', entry_description: 'Elgiganten', source_type: 'manual' },
    ])

    const result = await listAccountItems(supabase as never, COMPANY, `bank:${CASH}`, { limit: 50 })
    const byId = Object.fromEntries((result?.items ?? []).map((i) => [i.item_id, i]))

    expect(byId['t-prop']).toMatchObject({ bucket: 'proposed', description: 'Swish 123', proposal: { journal_entry_id: 'e-2', confidence: 0.82 } })
    expect(byId['t-open']).toMatchObject({ bucket: 'unmatched_external', actions: ['book', 'match', 'ignore'] })
    expect(byId['t-link']).toMatchObject({ bucket: 'matched', linked_journal_entry_id: 'e-1', actions: ['unmatch'] })
    expect(byId['t-ign']).toMatchObject({ bucket: 'ignored', actions: ['unignore'] })
    expect(byId['e-3']).toMatchObject({ bucket: 'unmatched_ledger', side: 'ledger', amount: -1000, voucher_number: 231 })
    // Work order: proposed, unmatched external, unmatched ledger, ignored, upcoming, matched
    expect(result?.items.map((i) => i.bucket)).toEqual(['proposed', 'unmatched_external', 'unmatched_ledger', 'ignored', 'matched'])
    expect(result?.total_count).toBe(5)
  })

  it('returns null for an unknown cash account', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    expect(await listAccountItems(supabase as never, COMPANY, `bank:${CASH}`)).toBeNull()
  })
})
