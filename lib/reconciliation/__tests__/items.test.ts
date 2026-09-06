import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const skvStatusMock = vi.fn()
const fetchUnlinkedMock = vi.fn()
const junctionMock = vi.fn()

vi.mock('../skattekonto-reconciliation', () => ({
  getSkattekontoReconciliationStatus: (...args: unknown[]) => skvStatusMock(...args),
}))
vi.mock('../bank-reconciliation', () => ({
  fetchUnlinkedGLLines: (...args: unknown[]) => fetchUnlinkedMock(...args),
  fetchJunctionLinkedTxIds: (...args: unknown[]) => junctionMock(...args),
  scopeTransactionsToAccount: (q: unknown) => q,
}))
const coveringSetsMock = vi.fn()
vi.mock('../covering-set-candidate', () => ({
  proposeCoveringSets: (...args: unknown[]) => coveringSetsMock(...args),
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
    junctionMock.mockReset()
    junctionMock.mockResolvedValue(new Set())
    coveringSetsMock.mockReset()
    coveringSetsMock.mockResolvedValue(new Map())
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
        // Anchored only through transaction_voucher_links (bulk-book / residual): matched, pointer NULL.
        { id: 't-junc', date: '2026-07-31', description: 'Samlingsverifikat', merchant_name: null, amount: -500, currency: 'SEK', journal_entry_id: null, potential_journal_entry_id: null, potential_match_method: null, potential_match_confidence: null, is_ignored: false, reconciliation_method: null },
      ],
    })
    junctionMock.mockResolvedValue(new Set(['t-junc']))
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
    expect(byId['t-junc']).toMatchObject({ bucket: 'matched', actions: ['unmatch'] })
    expect(byId['e-3']).toMatchObject({ bucket: 'unmatched_ledger', side: 'ledger', amount: -1000, voucher_number: 231 })
    // Work order: proposed, unmatched external, unmatched ledger, ignored, upcoming, matched
    expect(result?.items.map((i) => i.bucket)).toEqual(['proposed', 'unmatched_external', 'unmatched_ledger', 'ignored', 'matched', 'matched'])
    expect(result?.total_count).toBe(6)
    // Only the rows nothing explains yet are searched for a covering set: not
    // the ignored, linked, junction-anchored or already-proposed ones.
    expect(coveringSetsMock).toHaveBeenCalledTimes(1)
    expect(coveringSetsMock.mock.calls[0][2]).toMatchObject({ ledger_account: '1930', currency: 'SEK' })
    expect((coveringSetsMock.mock.calls[0][3] as Array<{ id: string }>).map((r) => r.id)).toEqual(['t-open'])
  })

  it('moves a bank row a covering set explains into proposed, with every voucher on the proposal (#2293)', async () => {
    const openRow = (id: string, date: string, amount: number) => ({
      id, date, description: 'BGGIRERING 03447786', merchant_name: null, amount, currency: 'SEK', journal_entry_id: null,
      potential_journal_entry_id: null, potential_match_method: null, potential_match_confidence: null, is_ignored: false, reconciliation_method: null,
    })
    const setProposal = {
      journal_entry_id: 'e-57',
      voucher_number: 57,
      voucher_series: 'A',
      entry_date: '2026-07-31',
      description: 'Inbetalning 063 + Inbetalning 064',
      entry_status: 'posted' as const,
      confidence: 0.95,
      reasons: ['exact_sum_same_date'],
      vouchers: [
        { journal_entry_id: 'e-57', voucher_number: 57, voucher_series: 'A', entry_date: '2026-07-31', description: 'Inbetalning 063', amount: 62500 },
        { journal_entry_id: 'e-58', voucher_number: 58, voucher_series: 'A', entry_date: '2026-07-31', description: 'Inbetalning 064', amount: 25750 },
      ],
    }
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: CASH, ledger_account: '1930', currency: 'SEK', is_primary: true } })
    enqueue({ data: [openRow('t-bg', '2026-07-31', 88250), openRow('t-lonely', '2026-07-30', -999)] })
    fetchUnlinkedMock.mockResolvedValue([])
    coveringSetsMock.mockResolvedValue(new Map([['t-bg', setProposal]]))

    const result = await listAccountItems(supabase as never, COMPANY, `bank:${CASH}`, { limit: 50 })
    const byId = Object.fromEntries((result?.items ?? []).map((i) => [i.item_id, i]))

    expect(byId['t-bg']).toMatchObject({ bucket: 'proposed', proposal: setProposal, actions: ['match', 'book', 'ignore'] })
    expect(byId['t-lonely']).toMatchObject({ bucket: 'unmatched_external', proposal: null })
    expect(result?.items.map((i) => i.item_id)).toEqual(['t-bg', 't-lonely'])
  })

  it('keeps a set-explained row out of unmatched_external and skips the search when neither open bucket is wanted', async () => {
    const openRow = {
      id: 't-bg', date: '2026-07-31', description: 'BGGIRERING', merchant_name: null, amount: 88250, currency: 'SEK', journal_entry_id: null,
      potential_journal_entry_id: null, potential_match_method: null, potential_match_confidence: null, is_ignored: false, reconciliation_method: null,
    }
    const proposal = { journal_entry_id: 'e-57', voucher_number: 57, voucher_series: 'A', entry_date: '2026-07-31', description: '', entry_status: 'posted' as const, confidence: 0.95, reasons: ['exact_sum_same_date'], vouchers: [] }
    coveringSetsMock.mockResolvedValue(new Map([['t-bg', proposal]]))

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: CASH, ledger_account: '1930', currency: 'SEK', is_primary: true } })
    enqueue({ data: [openRow] })
    const unmatched = await listAccountItems(supabase as never, COMPANY, `bank:${CASH}`, { bucket: 'unmatched_external' })
    expect(unmatched?.items).toEqual([])
    expect(coveringSetsMock).toHaveBeenCalledTimes(1)

    const other = createQueuedMockSupabase()
    other.enqueue({ data: { id: CASH, ledger_account: '1930', currency: 'SEK', is_primary: true } })
    other.enqueue({ data: [openRow] })
    const matched = await listAccountItems(other.supabase as never, COMPANY, `bank:${CASH}`, { bucket: 'matched' })
    expect(matched?.items).toEqual([])
    expect(coveringSetsMock).toHaveBeenCalledTimes(1)
  })

  it('returns null for an unknown cash account', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    expect(await listAccountItems(supabase as never, COMPANY, `bank:${CASH}`)).toBeNull()
  })
})
