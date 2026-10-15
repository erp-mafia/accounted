import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPagedMockSupabase, createQueuedMockSupabase, manyRows } from '@/tests/helpers'

const skvStatusMock = vi.fn()
const fetchUnlinkedMock = vi.fn()
const junctionMock = vi.fn()
const alignMock = vi.fn()
const historyStartMock = vi.fn()

vi.mock('../skattekonto-reconciliation', () => ({
  getSkattekontoReconciliationStatus: (...args: unknown[]) => skvStatusMock(...args),
}))
vi.mock('../bank-reconciliation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../bank-reconciliation')>()
  return {
    fetchUnlinkedGLLines: (...args: unknown[]) => fetchUnlinkedMock(...args),
    fetchJunctionLinkMap: (...args: unknown[]) => junctionMock(...args),
    scopeTransactionsToAccount: (q: unknown) => q,
    alignLinkedTransactionsToWindow: (...args: unknown[]) => alignMock(...args),
    fetchBankHistoryStart: (...args: unknown[]) => historyStartMock(...args),
    // Pure: the real per-verifikat rule.
    openAmountByEntry: actual.openAmountByEntry,
  }
})
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
    junctionMock.mockResolvedValue(new Map())
    alignMock.mockReset()
    alignMock.mockImplementation(async (o: { rows: unknown[]; junctionLinks: Map<string, string[]> }) => ({
      rows: o.rows,
      junctionLinks: o.junctionLinks,
    }))
    coveringSetsMock.mockReset()
    coveringSetsMock.mockResolvedValue(new Map())
    historyStartMock.mockReset()
    historyStartMock.mockResolvedValue(null)
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
    junctionMock.mockResolvedValue(new Map([['t-junc', ['e-junc-a', 'e-junc-b']]]))
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
    // A split row reports the first bank_line verifikat, not null (crm#48).
    expect(byId['t-junc']).toMatchObject({ bucket: 'matched', linked_journal_entry_id: 'e-junc-a', actions: ['unmatch'] })
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

  it('shows the verifikat a 1:1 proposal points at, read in the same batch as the linked ones', async () => {
    const row = {
      description: null, merchant_name: null, currency: 'SEK', journal_entry_id: null, potential_journal_entry_id: null,
      potential_match_method: null, potential_match_confidence: null, is_ignored: false, reconciliation_method: null,
    }
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: CASH, ledger_account: '1930', currency: 'SEK', is_primary: true } })
    enqueue({
      data: [
        // Linked, with a stale proposal pointer left behind (a multi-row
        // bulk_book never clears it).
        { ...row, id: 't-link', date: '2026-08-05', description: 'Lön', amount: -31200, journal_entry_id: 'e-1', reconciliation_method: 'manual', potential_journal_entry_id: 'e-stale' },
        // Booked by hand a day after the bank debit; the matcher proposed it at 0.85.
        { ...row, id: 't-prop', date: '2026-08-02', description: 'KORTKÖP KONTORSVAROR', amount: -1250, potential_journal_entry_id: 'e-2', potential_match_method: 'auto_date_range', potential_match_confidence: '0.85' },
        { ...row, id: 't-gone', date: '2026-08-01', description: 'Okänd', amount: -40, potential_journal_entry_id: 'e-missing', potential_match_method: 'auto_fuzzy', potential_match_confidence: 0.75 },
      ],
    })
    // The proposed verifikat is not linked yet, so the ledger side still lists it.
    fetchUnlinkedMock.mockResolvedValue([
      { line_id: 'l1', journal_entry_id: 'e-2', debit_amount: 0, credit_amount: 1250, line_description: null, entry_date: '2026-08-03', voucher_number: 12, voucher_series: 'A', entry_description: 'Kontorsvaror', source_type: 'manual' },
    ])
    enqueue({ data: [{ period_start: '2026-01-01' }] }) // fiscal year starts (Märk som IB)
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
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: CASH, ledger_account: '1930', currency: 'SEK', is_primary: true } })
    enqueue({ data: [openRow('t-bg', '2026-07-31', 88250), openRow('t-lonely', '2026-07-30', -999)] })
    fetchUnlinkedMock.mockResolvedValue([])
    coveringSetsMock.mockResolvedValue(new Map([['t-bg', setProposal]]))

    const result = await listAccountItems(supabase as never, COMPANY, `bank:${CASH}`, { limit: 50 })
    const byId = Object.fromEntries((result?.items ?? []).map((i) => [i.item_id, i]))

    expect(byId['t-bg']).toMatchObject({ bucket: 'proposed', proposal: setProposal, actions: ['match', 'book', 'ignore'] })
    expect(byId['t-lonely']).toMatchObject({ bucket: 'unmatched_external', proposal: null })
    expect(result?.items.map((i) => i.item_id)).toEqual(['t-bg', 't-lonely'])
    // A set proposal already carries its verifikat: no extra read for it.
    expect(findCalls('journal_entries', 'in')).toEqual([])
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

  it('lists a linked row in the window of its verifikat, like the status counts it', async () => {
    const base = {
      description: 'Insättning', merchant_name: null, currency: 'SEK', potential_journal_entry_id: null,
      potential_match_method: null, potential_match_confidence: null, is_ignored: false, reconciliation_method: 'manual',
    }
    const inWindow = { ...base, id: 't-in', date: '2026-08-05', amount: -5000, journal_entry_id: 'e-a' }
    const before = { ...base, id: 't-pre', date: '2026-07-17', amount: 25000, journal_entry_id: 'e-6' }
    alignMock.mockImplementation(async (o: { rows: unknown[]; junctionLinks: Map<string, string[]> }) => ({
      rows: [...o.rows, before],
      junctionLinks: o.junctionLinks,
    }))

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: CASH, ledger_account: '1930', currency: 'SEK', is_primary: true } })
    enqueue({ data: [inWindow] })
    const res = await listAccountItems(supabase as never, COMPANY, `bank:${CASH}`, {
      bucket: 'matched',
      windowFrom: '2026-07-30',
      windowTo: '2027-06-30',
    })

    expect(alignMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bankAccount: '1930',
        from: '2026-07-30',
        to: '2027-06-30',
        readFrom: '2026-07-30',
        readTo: '2027-06-30',
        cashAccountId: CASH,
        includeUnassigned: true,
      }),
    )
    expect(res?.items.map((i) => i.item_id)).toEqual(['t-in', 't-pre'])
    expect(res?.items[1]).toMatchObject({ bucket: 'matched', linked_journal_entry_id: 'e-6' })
  })

  it('lists a partially allocated verifikat with only its remainder (agent feedback seq 854089)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: CASH, ledger_account: '1930', currency: 'SEK', is_primary: true } })
    fetchUnlinkedMock.mockResolvedValue([
      // -300 on 1930, of which a 1:N slice settles -100.
      { line_id: 'l1', journal_entry_id: 'e-part', debit_amount: 0, credit_amount: 300, line_description: null, entry_date: '2026-08-05', voucher_number: 7, voucher_series: 'A', entry_description: 'Betalning', source_type: 'supplier_invoice_paid', remaining_amount: -200 },
      { line_id: 'l2', journal_entry_id: 'e-credit', debit_amount: 200, credit_amount: 0, line_description: null, entry_date: '2026-08-05', voucher_number: 8, voucher_series: 'A', entry_description: 'Kreditnota', source_type: 'supplier_invoice_paid', remaining_amount: null },
    ])
    enqueue({ data: [{ period_start: '2026-01-01' }] })

    const result = await listAccountItems(supabase as never, COMPANY, `bank:${CASH}`, { bucket: 'unmatched_ledger' })
    const byId = Object.fromEntries((result?.items ?? []).map((i) => [i.item_id, i]))

    expect(byId['e-part']).toMatchObject({ bucket: 'unmatched_ledger', amount: -200 })
    expect(byId['e-credit']).toMatchObject({ bucket: 'unmatched_ledger', amount: 200 })
  })

  it('offers Märk som IB only on a manual or imported verifikat dated on a fiscal year start, with no bank link (agent feedback seq 878478)', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: CASH, ledger_account: '1930', currency: 'SEK', is_primary: true } })
    const line = { debit_amount: 5000, credit_amount: 0, line_description: null, voucher_series: 'A', entry_description: 'Verifikat', remaining_amount: null }
    fetchUnlinkedMock.mockResolvedValue([
      { ...line, line_id: 'l1', journal_entry_id: 'e-ib', entry_date: '2026-01-01', voucher_number: 1, source_type: 'manual' },
      { ...line, line_id: 'l2', journal_entry_id: 'e-ib-sie', entry_date: '2025-01-01', voucher_number: 1, source_type: 'import' },
      // A rättelse dated mid-year: a movement, never an IB.
      { ...line, line_id: 'l3', journal_entry_id: 'e-rattelse', entry_date: '2026-09-21', voucher_number: 17, source_type: 'manual' },
      // Year start, but booked by a flow the RPC refuses to re-tag.
      { ...line, line_id: 'l4', journal_entry_id: 'e-bank', entry_date: '2026-01-01', voucher_number: 2, source_type: 'bank_transaction' },
      // Year start, but 1:N slices already settle part of it.
      { ...line, line_id: 'l5', journal_entry_id: 'e-part', entry_date: '2026-01-01', voucher_number: 3, source_type: 'manual', remaining_amount: 1000 },
    ])
    enqueue({ data: [{ period_start: '2025-01-01' }, { period_start: '2026-01-01' }] })

    const result = await listAccountItems(supabase as never, COMPANY, `bank:${CASH}`, { bucket: 'unmatched_ledger' })
    const eligible = Object.fromEntries((result?.items ?? []).map((i) => [i.item_id, i.ib_eligible]))

    expect(eligible).toEqual({
      'e-ib': true,
      'e-ib-sie': true,
      'e-rattelse': false,
      'e-bank': false,
      'e-part': false,
    })
    expect(findCalls('fiscal_periods', 'eq')[0]).toEqual(['company_id', COMPANY])
  })

  it('offers Märk som IB on nothing when the fiscal years cannot be read', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: CASH, ledger_account: '1930', currency: 'SEK', is_primary: true } })
    fetchUnlinkedMock.mockResolvedValue([
      { line_id: 'l1', journal_entry_id: 'e-ib', debit_amount: 5000, credit_amount: 0, line_description: null, entry_date: '2026-01-01', voucher_number: 1, voucher_series: 'A', entry_description: 'IB', source_type: 'manual', remaining_amount: null },
    ])
    enqueue({ data: null, error: { message: 'boom' } })

    const result = await listAccountItems(supabase as never, COMPANY, `bank:${CASH}`, { bucket: 'unmatched_ledger' })

    expect(result?.items[0]).toMatchObject({ item_id: 'e-ib', ib_eligible: false })
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
      enqueue({ data: { id: CASH, ledger_account: '1930', currency: 'SEK', is_primary: true } })
      fetchUnlinkedMock.mockResolvedValue(lines)
      enqueue({ data: [] })
      historyStartMock.mockResolvedValue('2026-07-17')

      const before = await listAccountItems(supabase as never, COMPANY, `bank:${CASH}`, {
        bucket: 'before_history',
        windowFrom: '2026-01-01',
        windowTo: '2026-10-15',
      })

      expect(historyStartMock).toHaveBeenCalledWith(supabase, COMPANY, CASH, 'SEK', true)
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
      enqueue2({ data: { id: CASH, ledger_account: '1930', currency: 'SEK', is_primary: true } })
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
      historyStartMock.mockResolvedValue('2026-07-17')
      for (const window of [
        { windowFrom: '2026-08-01', windowTo: '2026-08-31' },
        { windowFrom: '2026-01-01', windowTo: '2026-06-30' },
      ]) {
        const { supabase, enqueue } = createQueuedMockSupabase()
        enqueue({ data: { id: CASH, ledger_account: '1930', currency: 'SEK', is_primary: true } })
        fetchUnlinkedMock.mockResolvedValue(lines)
        enqueue({ data: [] })
        const result = await listAccountItems(supabase as never, COMPANY, `bank:${CASH}`, { bucket: 'unmatched_ledger', ...window })
        expect(result?.items).toHaveLength(3)
        expect(result).not.toHaveProperty('before_history')
      }
    })

    it('does not read the history start when no ledger bucket is asked for', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: { id: CASH, ledger_account: '1930', currency: 'SEK', is_primary: true } })
      enqueue({ data: [] })
      await listAccountItems(supabase as never, COMPANY, `bank:${CASH}`, { bucket: 'unmatched_external' })
      expect(historyStartMock).not.toHaveBeenCalled()
    })
  })

  it('returns null for an unknown cash account', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    expect(await listAccountItems(supabase as never, COMPANY, `bank:${CASH}`)).toBeNull()
  })

  it('lists every bank row of an account with more than 1,000, not the first 1,000', async () => {
    const { supabase, findCalls } = createPagedMockSupabase({
      cash_accounts: [{ id: CASH, ledger_account: '1930', currency: 'SEK', is_primary: true }],
      transactions: manyRows(1001, (i) => ({
        id: `tx-${String(i).padStart(4, '0')}`,
        date: '2026-08-01',
        description: `rad ${i}`,
        merchant_name: null,
        amount: -100,
        currency: 'SEK',
        journal_entry_id: null,
        potential_journal_entry_id: null,
        potential_match_method: null,
        potential_match_confidence: null,
        is_ignored: false,
        reconciliation_method: null,
      })),
    })

    const result = await listAccountItems(supabase as never, COMPANY, `bank:${CASH}`, { bucket: 'unmatched_external' })

    expect(result?.total_count).toBe(1001)
    // Paged on a total order: date, then the unique id.
    expect(findCalls('transactions', 'order').map((a) => a[0])).toEqual(expect.arrayContaining(['date', 'id']))
  })
})
