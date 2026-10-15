import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  DecisionReceiptSchema,
  buildDecisionReceipt,
  fetchDecisionRowsInWindow,
  getDecisionReceipts,
  loadReceiptContext,
  toCompactDecision,
  type ReceiptContext,
  type SuggestionLogRow,
} from '../receipts'

const CO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const TX = '11111111-1111-4111-8111-111111111111'
const JE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const DOC = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const OP = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a'
const ROW = '22222222-2222-4222-8222-222222222222'

const rule = {
  source: 'rule',
  source_id: 'rule:r1',
  rank: 0,
  proposal: { booking: { kind: 'account', account: '5410', vat_treatment: 'standard_25', category: 'expense_equipment' }, debit_account: '5410', credit_account: '1930', vat_treatment: 'standard_25' },
  confidence: 0.92,
  model: null,
  prompt_sha256: null,
  matches_final: true,
}
const assistant = {
  source: 'assistant',
  source_id: `assistant:${TX}`,
  rank: 1,
  proposal: { booking: { kind: 'account', account: '6540', vat_treatment: 'standard_25', category: 'expense_software' }, debit_account: '6540', credit_account: '1930', vat_treatment: 'standard_25' },
  confidence: 0.64,
  model: 'claude-x',
  prompt_sha256: 'abc123',
  matches_final: false,
  contested: true,
}

function bankRow(overrides: Partial<SuggestionLogRow> = {}): SuggestionLogRow {
  return {
    id: ROW,
    kind: 'bank_line',
    transaction_id: TX,
    inbox_item_id: null,
    document_id: DOC,
    suggestions: [rule, assistant],
    acted_on: 0,
    final: { journal_entry_id: JE, booking: null, account: '5410', vat_treatment: 'standard_25', lines: [] },
    outcome: 'accepted',
    actor_type: 'api_key',
    resolved_by: 'user-1',
    created_at: '2026-10-01T10:00:00.000Z',
    ...overrides,
  }
}

const emptyCtx: ReceiptContext = { entries: new Map(), operations: new Map() }

const entry = { id: JE, voucher_series: 'A', voucher_number: 12, status: 'posted', committed_actor_type: 'api_key', committed_actor_label: 'Zapier', commit_method: 'api_key' }
const op = {
  id: OP,
  operation_type: 'categorize_transaction',
  actor_type: 'api_key',
  actor_id: 'key-1',
  actor_label: 'Zapier',
  risk_level: 'low',
  agent_metadata: { model: 'claude-y', prompt_hash: 'p1' },
  created_at: '2026-10-01T09:58:00.000Z',
  resolved_at: '2026-10-01T10:00:01.000Z',
  journal_entry_id: JE,
  registration_journal_entry_id: null,
}

describe('buildDecisionReceipt', () => {
  it('turns a bank-line decision into a receipt with explicit nulls for what is not recorded yet', () => {
    const r = buildDecisionReceipt(bankRow(), { entries: new Map([[JE, entry]]), operations: new Map([[JE, op]]) })
    expect(r).toMatchObject({
      receipt_id: ROW,
      subject_kind: 'bank_line',
      decided_at: '2026-10-01T10:00:00.000Z',
      outcome: 'accepted',
      decided_by: { actor_type: 'api_key', user_id: 'user-1', label: 'Zapier', commit_method: 'api_key' },
      proposed_by: { pending_operation_id: OP, operation_type: 'categorize_transaction', actor_type: 'api_key', label: 'Zapier', model: 'claude-y', prompt_hash: 'p1' },
      booked: { journal_entry_id: JE, voucher: 'A12', entry_status: 'posted', account: '5410', vat_treatment: 'standard_25', supplier_invoice_id: null, changed_fields: [] },
      evidence: { transaction_id: TX, inbox_item_id: null, document_ids: [DOC] },
      confidence: { value: 0.92, basis: 'backing' },
      rule_version: null,
      policy_version: null,
      input_hash: null,
      checks: null,
      confidence_band: null,
    })
    expect(r.candidates.map((c) => [c.source, c.accounts, c.contested])).toEqual([
      ['rule', ['5410'], false],
      ['assistant', ['6540'], true],
    ])
    expect(r.chosen).toBe(r.candidates[0])
    // The receipt is exactly the documented v1 shape.
    expect(DecisionReceiptSchema.safeParse(r).success).toBe(true)
  })

  it('a manual booking has no chosen suggestion and no confidence', () => {
    const r = buildDecisionReceipt(bankRow({ acted_on: null, outcome: 'manual' }), emptyCtx)
    expect(r.chosen).toBeNull()
    expect(r.confidence).toEqual({ value: null, basis: null })
    // Without the voucher row the receipt still names the entry, just not its number.
    expect(r.booked).toMatchObject({ journal_entry_id: JE, voucher: null, entry_status: null })
    expect(r.decided_by.label).toBeNull()
    expect(r.proposed_by).toBeNull()
  })

  it('a dismissed bank line books nothing', () => {
    const r = buildDecisionReceipt(bankRow({ acted_on: null, outcome: 'dismissed', final: null, actor_type: 'user' }), emptyCtx)
    expect(r.booked).toBeNull()
    expect(r.outcome).toBe('dismissed')
  })

  it("labels an underlag extraction's score as the model's own, never as backing", () => {
    const r = buildDecisionReceipt(
      bankRow({
        kind: 'inbox_item',
        transaction_id: null,
        inbox_item_id: 'item-1',
        suggestions: [{ source: 'extraction', source_id: DOC, rank: 0, proposal: { fields: { total: 1250, accounts: ['5410', '6110'] }, suggested_template_id: null }, confidence: 0.9, model: 'reader-1', prompt_sha256: null, matches_final: false }],
        acted_on: 0,
        outcome: 'changed',
        final: { supplier_invoice_id: 'si-1', journal_entry_id: JE, fields: { total: 1300 }, lines: [], changed_fields: ['total'] },
      }),
      emptyCtx,
    )
    expect(r.chosen).toMatchObject({ source: 'extraction', accounts: ['5410', '6110'], confidence: 0.9 })
    expect(r.confidence).toEqual({ value: 0.9, basis: 'model_reported' })
    expect(r.booked).toMatchObject({ supplier_invoice_id: 'si-1', changed_fields: ['total'] })
    expect(DecisionReceiptSchema.safeParse(r).success).toBe(true)
  })

  it('skips suggestion shapes it does not know and coerces an unknown actor to user', () => {
    const r = buildDecisionReceipt(bankRow({ suggestions: [{ source: 'oracle' }, 'junk', rule], acted_on: 2, actor_type: 'robot' }), emptyCtx)
    expect(r.candidates).toHaveLength(1)
    // acted_on indexes the stored list; a dropped entry makes the index point nowhere.
    expect(r.chosen).toBeNull()
    expect(r.decided_by.actor_type).toBe('user')
  })
})

describe('toCompactDecision', () => {
  it('keeps the newest receipt small: no nulls, counts the rest', () => {
    const ctx = { entries: new Map([[JE, entry]]), operations: new Map([[JE, op]]) }
    const newest = buildDecisionReceipt(bankRow(), ctx)
    const older = buildDecisionReceipt(bankRow({ id: 'older', created_at: '2026-09-01T10:00:00.000Z' }), ctx)
    expect(toCompactDecision([newest, older])).toEqual({
      receipt_id: ROW,
      decided_at: '2026-10-01T10:00:00.000Z',
      outcome: 'accepted',
      decided_by: { actor_type: 'api_key', label: 'Zapier' },
      proposed_by: { pending_operation_id: OP, actor_type: 'api_key', label: 'Zapier', model: 'claude-y' },
      chosen: { source: 'rule', accounts: ['5410'], confidence: 0.92, confidence_basis: 'backing' },
      alternatives: [{ source: 'assistant', accounts: ['6540'] }],
      evidence: { transaction_id: TX, document_ids: [DOC] },
      other_receipts: 1,
    })
  })

  it('returns null without a receipt', () => {
    expect(toCompactDecision([])).toBeNull()
  })
})

describe('getDecisionReceipts', () => {
  const mock = createQueuedMockSupabase()
  const supabase = mock.supabase as unknown as SupabaseClient

  beforeEach(() => mock.reset())

  it('reads the decision rows about a voucher and joins its committed actor and the operation that booked it', async () => {
    mock.enqueue({ data: [bankRow()] }) // suggestion_log
    mock.enqueue({ data: [entry] }) // journal_entries
    mock.enqueue({ data: [op] }) // pending_operations by journal_entry_id
    mock.enqueue({ data: [] }) // pending_operations by registration_journal_entry_id
    const receipts = await getDecisionReceipts(supabase, CO, { journalEntryId: JE })
    expect(receipts).toHaveLength(1)
    expect(receipts[0].booked?.voucher).toBe('A12')
    expect(receipts[0].proposed_by?.pending_operation_id).toBe(OP)
    // Company-scoped on every read, and the voucher is found from the row.
    expect(mock.findCall('suggestion_log', 'eq')).toEqual(['company_id', CO])
    expect(mock.findCalls('suggestion_log', 'eq')).toContainEqual(['final->>journal_entry_id', JE])
    expect(mock.findCall('journal_entries', 'eq')).toEqual(['company_id', CO])
    expect(mock.findCalls('pending_operations', 'eq')).toContainEqual(['status', 'committed'])
  })

  it('filters by bank line or document', async () => {
    mock.enqueue({ data: [] })
    await getDecisionReceipts(supabase, CO, { transactionId: TX })
    expect(mock.findCalls('suggestion_log', 'eq')).toContainEqual(['transaction_id', TX])
    mock.reset()
    mock.enqueue({ data: [] })
    await getDecisionReceipts(supabase, CO, { documentId: DOC })
    expect(mock.findCalls('suggestion_log', 'eq')).toContainEqual(['document_id', DOC])
  })

  it('returns an empty list and reads nothing else when no decision was recorded', async () => {
    mock.enqueue({ data: [] })
    expect(await getDecisionReceipts(supabase, CO, { journalEntryId: JE })).toEqual([])
    expect(mock.calls.some((c) => c.table !== 'suggestion_log')).toBe(false)
  })

  it('throws on a database error instead of answering "no decision"', async () => {
    mock.enqueue({ error: { message: 'boom', code: '57014' } })
    await expect(getDecisionReceipts(supabase, CO, { journalEntryId: JE })).rejects.toThrow()
  })

  it('links an underlag registration through registration_journal_entry_id', async () => {
    mock.enqueue({ data: [{ id: JE, voucher_series: 'D', voucher_number: 3, status: 'posted', committed_actor_label: null, commit_method: 'user_accept' }] })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [{ ...op, operation_type: 'create_supplier_invoice_from_inbox', journal_entry_id: null, registration_journal_entry_id: JE }] })
    const ctx = await loadReceiptContext(supabase, CO, [bankRow({ kind: 'inbox_item' })])
    expect(ctx.operations.get(JE)?.operation_type).toBe('create_supplier_invoice_from_inbox')
  })

  it('skips the voucher read for vouchers the caller already holds', async () => {
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [] })
    const ctx = await loadReceiptContext(supabase, CO, [bankRow()], { knownEntries: new Map([[JE, entry]]) })
    expect(ctx.entries.get(JE)?.voucher_number).toBe(12)
    expect(mock.calls.some((c) => c.table === 'journal_entries')).toBe(false)
  })
})

describe('fetchDecisionRowsInWindow', () => {
  const mock = createQueuedMockSupabase()
  const supabase = mock.supabase as unknown as SupabaseClient

  beforeEach(() => mock.reset())

  it("unions the window with the decisions that booked the year's vouchers, once each", async () => {
    mock.enqueue({ data: [bankRow()] }) // windowed
    mock.enqueue({ data: [bankRow(), bankRow({ id: 'late', created_at: '2027-01-10T08:00:00.000Z' })] }) // by voucher
    const rows = await fetchDecisionRowsInWindow(supabase, CO, { fromTs: '2026-01-01T00:00:00.000Z', toTs: '2026-12-31T23:59:59.999Z' }, [JE])
    expect(rows.map((r) => r.id).sort()).toEqual(['late', ROW].sort())
    expect(mock.findCalls('suggestion_log', 'in')).toEqual([['final->>journal_entry_id', [JE]]])
  })
})
