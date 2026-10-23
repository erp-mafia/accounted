import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  DecisionReceiptSchema,
  buildDecisionReceipt,
  fetchPeriodDecisions,
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
  it('turns a bank-line decision recorded before step 2 into a receipt with explicit nulls for what it lacks', () => {
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

  it('reads the rules, policy, inputs hash, guards and band as they were recorded', () => {
    const checks = [
      { id: 'already_booked', result: 'pass', detail: null },
      { id: 'duplicate', result: 'warn', detail: 'force:journal_entry:je-0' },
    ]
    const r = buildDecisionReceipt(
      bankRow({
        rule_version: 'bank-proposals.1+a38016f12abc',
        policy_version: 'direct-booking.1;assistant_sure=0.8;counterpart_seen=3;calibrator=none',
        input_hash: 'a'.repeat(64),
        checks,
        confidence_band: 'direct',
      }),
      emptyCtx,
    )
    expect(r).toMatchObject({
      rule_version: 'bank-proposals.1+a38016f12abc',
      policy_version: 'direct-booking.1;assistant_sure=0.8;counterpart_seen=3;calibrator=none',
      input_hash: 'a'.repeat(64),
      checks,
      confidence_band: 'direct',
    })
    expect(DecisionReceiptSchema.safeParse(r).success).toBe(true)
  })

  it("carries the assistant read's agreement, candidate origin and reasoning hash on its candidate", () => {
    const r = buildDecisionReceipt(
      bankRow({ suggestions: [rule, { ...assistant, agreement: 0.67, from_candidate: true, reasoning_sha256: 'r'.repeat(64) }] }),
      emptyCtx,
    )
    expect(r.candidates[0]).toMatchObject({ agreement: null, from_candidate: null, reasoning_sha256: null })
    expect(r.candidates[1]).toMatchObject({ agreement: 0.67, from_candidate: true, reasoning_sha256: 'r'.repeat(64) })
  })

  it('keeps only well-formed guards and a known band, and never invents either', () => {
    const r = buildDecisionReceipt(
      bankRow({ checks: [{ id: 'chart', result: 'pass' }, { id: 'x', result: 'maybe' }, 'junk'], confidence_band: 'auto' }),
      emptyCtx,
    )
    expect(r.checks).toEqual([{ id: 'chart', result: 'pass', detail: null }])
    expect(r.confidence_band).toBeNull()
    expect(buildDecisionReceipt(bankRow({ checks: [] }), emptyCtx).checks).toEqual([])
  })

  it('reads the proposing operation by the id the row names, not by the voucher', () => {
    const other = { ...op, id: 'op-other', actor_label: 'Claude' }
    const r = buildDecisionReceipt(bankRow({ pending_operation_id: 'op-other' }), {
      entries: new Map(),
      operations: new Map([[JE, op]]),
      operationsById: new Map([['op-other', other]]),
    })
    expect(r.proposed_by).toMatchObject({ pending_operation_id: 'op-other', label: 'Claude' })
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

  it('adds the rules version and the band when they were recorded, nothing else', () => {
    const r = buildDecisionReceipt(
      bankRow({ rule_version: 'bank-proposals.1+a38016f12abc', policy_version: 'direct-booking.1', input_hash: 'a'.repeat(64), checks: [], confidence_band: 'review' }),
      emptyCtx,
    )
    const compact = toCompactDecision([r])
    expect(compact).toMatchObject({ rule_version: 'bank-proposals.1+a38016f12abc', confidence_band: 'review' })
    expect(compact).not.toHaveProperty('policy_version')
    expect(compact).not.toHaveProperty('input_hash')
    expect(compact).not.toHaveProperty('checks')
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

  it('reads a named operation by id and leaves voucher matching to rows that name none', async () => {
    mock.enqueue({ data: [bankRow({ pending_operation_id: OP })] }) // suggestion_log
    mock.enqueue({ data: [op] }) // pending_operations by id
    mock.enqueue({ data: [entry] }) // journal_entries
    const receipts = await getDecisionReceipts(supabase, CO, { journalEntryId: JE })
    expect(receipts[0].proposed_by?.pending_operation_id).toBe(OP)
    expect(mock.findCalls('pending_operations', 'in')).toEqual([['id', [OP]]])
    // Company-scoped, and not limited to committed: the row exists because the approval booked it.
    expect(mock.findCalls('pending_operations', 'eq')).toEqual([['company_id', CO]])
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

describe('fetchPeriodDecisions', () => {
  const mock = createQueuedMockSupabase()
  const supabase = mock.supabase as unknown as SupabaseClient
  const window = { fromTs: '2026-01-01T00:00:00.000Z', toTs: '2026-12-31T23:59:59.999Z' }

  beforeEach(() => {
    mock.reset()
    mock.supabase.rpc.mockClear()
  })

  it("reads the period's decisions and what their receipts read in one call, scoped to the company and period", async () => {
    const named = bankRow({ id: 'named', pending_operation_id: OP })
    mock.enqueue({ data: [{ rows: [bankRow(), named], entries: [entry], operations: [op], legacy_by_entry: [op], legacy_by_registration: [] }] })
    const { rows, context } = await fetchPeriodDecisions(supabase, CO, { periodId: 'period-1', window, fiscalYear: true })
    expect(mock.supabase.rpc).toHaveBeenCalledWith('behandlingshistorik_decisions', {
      p_company_id: CO,
      p_period_id: 'period-1',
      p_from: window.fromTs,
      p_to: window.toTs,
      p_fiscal_year: true,
    })
    // No id list leaves the process: no table read at all.
    expect(mock.calls).toEqual([])
    expect(rows.map((r) => r.id)).toEqual([ROW, 'named'])
    expect(context.entries.get(JE)?.voucher_number).toBe(12)
    expect(context.operationsById?.get(OP)?.operation_type).toBe('categorize_transaction')
    expect(context.operations.get(JE)?.id).toBe(OP)
  })

  it('builds the context loadReceiptContext builds from the same rows', async () => {
    const rows = [bankRow(), bankRow({ id: 'named', pending_operation_id: OP }), bankRow({ id: 'inbox', kind: 'inbox_item' })]
    const registration = { ...op, id: 'op-reg', operation_type: 'create_supplier_invoice_from_inbox', journal_entry_id: null, registration_journal_entry_id: JE, resolved_at: '2026-10-02T08:00:00.000Z' }
    // loadReceiptContext: ops by id, vouchers, then committed ops by voucher (by entry, by registration).
    mock.enqueue({ data: [op] })
    mock.enqueue({ data: [entry] })
    mock.enqueue({ data: [op] })
    mock.enqueue({ data: [registration] })
    const expected = await loadReceiptContext(supabase, CO, rows)
    mock.reset()
    mock.enqueue({ data: [{ rows, entries: [entry], operations: [op], legacy_by_entry: [op], legacy_by_registration: [registration] }] })
    const { context } = await fetchPeriodDecisions(supabase, CO, { periodId: 'period-1', window, fiscalYear: true })
    expect(context).toEqual(expected)
    // The later approval of the two that carried the voucher.
    expect(context.operations.get(JE)?.id).toBe('op-reg')
  })

  it('answers no decisions for a period without any', async () => {
    mock.enqueue({ data: [{ rows: [], entries: [], operations: [], legacy_by_entry: [], legacy_by_registration: [] }] })
    const result = await fetchPeriodDecisions(supabase, CO, { periodId: 'period-1', window, fiscalYear: false })
    expect(result.rows).toEqual([])
    expect(result.context.entries.size).toBe(0)
    expect(result.context.operations.size).toBe(0)
  })

  it('throws with the SQLSTATE instead of answering "no decision"', async () => {
    mock.enqueue({ error: { message: 'canceling statement due to statement timeout', code: '57014' } })
    await expect(fetchPeriodDecisions(supabase, CO, { periodId: 'period-1', window, fiscalYear: true })).rejects.toMatchObject({ code: '57014' })
  })
})
