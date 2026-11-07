import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const skvStatusMock = vi.fn()

vi.mock('../skattekonto-reconciliation', () => ({
  getSkattekontoReconciliationStatus: (...args: unknown[]) => skvStatusMock(...args),
}))
const coveringSetsMock = vi.fn()
vi.mock('../covering-set-candidate', () => ({
  proposeCoveringSets: (...args: unknown[]) => coveringSetsMock(...args),
}))

import { listAccountItems, readProposedBankRows } from '../items'

const COMPANY = 'company-1'
const CASH = '11111111-1111-4111-8111-111111111111'

function item(id: string, bucket: string) {
  return { item_id: id, bucket, side: 'external', item_type: 'skattekonto_transaction', date: '2026-08-01', description: id, amount: 1, currency: 'SEK', actions: [] }
}

describe('listAccountItems', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    skvStatusMock.mockReset()
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

  it('lists skattekonto rows before the history only by name, and says how many there are on every skattekonto listing (crm#1153)', async () => {
    const { supabase } = createQueuedMockSupabase()
    skvStatusMock.mockResolvedValue({
      older_unmatched_count: 0,
      skattekonto: { history_start: '2026-01-01', before_history_count: 2, before_history_total: 400 },
      items: {
        proposed: [],
        unmatched_external: [item('u1', 'unmatched_external')],
        unmatched_ledger: [],
        matched: [item('m1', 'matched')],
        ignored: [],
        upcoming: [],
        before_history: [item('b1', 'before_history'), item('b2', 'before_history')],
      },
    })
    const summary = { count: 2, total: 400, history_start: '2026-01-01' }

    // The default listing (the page, v1) is the bridge's rows only, as before.
    const all = await listAccountItems(supabase as never, COMPANY, 'skattekonto')
    expect(all?.items.map((i) => i.item_id)).toEqual(['u1', 'm1'])
    expect(all).toMatchObject({ total_count: 2, has_more: false, before_history: summary })

    const open = await listAccountItems(supabase as never, COMPANY, 'skattekonto', { bucket: 'unmatched_external' })
    expect(open?.items.map((i) => i.item_id)).toEqual(['u1'])
    expect(open?.before_history).toEqual(summary)

    const before = await listAccountItems(supabase as never, COMPANY, 'skattekonto', { bucket: 'before_history' })
    expect(before?.items.map((i) => i.item_id)).toEqual(['b1', 'b2'])
    expect(before).toMatchObject({ total_count: 2, before_history: summary })
  })

  it('carries no before_history block when no row is before the history', async () => {
    const { supabase } = createQueuedMockSupabase()
    skvStatusMock.mockResolvedValue({
      older_unmatched_count: 0,
      skattekonto: { history_start: '2026-01-01', before_history_count: 0, before_history_total: 0 },
      items: { proposed: [], unmatched_external: [], unmatched_ledger: [], matched: [], ignored: [], upcoming: [], before_history: [] },
    })
    const all = await listAccountItems(supabase as never, COMPANY, 'skattekonto')
    expect(all).not.toHaveProperty('before_history')
  })

  // The bank rows come from one read, get_bank_reconciliation_items (its
  // window and link rules are tested against Postgres in
  // tests/pg/bank-reconciliation-facts.pg.test.ts); these tests pin what the
  // listing makes of its answer.
  const ACCOUNT = { id: CASH, ledger_account: '1930', currency: 'SEK', is_primary: true }
  const tx = (row: Record<string, unknown>) => ({
    description: null,
    merchant_name: null,
    currency: 'SEK',
    journal_entry_id: null,
    potential_journal_entry_id: null,
    potential_match_method: null,
    potential_match_confidence: null,
    is_ignored: false,
    reconciliation_method: null,
    linked: Boolean(row.journal_entry_id ?? row.linked_journal_entry_id),
    linked_journal_entry_id: row.journal_entry_id ?? null,
    ...row,
  })
  const read = (answer: Record<string, unknown> = {}) => ({
    data: {
      open_rows: [],
      matched_count: 0,
      matched_rows: [],
      history_start: null,
      ledger_lines: [],
      fiscal_year_starts: [],
      ...answer,
    },
  })
  const rpcArgs = (supabase: { rpc: ReturnType<typeof vi.fn> }) =>
    supabase.rpc.mock.calls.filter((c) => c[0] === 'get_bank_reconciliation_items').map((c) => c[1])

  it('buckets bank transactions by ignored / linked / proposed / open and nets unlinked ledger lines per entry', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: ACCOUNT })
    enqueue(
      read({
        open_rows: [
          tx({ id: 't-ign', date: '2026-08-04', description: 'Dubblett', amount: -10, is_ignored: true }),
          tx({ id: 't-prop', date: '2026-08-02', description: 'Swish', merchant_name: 'Swish 123', amount: 2400, potential_journal_entry_id: 'e-2', potential_match_method: 'auto_fuzzy', potential_match_confidence: '0.82' }),
          tx({ id: 't-open', date: '2026-08-01', description: 'Elgiganten', amount: -1046 }),
        ],
        matched_count: 3,
        matched_rows: [
          tx({ id: 't-link', date: '2026-08-03', description: 'Lön', amount: -31200, journal_entry_id: 'e-1', potential_match_method: 'manual', reconciliation_method: 'manual' }),
          // Anchored only through transaction_voucher_links (a 1:N split): matched, pointer NULL.
          tx({ id: 't-junc', date: '2026-07-31', description: 'Samlingsverifikat', amount: -500, reconciliation_method: 'manual', linked: true, linked_journal_entry_id: 'e-junc-a' }),
          // Booked from itself (categorize): no reconciliation method, so no unmatch (PH 194).
          tx({ id: 't-booked', date: '2026-07-30', description: 'Hyra', amount: -8000, journal_entry_id: 'e-7' }),
        ],
        ledger_lines: [
          { line_id: 'l1', journal_entry_id: 'e-3', debit_amount: 0, credit_amount: 600, line_description: null, entry_date: '2026-08-18', voucher_number: 231, voucher_series: 'A', entry_description: 'Elgiganten', source_type: 'manual' },
          { line_id: 'l2', journal_entry_id: 'e-3', debit_amount: 0, credit_amount: 400, line_description: null, entry_date: '2026-08-18', voucher_number: 231, voucher_series: 'A', entry_description: 'Elgiganten', source_type: 'manual' },
        ],
      }),
    )
    enqueue({ data: [] }) // live settlements on the account: none

    const result = await listAccountItems(supabase as never, COMPANY, `bank:${CASH}`, { limit: 50 })
    const byId = Object.fromEntries((result?.items ?? []).map((i) => [i.item_id, i]))

    expect(byId['t-prop']).toMatchObject({ bucket: 'proposed', description: 'Swish 123', proposal: { journal_entry_id: 'e-2', confidence: 0.82 } })
    expect(byId['t-open']).toMatchObject({ bucket: 'unmatched_external', actions: ['book', 'match', 'ignore'] })
    expect(byId['t-link']).toMatchObject({ bucket: 'matched', linked_journal_entry_id: 'e-1', actions: ['unmatch'] })
    expect(byId['t-ign']).toMatchObject({ bucket: 'ignored', actions: ['unignore'] })
    // A split row reports the first bank_line verifikat, not null (crm#48).
    expect(byId['t-junc']).toMatchObject({ bucket: 'matched', linked_journal_entry_id: 'e-junc-a', actions: ['unmatch'] })
    // Koppla bort refuses a booking (unlinkReconciliation), so the row does not offer it.
    expect(byId['t-booked']).toMatchObject({ bucket: 'matched', linked_journal_entry_id: 'e-7', actions: [] })
    expect(byId['e-3']).toMatchObject({ bucket: 'unmatched_ledger', side: 'ledger', amount: -1000, voucher_number: 231 })
    // Work order: proposed, unmatched external, unmatched ledger, ignored, upcoming, matched
    expect(result?.items.map((i) => i.bucket)).toEqual(['proposed', 'unmatched_external', 'unmatched_ledger', 'ignored', 'matched', 'matched', 'matched'])
    expect(result?.total_count).toBe(7)
    // Only the rows nothing explains yet are searched for a covering set: not
    // the ignored, linked, junction-anchored or already-proposed ones.
    expect(coveringSetsMock).toHaveBeenCalledTimes(1)
    expect(coveringSetsMock.mock.calls[0][2]).toMatchObject({ ledger_account: '1930', currency: 'SEK' })
    expect((coveringSetsMock.mock.calls[0][3] as Array<{ id: string }>).map((r) => r.id)).toEqual(['t-open'])
    // One read: the open rows, the ledger side and the matched rows up to
    // the page's end.
    expect(rpcArgs(supabase as never)).toEqual([
      expect.objectContaining({
        p_company_id: COMPANY,
        p_account_number: '1930',
        p_currency: 'SEK',
        p_cash_account_id: CASH,
        p_include_unassigned: true,
        p_with_rows: true,
        p_with_ledger: true,
        p_matched_offset: 0,
        p_matched_limit: 50,
        p_matched_after_open: true,
      }),
    ])
  })

  it('reads no matched row when the page ends before the matched bucket starts', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: ACCOUNT })
    enqueue(
      read({
        open_rows: [
          tx({ id: 't-1', date: '2026-08-02', amount: -1 }),
          tx({ id: 't-2', date: '2026-08-01', amount: -2 }),
        ],
        matched_count: 27952,
      }),
    )

    const result = await listAccountItems(supabase as never, COMPANY, `bank:${CASH}`, { limit: 2 })

    expect(result?.items.map((i) => i.item_id)).toEqual(['t-1', 't-2'])
    expect(result).toMatchObject({ count: 2, total_count: 27954, has_more: true, next_offset: 2 })
    expect(rpcArgs(supabase as never)).toHaveLength(1)
  })

  it('pages into the matched rows at the offset the earlier buckets leave', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: ACCOUNT })
    // No ledger-only verifikat, so no settlement read. The read returns the
    // matched rows up to the page's end (offset 2 + limit 2) less the open row.
    enqueue(
      read({
        open_rows: [tx({ id: 't-open', date: '2026-08-02', amount: -1 })],
        matched_count: 5,
        matched_rows: [
          tx({ id: 'm-1', date: '2026-07-04', amount: 1, journal_entry_id: 'e-1' }),
          tx({ id: 'm-2', date: '2026-07-03', amount: 2, journal_entry_id: 'e-2' }),
          tx({ id: 'm-3', date: '2026-07-02', amount: 3, journal_entry_id: 'e-3' }),
        ],
      }),
    )
    enqueue({ data: [] }) // the linked verifikat's labels

    // The open row is item 0, the matched rows items 1-5: offset 2 is matched row 1.
    const result = await listAccountItems(supabase as never, COMPANY, `bank:${CASH}`, { limit: 2, offset: 2 })

    expect(result?.items.map((i) => i.item_id)).toEqual(['m-2', 'm-3'])
    expect(result).toMatchObject({ count: 2, total_count: 6, has_more: true, next_offset: 4 })
    expect(rpcArgs(supabase as never)).toEqual([
      expect.objectContaining({ p_matched_offset: 0, p_matched_limit: 4, p_matched_after_open: true }),
    ])
  })

  it('reads a deep page of matched rows on its own, sliced to the page', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: ACCOUNT })
    enqueue(read({ open_rows: [tx({ id: 't-open', date: '2026-08-02', amount: -1 })], matched_count: 1000 }))
    enqueue(
      read({
        matched_count: 1000,
        matched_rows: [
          tx({ id: 'm-400', date: '2026-03-03', amount: 2, journal_entry_id: 'e-2' }),
          tx({ id: 'm-401', date: '2026-03-02', amount: 3, journal_entry_id: 'e-3' }),
        ],
      }),
    )
    enqueue({ data: [] }) // the linked verifikat's labels

    // Item 401 is matched row 400: past what the first read returns ahead.
    const result = await listAccountItems(supabase as never, COMPANY, `bank:${CASH}`, { limit: 2, offset: 401 })

    expect(result?.items.map((i) => i.item_id)).toEqual(['m-400', 'm-401'])
    expect(result).toMatchObject({ count: 2, total_count: 1001, has_more: true, next_offset: 403 })
    expect(rpcArgs(supabase as never)).toEqual([
      expect.objectContaining({ p_with_ledger: true, p_matched_offset: 0, p_matched_limit: 0, p_matched_after_open: false }),
      expect.objectContaining({ p_with_ledger: false, p_matched_offset: 400, p_matched_limit: 2, p_matched_after_open: false }),
    ])
  })

  it('reads the matched slice in the first read when the matched bucket is the one asked for', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: ACCOUNT })
    enqueue(
      read({
        open_rows: [tx({ id: 't-open', date: '2026-08-02', amount: -1 })],
        matched_count: 3,
        matched_rows: [tx({ id: 'm-2', date: '2026-07-03', amount: 2, journal_entry_id: 'e-2' })],
      }),
    )
    enqueue({ data: [] }) // settlements
    enqueue({ data: [] }) // labels

    const result = await listAccountItems(supabase as never, COMPANY, `bank:${CASH}`, { bucket: 'matched', limit: 1, offset: 1 })

    expect(result?.items.map((i) => i.item_id)).toEqual(['m-2'])
    expect(result).toMatchObject({ total_count: 3, has_more: true, next_offset: 2 })
    expect(rpcArgs(supabase as never)).toEqual([
      expect.objectContaining({ p_with_rows: true, p_with_ledger: false, p_matched_offset: 1, p_matched_limit: 1, p_matched_after_open: false }),
    ])
  })

  it('shows the verifikat a 1:1 proposal points at, read in the same batch as the linked ones', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: ACCOUNT })
    enqueue(
      read({
        open_rows: [
          // Booked by hand a day after the bank debit; the matcher proposed it at 0.85.
          tx({ id: 't-prop', date: '2026-08-02', description: 'KORTKÖP KONTORSVAROR', amount: -1250, potential_journal_entry_id: 'e-2', potential_match_method: 'auto_date_range', potential_match_confidence: '0.85' }),
          tx({ id: 't-gone', date: '2026-08-01', description: 'Okänd', amount: -40, potential_journal_entry_id: 'e-missing', potential_match_method: 'auto_fuzzy', potential_match_confidence: 0.75 }),
        ],
        matched_count: 1,
        matched_rows: [
          // Linked, with a stale proposal pointer left behind (a multi-row
          // bulk_book never clears it).
          tx({ id: 't-link', date: '2026-08-05', description: 'Lön', amount: -31200, journal_entry_id: 'e-1', reconciliation_method: 'manual', potential_journal_entry_id: 'e-stale' }),
        ],
        // The proposed verifikat is not linked yet, so the ledger side still lists it.
        ledger_lines: [
          { line_id: 'l1', journal_entry_id: 'e-2', debit_amount: 0, credit_amount: 1250, line_description: null, entry_date: '2026-08-03', voucher_number: 12, voucher_series: 'A', entry_description: 'Kontorsvaror', source_type: 'manual' },
        ],
        fiscal_year_starts: ['2026-01-01'],
      }),
    )
    enqueue({ data: [] }) // settlements
    enqueue({
      data: [
        { id: 'e-1', entry_date: '2026-08-05', voucher_series: 'A', voucher_number: 11, description: 'Lön augusti' },
        { id: 'e-2', entry_date: '2026-08-03', voucher_series: 'A', voucher_number: 12, description: 'Kontorsvaror' },
        { id: 'e-stale', entry_date: '2026-07-30', voucher_series: 'A', voucher_number: 9, description: 'Annat verifikat' },
      ],
    })

    const result = await listAccountItems(supabase as never, COMPANY, `bank:${CASH}`, { limit: 50 })
    const byId = Object.fromEntries((result?.items ?? []).map((i) => [i.item_id, i]))

    // The verifikat's own label, text and date, not the bank date and an empty text.
    expect(byId['t-prop']).toMatchObject({
      bucket: 'proposed',
      date: '2026-08-02',
      proposal: {
        journal_entry_id: 'e-2',
        voucher_series: 'A',
        voucher_number: 12,
        entry_date: '2026-08-03',
        description: 'Kontorsvaror',
        confidence: 0.85,
        reasons: ['auto_date_range'],
      },
    })
    // A verifikat the read does not return keeps the fallback instead of failing the list.
    expect(byId['t-gone'].proposal).toMatchObject({
      journal_entry_id: 'e-missing',
      voucher_series: null,
      voucher_number: null,
      entry_date: '2026-08-01',
      description: '',
    })
    expect(byId['t-link'].linked_entry).toEqual({ entry_date: '2026-08-05', voucher_series: 'A', voucher_number: 11, description: 'Lön augusti' })
    // Only live proposals are filled in: the stale pointer on the matched row
    // keeps its fallback rather than showing another verifikat's label.
    expect(byId['t-link']).toMatchObject({ bucket: 'matched', proposal: { journal_entry_id: 'e-stale', voucher_number: null, description: '' } })
    // One journal_entries read serves the linked row and both live proposals.
    const reads = findCalls('journal_entries', 'in')
    expect(reads).toHaveLength(1)
    expect([...(reads[0][1] as string[])].sort()).toEqual(['e-1', 'e-2', 'e-missing'])
    // The API bucket is unchanged: Matcha manuellt, MCP and v1 still get the
    // proposed verifikat as unmatched ledger, so a proposal can be overridden.
    expect(byId['e-2']).toMatchObject({ bucket: 'unmatched_ledger', voucher_number: 12, amount: -1250 })
  })

  it('moves a bank row a covering set explains into proposed, with every voucher on the proposal (#2293)', async () => {
    const openRow = (id: string, date: string, amount: number) =>
      tx({ id, date, description: 'BGGIRERING 03447786', amount })
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
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: ACCOUNT })
    enqueue(read({ open_rows: [openRow('t-bg', '2026-07-31', 88250), openRow('t-lonely', '2026-07-30', -999)] }))
    coveringSetsMock.mockResolvedValue(new Map([['t-bg', setProposal]]))

    const result = await listAccountItems(supabase as never, COMPANY, `bank:${CASH}`, { limit: 50 })
    const byId = Object.fromEntries((result?.items ?? []).map((i) => [i.item_id, i]))

    expect(byId['t-bg']).toMatchObject({ bucket: 'proposed', proposal: setProposal, actions: ['match', 'book', 'ignore'] })
    expect(byId['t-lonely']).toMatchObject({ bucket: 'unmatched_external', proposal: null })
    expect(result?.items.map((i) => i.item_id)).toEqual(['t-bg', 't-lonely'])
    // A set proposal already carries its verifikat: no extra read for it.
    expect(findCalls('journal_entries', 'in')).toEqual([])
  })

  it('reads for use_proposals exactly the rows the listing puts in proposed, sum-matched ones included (crm#1668)', async () => {
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
    const rows = [
      tx({ id: 't-bg', date: '2026-07-31', amount: 88250 }),
      tx({ id: 't-1to1', date: '2026-07-20', amount: -400, potential_journal_entry_id: 'e-9', potential_match_method: 'auto_date_range', potential_match_confidence: 0.85 }),
      tx({ id: 't-lonely', date: '2026-07-30', amount: -999 }),
      tx({ id: 't-ign', date: '2026-07-29', amount: 5, is_ignored: true, potential_journal_entry_id: 'e-10', potential_match_confidence: 0.95 }),
    ]
    coveringSetsMock.mockResolvedValue(new Map([['t-bg', setProposal]]))

    const listing = createQueuedMockSupabase()
    listing.enqueue({ data: ACCOUNT })
    listing.enqueue(read({ open_rows: rows }))
    const listed = await listAccountItems(listing.supabase as never, COMPANY, `bank:${CASH}`, { bucket: 'proposed' })

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: ACCOUNT })
    enqueue(read({ open_rows: rows }))
    const proposed = await readProposedBankRows(supabase as never, COMPANY, CASH)

    expect(proposed?.map((r) => r.transaction_id)).toEqual(listed?.items.map((i) => i.item_id))
    expect(proposed?.map((r) => [r.transaction_id, r.proposal.reasons[0], r.proposal.confidence])).toEqual([
      ['t-bg', 'exact_sum_same_date', 0.95],
      ['t-1to1', 'auto_date_range', 0.85],
    ])
    expect(proposed?.[0].proposal.vouchers?.map((v) => v.journal_entry_id)).toEqual(['e-57', 'e-58'])
    // The whole account, every open row: no window, no ledger side, no matched rows.
    expect(rpcArgs(supabase as never)[0]).toMatchObject({
      p_cash_account_id: CASH,
      p_include_unassigned: true,
      p_date_from: null,
      p_date_to: null,
      p_with_rows: true,
      p_with_ledger: false,
      p_matched_limit: 0,
    })
  })

  it('answers null for an account that is not the company\'s', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    expect(await readProposedBankRows(supabase as never, COMPANY, CASH)).toBeNull()
  })

  it('keeps a set-explained row out of unmatched_external and skips the search when neither open bucket is wanted', async () => {
    const openRow = tx({ id: 't-bg', date: '2026-07-31', description: 'BGGIRERING', amount: 88250 })
    const proposal = { journal_entry_id: 'e-57', voucher_number: 57, voucher_series: 'A', entry_date: '2026-07-31', description: '', entry_status: 'posted' as const, confidence: 0.95, reasons: ['exact_sum_same_date'], vouchers: [] }
    coveringSetsMock.mockResolvedValue(new Map([['t-bg', proposal]]))

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: ACCOUNT })
    enqueue(read({ open_rows: [openRow] }))
    const unmatched = await listAccountItems(supabase as never, COMPANY, `bank:${CASH}`, { bucket: 'unmatched_external' })
    expect(unmatched?.items).toEqual([])
    expect(coveringSetsMock).toHaveBeenCalledTimes(1)

    const other = createQueuedMockSupabase()
    other.enqueue({ data: ACCOUNT })
    other.enqueue(read({ open_rows: [openRow] }))
    const matched = await listAccountItems(other.supabase as never, COMPANY, `bank:${CASH}`, { bucket: 'matched' })
    expect(matched?.items).toEqual([])
    expect(coveringSetsMock).toHaveBeenCalledTimes(1)
  })

  it('lists the matched rows the read puts in the window, as the status counts them', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: ACCOUNT })
    enqueue(
      read({
        matched_count: 2,
        matched_rows: [
          tx({ id: 't-in', date: '2026-08-05', description: 'Insättning', amount: -5000, journal_entry_id: 'e-a', reconciliation_method: 'manual' }),
          // Dated before the window, linked to a verifikat inside it.
          tx({ id: 't-pre', date: '2026-07-17', description: 'Insättning', amount: 25000, journal_entry_id: 'e-6', reconciliation_method: 'manual' }),
        ],
      }),
    )
    enqueue({ data: [] }) // settlements
    enqueue({ data: [] }) // labels

    const res = await listAccountItems(supabase as never, COMPANY, `bank:${CASH}`, {
      bucket: 'matched',
      windowFrom: '2026-07-30',
      windowTo: '2027-06-30',
    })

    expect(rpcArgs(supabase as never)[0]).toMatchObject({ p_date_from: '2026-07-30', p_date_to: '2027-06-30', p_cash_account_id: CASH })
    expect(res?.items.map((i) => i.item_id)).toEqual(['t-in', 't-pre'])
    expect(res?.items[1]).toMatchObject({ bucket: 'matched', linked_journal_entry_id: 'e-6' })
  })

  it('offers Ignorera on a hand-made row booked without the bank, and nothing new on a normal booking (PH 214)', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: ACCOUNT })
    enqueue(
      read({
        matched_count: 3,
        matched_rows: [
          // A sale typed in as a transaction, booked on the clearing account (1580).
          tx({ id: 't-sale', date: '2026-08-12', description: 'Försäljning', amount: 3797.5, journal_entry_id: 'e-sale' }),
          // A normal booking from the row: debit 1930.
          tx({ id: 't-rent', date: '2026-08-10', description: 'Hyra', amount: -8000, journal_entry_id: 'e-rent' }),
          // A link (not a booking) keeps its Koppla bort and is not read.
          tx({ id: 't-link', date: '2026-08-05', description: 'Lön', amount: -31200, journal_entry_id: 'e-1', reconciliation_method: 'manual' }),
        ],
      }),
    )
    enqueue({ data: [] }) // settlements
    enqueue({ data: [] }) // labels
    // The rows booked from themselves, with where they came from.
    enqueue({
      data: [
        { id: 't-sale', journal_entry_id: 'e-sale', cash_account_id: null, currency: 'SEK', amount: 3797.5, bank_connection_id: null, import_source: null, invoice_id: null, supplier_invoice_id: null },
        { id: 't-rent', journal_entry_id: 'e-rent', cash_account_id: CASH, currency: 'SEK', amount: -8000, bank_connection_id: null, import_source: null, invoice_id: null, supplier_invoice_id: null },
      ],
    })
    enqueue({ data: [{ ledger_account: '1930' }] }) // settlement of the unbound row
    enqueue({ data: { ledger_account: '1930', currency: 'SEK' } }) // settlement of the bound row
    enqueue({ data: [{ id: 'e-sale', status: 'posted' }, { id: 'e-rent', status: 'posted' }] })
    enqueue({ data: [{ journal_entry_id: 'e-rent', account_number: '1930', debit_amount: 0, credit_amount: 8000 }] })
    enqueue({ data: [] }) // voucher links
    enqueue({ data: [] }) // invoice payments
    enqueue({ data: [] }) // supplier payments

    const res = await listAccountItems(supabase as never, COMPANY, `bank:${CASH}`, { bucket: 'matched' })
    const byId = Object.fromEntries((res?.items ?? []).map((i) => [i.item_id, i]))

    expect(byId['t-sale']).toMatchObject({ bucket: 'matched', actions: ['ignore'] })
    expect(byId['t-rent']).toMatchObject({ bucket: 'matched', actions: [] })
    expect(byId['t-link']).toMatchObject({ bucket: 'matched', actions: ['unmatch'] })
    expect(findCalls('transactions', 'in')).toEqual([['id', ['t-sale', 't-rent']]])
  })

  it('lists a partially allocated verifikat with only its remainder (agent feedback seq 854089)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: ACCOUNT })
    enqueue(
      read({
        ledger_lines: [
          // -300 on 1930, of which a 1:N slice settles -100.
          { line_id: 'l1', journal_entry_id: 'e-part', debit_amount: 0, credit_amount: 300, line_description: null, entry_date: '2026-08-05', voucher_number: 7, voucher_series: 'A', entry_description: 'Betalning', source_type: 'supplier_invoice_paid', remaining_amount: -200 },
          { line_id: 'l2', journal_entry_id: 'e-credit', debit_amount: 200, credit_amount: 0, line_description: null, entry_date: '2026-08-05', voucher_number: 8, voucher_series: 'A', entry_description: 'Kreditnota', source_type: 'supplier_invoice_paid', remaining_amount: null },
        ],
        fiscal_year_starts: ['2026-01-01'],
      }),
    )

    const result = await listAccountItems(supabase as never, COMPANY, `bank:${CASH}`, { bucket: 'unmatched_ledger' })
    const byId = Object.fromEntries((result?.items ?? []).map((i) => [i.item_id, i]))

    expect(byId['e-part']).toMatchObject({ bucket: 'unmatched_ledger', amount: -200 })
    expect(byId['e-credit']).toMatchObject({ bucket: 'unmatched_ledger', amount: 200 })
    // A ledger bucket alone reads no bank row.
    expect(rpcArgs(supabase as never)[0]).toMatchObject({ p_with_rows: false, p_with_ledger: true })
  })

  it('offers Märk som IB only on a manual or imported verifikat dated on a fiscal year start, with no bank link (agent feedback seq 878478)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: ACCOUNT })
    const line = { debit_amount: 5000, credit_amount: 0, line_description: null, voucher_series: 'A', entry_description: 'Verifikat', remaining_amount: null }
    enqueue(
      read({
        ledger_lines: [
          { ...line, line_id: 'l1', journal_entry_id: 'e-ib', entry_date: '2026-01-01', voucher_number: 1, source_type: 'manual' },
          { ...line, line_id: 'l2', journal_entry_id: 'e-ib-sie', entry_date: '2025-01-01', voucher_number: 1, source_type: 'import' },
          // A rättelse dated mid-year: a movement, never an IB.
          { ...line, line_id: 'l3', journal_entry_id: 'e-rattelse', entry_date: '2026-09-21', voucher_number: 17, source_type: 'manual' },
          // Year start, but booked by a flow the RPC refuses to re-tag.
          { ...line, line_id: 'l4', journal_entry_id: 'e-bank', entry_date: '2026-01-01', voucher_number: 2, source_type: 'bank_transaction' },
          // Year start, but 1:N slices already settle part of it.
          { ...line, line_id: 'l5', journal_entry_id: 'e-part', entry_date: '2026-01-01', voucher_number: 3, source_type: 'manual', remaining_amount: 1000 },
        ],
        fiscal_year_starts: ['2025-01-01', '2026-01-01'],
      }),
    )

    const result = await listAccountItems(supabase as never, COMPANY, `bank:${CASH}`, { bucket: 'unmatched_ledger' })
    const eligible = Object.fromEntries((result?.items ?? []).map((i) => [i.item_id, i.ib_eligible]))

    expect(eligible).toEqual({
      'e-ib': true,
      'e-ib-sie': true,
      'e-rattelse': false,
      'e-bank': false,
      'e-part': false,
    })
  })

  describe('verifikat before the bank history (crm#1221)', () => {
    const line = { credit_amount: 0, line_description: null, voucher_series: 'A', source_type: 'import', remaining_amount: null }
    const lines = [
      { ...line, line_id: 'l1', journal_entry_id: 'e-sie-1', debit_amount: 5000, entry_date: '2026-03-10', voucher_number: 12, entry_description: 'Kundbetalning' },
      { ...line, line_id: 'l2', journal_entry_id: 'e-sie-2', debit_amount: 0, credit_amount: 2000, entry_date: '2026-05-20', voucher_number: 40, entry_description: 'Hyra' },
      { ...line, line_id: 'l3', journal_entry_id: 'e-open', debit_amount: 0, credit_amount: 50000, entry_date: '2026-08-01', voucher_number: 7, source_type: 'manual', entry_description: 'Överföring' },
    ]

    it('lists them only by name, as review rows, and says how many there are on every bank listing', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: ACCOUNT })
      enqueue(read({ ledger_lines: lines, history_start: '2026-07-17' }))
      enqueue({ data: [] }) // settlements

      const before = await listAccountItems(supabase as never, COMPANY, `bank:${CASH}`, {
        bucket: 'before_history',
        windowFrom: '2026-01-01',
        windowTo: '2026-10-15',
      })

      expect(rpcArgs(supabase as never)[0]).toMatchObject({ p_with_ledger: true, p_cash_account_id: CASH, p_currency: 'SEK', p_include_unassigned: true })
      expect(before?.items.map((i) => i.item_id)).toEqual(['e-sie-1', 'e-sie-2'])
      expect(before?.items[0]).toMatchObject({
        bucket: 'before_history',
        side: 'ledger',
        before_history: true,
        amount: 5000,
        actions: ['review'],
      })
      expect(before?.before_history).toEqual({ count: 2, total: 3000, history_start: '2026-07-17' })

      const { supabase: s2, enqueue: enqueue2 } = createQueuedMockSupabase()
      enqueue2({ data: ACCOUNT })
      enqueue2(read({ ledger_lines: lines, history_start: '2026-07-17' }))
      enqueue2({ data: [] })
      const open = await listAccountItems(s2 as never, COMPANY, `bank:${CASH}`, {
        bucket: 'unmatched_ledger',
        windowFrom: '2026-01-01',
        windowTo: '2026-10-15',
      })
      // The verifikat inside the history stays work; the two before it are not.
      expect(open?.items.map((i) => i.item_id)).toEqual(['e-open'])
      expect(open?.before_history).toEqual({ count: 2, total: 3000, history_start: '2026-07-17' })
    })

    it('splits nothing when the window starts inside the history or ends before it', async () => {
      for (const window of [
        { windowFrom: '2026-08-01', windowTo: '2026-08-31' },
        { windowFrom: '2026-01-01', windowTo: '2026-06-30' },
      ]) {
        const { supabase, enqueue } = createQueuedMockSupabase()
        enqueue({ data: ACCOUNT })
        enqueue(read({ ledger_lines: lines, history_start: '2026-07-17' }))
        enqueue({ data: [] })
        const result = await listAccountItems(supabase as never, COMPANY, `bank:${CASH}`, { bucket: 'unmatched_ledger', ...window })
        expect(result?.items).toHaveLength(3)
        expect(result).not.toHaveProperty('before_history')
      }
    })

    it('does not ask for the ledger side when no ledger bucket is asked for', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: ACCOUNT })
      enqueue(read({ history_start: '2026-07-17', ledger_lines: lines }))
      const result = await listAccountItems(supabase as never, COMPANY, `bank:${CASH}`, { bucket: 'unmatched_external' })
      expect(rpcArgs(supabase as never)[0]).toMatchObject({ p_with_rows: true, p_with_ledger: false })
      expect(result).not.toHaveProperty('before_history')
    })
  })

  it('returns null for an unknown cash account', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    expect(await listAccountItems(supabase as never, COMPANY, `bank:${CASH}`)).toBeNull()
  })

  it('throws when the rows cannot be read, rather than offering Bokför on a booked row', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: ACCOUNT })
    enqueue({ data: null, error: { message: 'boom' } })
    await expect(listAccountItems(supabase as never, COMPANY, `bank:${CASH}`)).rejects.toThrow(/Kunde inte hämta transaktioner: boom/)
  })
})
