/**
 * Unit tests for commitCreateVoucher and commitCorrectEntry executors.
 * The executors aren't exported individually, so we drive them through the
 * public `commitPendingOperation` dispatcher.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { createQueuedMockSupabase, makeJournalEntry } from '@/tests/helpers'
import type { PendingOperation } from '@/types'

vi.mock('@/lib/bookkeeping/engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/engine')>(
    '@/lib/bookkeeping/engine'
  )
  return {
    ...actual,
    createJournalEntry: vi.fn(),
    findFiscalPeriod: vi.fn(),
    reverseEntry: vi.fn(),
  }
})

vi.mock('@/lib/core/bookkeeping/storno-service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/core/bookkeeping/storno-service')>(
    '@/lib/core/bookkeeping/storno-service'
  )
  return {
    ...actual,
    correctEntry: vi.fn(),
  }
})

vi.mock('@/lib/core/documents/document-service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/core/documents/document-service')>(
    '@/lib/core/documents/document-service'
  )
  return {
    ...actual,
    linkToJournalEntry: vi.fn(),
  }
})

import { commitPendingOperation } from '../commit'
import { getActor, type CommitActor } from '@/lib/bookkeeping/actor-context'
import { createJournalEntry, findFiscalPeriod, reverseEntry } from '@/lib/bookkeeping/engine'
import { correctEntry } from '@/lib/core/bookkeeping/storno-service'
import { linkToJournalEntry } from '@/lib/core/documents/document-service'

function makePendingOp(overrides: Partial<PendingOperation>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'create_voucher',
    status: 'pending',
    title: 'test',
    params: {},
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'high',
    created_at: '2026-05-12T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-05-12T00:00:00Z',
    ...overrides,
  } as PendingOperation
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

// ─── create_voucher ─────────────────────────────────────────────────

describe('commitPendingOperation: create_voucher', () => {
  it('happy path: posts a balanced entry with the provided fiscal_period_id', async () => {
    vi.mocked(createJournalEntry).mockResolvedValueOnce(
      makeJournalEntry({ id: 'je-100', voucher_number: 42, voucher_series: 'A' })
    )

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's commit update

    const op = makePendingOp({
      params: {
        entry_date: '2026-05-12',
        description: 'Capitalize Cursor subscription to 1010',
        fiscal_period_id: 'fp-1',
        lines: [
          { account_number: '1010', debit_amount: 250, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 250 },
        ],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      journal_entry_id: 'je-100',
      voucher_number: 42,
      voucher_series: 'A',
      fiscal_period_id: 'fp-1',
    })
    expect(createJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({
        fiscal_period_id: 'fp-1',
        entry_date: '2026-05-12',
        description: 'Capitalize Cursor subscription to 1010',
        source_type: 'manual',
      }),
      // Default commit_method when opts.commitMethod is not passed.
      // Must be one of the values allowed by the DB CHECK constraint
      // (migration 20260420120001_journal_entry_commit_metadata.sql).
      'user_accept'
    )
    // findFiscalPeriod must NOT be called when fiscal_period_id is supplied:
    // it's the caller's explicit choice.
    expect(findFiscalPeriod).not.toHaveBeenCalled()
  })

  it('runs the executor inside the opts.actor attribution scope (migration 20260619120000)', async () => {
    // The real commitEntry reads getActor() and forwards it to the commit RPC.
    // Here we assert the dispatcher establishes the scope around the executor:
    // the engine mock captures what attribution it would have seen.
    let seenActor: CommitActor | undefined
    vi.mocked(createJournalEntry).mockImplementationOnce(async () => {
      seenActor = getActor()
      return makeJournalEntry({ id: 'je-101', voucher_number: 43, voucher_series: 'A' })
    })

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's commit update

    const op = makePendingOp({
      params: {
        entry_date: '2026-05-12',
        description: 'Attribution scope test',
        fiscal_period_id: 'fp-1',
        lines: [
          { account_number: '1010', debit_amount: 100, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 100 },
        ],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op, {
      actor: { type: 'api_key', label: 'Claude Desktop' },
    })

    expect(result.status).toBe('committed')
    expect(seenActor).toEqual({ type: 'api_key', label: 'Claude Desktop' })
  })

  it('leaves attribution unset when opts.actor is omitted (pre-attribution behaviour)', async () => {
    let seenActor: CommitActor | undefined = { type: 'system' } // sentinel, must be overwritten
    vi.mocked(createJournalEntry).mockImplementationOnce(async () => {
      seenActor = getActor()
      return makeJournalEntry({ id: 'je-102', voucher_number: 44, voucher_series: 'A' })
    })

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: null })

    const op = makePendingOp({
      params: {
        entry_date: '2026-05-12',
        description: 'No actor scope',
        fiscal_period_id: 'fp-1',
        lines: [
          { account_number: '1010', debit_amount: 100, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 100 },
        ],
      },
    })

    await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)
    expect(seenActor).toBeUndefined()
  })

  it('resolves fiscal_period from entry_date when omitted', async () => {
    vi.mocked(findFiscalPeriod).mockResolvedValueOnce('fp-resolved')
    vi.mocked(createJournalEntry).mockResolvedValueOnce(
      makeJournalEntry({ id: 'je-101', voucher_number: 7 })
    )

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's commit update

    const op = makePendingOp({
      params: {
        entry_date: '2026-05-12',
        description: 'no fiscal_period_id',
        lines: [
          { account_number: '5410', debit_amount: 100, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 100 },
        ],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ fiscal_period_id: 'fp-resolved' })
    expect(findFiscalPeriod).toHaveBeenCalledWith(expect.anything(), 'company-1', '2026-05-12')
  })

  it('returns 400 in Swedish when no fiscal period covers the date', async () => {
    vi.mocked(findFiscalPeriod).mockResolvedValueOnce(null)

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const op = makePendingOp({
      params: {
        entry_date: '2027-12-31',
        description: 'far-future date',
        lines: [
          { account_number: '5410', debit_amount: 100, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 100 },
        ],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/räkenskapsperiod/i)
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  it('returns 400 when required fields are missing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const op = makePendingOp({
      params: {
        entry_date: '2026-05-12',
        // missing description and lines
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  it('hardcodes source_type to manual even if params.source_type is tampered', async () => {
    vi.mocked(createJournalEntry).mockResolvedValueOnce(
      makeJournalEntry({ id: 'je-tamper', voucher_number: 8 })
    )

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's commit update

    const op = makePendingOp({
      params: {
        entry_date: '2026-05-12',
        description: 'attempt to spoof source_type',
        fiscal_period_id: 'fp-1',
        // Direct DB insert or future stager could put anything here.
        source_type: 'bank_transaction',
        lines: [
          { account_number: '1010', debit_amount: 100, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 100 },
        ],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    // Critical assertion: source_type is ALWAYS 'manual', never the
    // caller-supplied value. Bypassing this lets a tampered operation
    // misrepresent the audit trail as a bank-feed or invoice entry.
    expect(createJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ source_type: 'manual' }),
      'user_accept'
    )
    expect(createJournalEntry).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ source_type: 'bank_transaction' }),
      expect.anything()
    )
  })

  // ── opening-balance (IB) flow ──────────────────────────────────────
  // gnubok_create_voucher accepts a typed boolean is_opening_balance. The
  // executor derives source_type='opening_balance' (so bank reconciliation
  // excludes the IB from period movement) ONLY after re-validating the entry:
  // every line must be a balance-sheet account (class 1/2) AND entry_date must
  // equal the fiscal period's period_start. It never trusts a raw source_type.

  it('opening_balance: derives source_type=opening_balance for a valid IB (class 1/2 lines, dated on period_start)', async () => {
    vi.mocked(createJournalEntry).mockResolvedValueOnce(
      makeJournalEntry({ id: 'je-ib', voucher_number: 1, voucher_series: 'A' })
    )

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { period_start: '2026-01-01', name: '2026' }, error: null }) // fiscal_periods lookup
    enqueue({ data: null, error: null }) // dispatcher's commit update

    const op = makePendingOp({
      params: {
        entry_date: '2026-01-01',
        description: 'Ingående balanser (migrering)',
        fiscal_period_id: 'fp-1',
        is_opening_balance: true,
        lines: [
          { account_number: '1930', debit_amount: 5000, credit_amount: 0 },
          { account_number: '2081', debit_amount: 0, credit_amount: 5000 },
        ],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(createJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ source_type: 'opening_balance' }),
      'user_accept'
    )
  })

  it('opening_balance: rejects with 400 when any line is a P&L account (class 3-8)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const op = makePendingOp({
      params: {
        entry_date: '2026-01-01',
        description: 'IB with a revenue account smuggled in',
        fiscal_period_id: 'fp-1',
        is_opening_balance: true,
        lines: [
          { account_number: '1930', debit_amount: 5000, credit_amount: 0 },
          { account_number: '3001', debit_amount: 0, credit_amount: 5000 },
        ],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/balanskonton|3001/i)
    // No period lookup and no engine call once a P&L account is detected.
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  it('opening_balance: rejects with 400 when entry_date is not the fiscal period start', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { period_start: '2026-01-01', name: '2026' }, error: null }) // fiscal_periods lookup
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const op = makePendingOp({
      params: {
        entry_date: '2026-03-15',
        description: 'IB dated mid-year',
        fiscal_period_id: 'fp-1',
        is_opening_balance: true,
        lines: [
          { account_number: '1930', debit_amount: 5000, credit_amount: 0 },
          { account_number: '2081', debit_amount: 0, credit_amount: 5000 },
        ],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/första dag|2026-01-01/i)
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  it('opening_balance absent: source_type stays manual (no period lookup, unchanged behaviour)', async () => {
    vi.mocked(createJournalEntry).mockResolvedValueOnce(
      makeJournalEntry({ id: 'je-manual', voucher_number: 50 })
    )

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's commit update

    const op = makePendingOp({
      params: {
        entry_date: '2026-03-15',
        description: 'ordinary manual voucher, mid-year, on class-1 accounts',
        fiscal_period_id: 'fp-1',
        // is_opening_balance omitted: must NOT trigger the IB path or its
        // extra fiscal_periods lookup, even though the lines are class 1/2.
        lines: [
          { account_number: '1930', debit_amount: 250, credit_amount: 0 },
          { account_number: '1910', debit_amount: 0, credit_amount: 250 },
        ],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(createJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ source_type: 'manual' }),
      'user_accept'
    )
  })

  it('passes bulk_accept commit_method when invoked from the bulk-commit path', async () => {
    // The bulk-commit route passes opts.commitMethod = 'bulk_accept' so the
    // resulting journal_entry rows are tagged correctly per BFNAR 2013:2
    // behandlingshistorik. Without this assertion, a regression that drops
    // opts on the way to the engine would silently book everything as
    // 'user_accept'.
    vi.mocked(createJournalEntry).mockResolvedValueOnce(
      makeJournalEntry({ id: 'je-bulk', voucher_number: 9 })
    )

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's commit update

    const op = makePendingOp({
      params: {
        entry_date: '2026-05-12',
        description: 'bulk-approved voucher',
        fiscal_period_id: 'fp-1',
        lines: [
          { account_number: '1010', debit_amount: 100, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 100 },
        ],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op, {
      commitMethod: 'bulk_accept',
    })

    expect(result.status).toBe('committed')
    expect(createJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.anything(),
      'bulk_accept'
    )
  })

  it('returns 400 with Swedish error when params are unbalanced (tamper defense)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const op = makePendingOp({
      params: {
        entry_date: '2026-05-12',
        description: 'tampered: debit ≠ credit',
        fiscal_period_id: 'fp-1',
        // The MCP tool validates balance before staging, but a hand-inserted
        // pending_operations row could bypass that. The executor's own
        // validateBalance() gate catches it before reaching the engine.
        lines: [
          { account_number: '1010', debit_amount: 1000, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 800 },
        ],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/balanserar inte/i)
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  // ── inbox-direct booking flow ──────────────────────────────────────
  // gnubok_create_voucher accepts an optional inbox_item_id. On commit, the
  // executor must stamp invoice_inbox_items.created_journal_entry_id (the
  // signal that drops the row out of "needs action") and attach the OCR
  // document to the new JE. Status is left untouched: the status CHECK only
  // allows received|error, so the link column alone marks the row processed.

  it('inbox-direct: posts the entry, links the inbox row, and attaches the document', async () => {
    vi.mocked(createJournalEntry).mockResolvedValueOnce(
      makeJournalEntry({ id: 'je-inbox', voucher_number: 17, voucher_series: 'A' })
    )
    vi.mocked(linkToJournalEntry).mockResolvedValueOnce({
      id: 'doc-1',
      journal_entry_id: 'je-inbox',
    } as never)

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: [{ id: 'inbox-1' }], error: null }) // inbox update: 1 row claimed
    enqueue({ data: null, error: null }) // dispatcher's commit update

    const op = makePendingOp({
      params: {
        entry_date: '2026-05-12',
        description: 'Kvitto Clas Ohlson: adapter',
        fiscal_period_id: 'fp-1',
        inbox_item_id: 'inbox-1',
        document_id: 'doc-1',
        lines: [
          { account_number: '5410', debit_amount: 250, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 250 },
        ],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      journal_entry_id: 'je-inbox',
      inbox_item_id: 'inbox-1',
      inbox_linked: true,
    })
    expect(linkToJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'doc-1',
      'je-inbox',
    )
  })

  it('inbox-direct without document_id: links the inbox row but does not attempt document attach', async () => {
    vi.mocked(createJournalEntry).mockResolvedValueOnce(
      makeJournalEntry({ id: 'je-no-doc', voucher_number: 18 })
    )

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: [{ id: 'inbox-1' }], error: null }) // inbox update: 1 row claimed
    enqueue({ data: null, error: null }) // dispatcher's commit update

    const op = makePendingOp({
      params: {
        entry_date: '2026-05-12',
        description: 'inbox without scanned doc',
        fiscal_period_id: 'fp-1',
        inbox_item_id: 'inbox-1',
        document_id: null,
        lines: [
          { account_number: '5410', debit_amount: 250, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 250 },
        ],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ inbox_linked: true, inbox_item_id: 'inbox-1' })
    expect(linkToJournalEntry).not.toHaveBeenCalled()
  })

  it('inbox-direct: document attach failure does NOT roll back the posted entry', async () => {
    // The verifikat is already posted and immutable: failing the doc link
    // must not cascade into a failed commit, only a logged warning.
    vi.mocked(createJournalEntry).mockResolvedValueOnce(
      makeJournalEntry({ id: 'je-link-fails', voucher_number: 19 })
    )
    vi.mocked(linkToJournalEntry).mockRejectedValueOnce(new Error('storage RLS denied'))

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: [{ id: 'inbox-1' }], error: null }) // inbox update: 1 row claimed
    enqueue({ data: null, error: null }) // dispatcher's commit update

    const op = makePendingOp({
      params: {
        entry_date: '2026-05-12',
        description: 'doc link fails',
        fiscal_period_id: 'fp-1',
        inbox_item_id: 'inbox-1',
        document_id: 'doc-1',
        lines: [
          { account_number: '5410', debit_amount: 250, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 250 },
        ],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ journal_entry_id: 'je-link-fails', inbox_linked: true })
  })

  it('inbox-direct: zero-rows-updated (another commit already claimed the inbox): voucher posted, inbox_linked=false, no doc attach', async () => {
    // Race scenario the .is('created_journal_entry_id', null) predicate is
    // designed to catch: two pending ops on the same inbox item commit in
    // parallel, the loser sees 0 rows updated.
    vi.mocked(createJournalEntry).mockResolvedValueOnce(
      makeJournalEntry({ id: 'je-race-loser', voucher_number: 22 })
    )

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: [], error: null }) // inbox update returned ZERO rows (race lost)
    enqueue({ data: null, error: null }) // dispatcher's commit update

    const op = makePendingOp({
      params: {
        entry_date: '2026-05-12',
        description: 'racy concurrent commit',
        fiscal_period_id: 'fp-1',
        inbox_item_id: 'inbox-1',
        document_id: 'doc-1',
        lines: [
          { account_number: '5410', debit_amount: 250, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 250 },
        ],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ inbox_linked: false })
    // Critical: document MUST NOT be linked to the racing loser JE: the
    // inbox already points at the winner's JE.
    expect(linkToJournalEntry).not.toHaveBeenCalled()
  })

  it('inbox-direct: inbox update failure does NOT roll back the posted entry (inbox_linked=false)', async () => {
    vi.mocked(createJournalEntry).mockResolvedValueOnce(
      makeJournalEntry({ id: 'je-inbox-fails', voucher_number: 20 })
    )

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: { message: 'unique constraint violated (concurrent commit)' } }) // inbox update fails
    enqueue({ data: null, error: null }) // dispatcher's commit update

    const op = makePendingOp({
      params: {
        entry_date: '2026-05-12',
        description: 'racy double-commit',
        fiscal_period_id: 'fp-1',
        inbox_item_id: 'inbox-1',
        // No document_id → linkToJournalEntry must not be called even after
        // inbox update fails.
        lines: [
          { account_number: '5410', debit_amount: 250, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 250 },
        ],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ inbox_linked: false })
    expect(linkToJournalEntry).not.toHaveBeenCalled()
  })

  it('no inbox_item_id: does not touch invoice_inbox_items at all', async () => {
    // Regression guard: standalone voucher creation must not query the inbox
    // table: that would surprise users who never use the inbox flow.
    vi.mocked(createJournalEntry).mockResolvedValueOnce(
      makeJournalEntry({ id: 'je-standalone', voucher_number: 21 })
    )

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: null }) // dispatcher's commit update: no inbox call between

    const op = makePendingOp({
      params: {
        entry_date: '2026-05-12',
        description: 'pure capitalization, no inbox',
        fiscal_period_id: 'fp-1',
        lines: [
          { account_number: '1010', debit_amount: 1000, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
        ],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).not.toHaveProperty('inbox_item_id')
    expect(result.data).not.toHaveProperty('inbox_linked')
    expect(linkToJournalEntry).not.toHaveBeenCalled()

    // Confirm no `from('invoice_inbox_items')` call was issued.
    const fromCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((args) => args[0])
    expect(fromCalls).not.toContain('invoice_inbox_items')
  })
})

// ─── correct_entry ──────────────────────────────────────────────────

describe('commitPendingOperation: correct_entry', () => {
  it('happy path: posts storno + corrected for a posted entry in an open period', async () => {
    vi.mocked(correctEntry).mockResolvedValueOnce({
      reversal: makeJournalEntry({ id: 'je-storno', voucher_number: 50 }),
      corrected: makeJournalEntry({ id: 'je-corrected', voucher_number: 51 }),
    })

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: {
        id: 'je-original',
        status: 'posted',
        fiscal_period_id: 'fp-1',
        fiscal_periods: { is_closed: false },
      },
      error: null,
    }) // executor's pre-flight fetch
    enqueue({ data: null, error: null }) // dispatcher's commit update

    const op = makePendingOp({
      operation_type: 'correct_entry',
      params: {
        entry_id: 'je-original',
        lines: [
          { account_number: '2645', debit_amount: 250, credit_amount: 0 },
          { account_number: '2614', debit_amount: 0, credit_amount: 250 },
        ],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      original_entry_id: 'je-original',
      storno_entry_id: 'je-storno',
      corrected_entry_id: 'je-corrected',
      storno_voucher_number: 50,
      corrected_voucher_number: 51,
    })
    expect(correctEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      'je-original',
      expect.arrayContaining([
        expect.objectContaining({ account_number: '2645' }),
        expect.objectContaining({ account_number: '2614' }),
      ])
    )
  })

  it('returns 404 when the original entry does not exist', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // executor's pre-flight fetch (no row)
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const op = makePendingOp({
      operation_type: 'correct_entry',
      params: {
        entry_id: 'je-missing',
        lines: [
          { account_number: '5410', debit_amount: 100, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 100 },
        ],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('rejected')
    expect(result.auto_rejected).toBe(true)
    expect(result.http_status).toBe(404)
    expect(correctEntry).not.toHaveBeenCalled()
  })

  it('returns 409 when the original entry is not posted', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: {
        id: 'je-draft',
        status: 'draft',
        fiscal_period_id: 'fp-1',
        fiscal_periods: { is_closed: false },
      },
      error: null,
    }) // executor's pre-flight fetch
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const op = makePendingOp({
      operation_type: 'correct_entry',
      params: {
        entry_id: 'je-draft',
        lines: [
          { account_number: '5410', debit_amount: 100, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 100 },
        ],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.error).toMatch(/bokförda verifikationer/)
    expect(correctEntry).not.toHaveBeenCalled()
  })

  it('returns 409 with omprövning hint when the period is closed', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: {
        id: 'je-original',
        status: 'posted',
        fiscal_period_id: 'fp-1',
        fiscal_periods: { is_closed: true },
      },
      error: null,
    }) // executor's pre-flight fetch
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const op = makePendingOp({
      operation_type: 'correct_entry',
      params: {
        entry_id: 'je-original',
        lines: [
          { account_number: '5410', debit_amount: 100, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 100 },
        ],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.error).toMatch(/omprövning/i)
    expect(correctEntry).not.toHaveBeenCalled()
  })

  it('returns 400 when required fields are missing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const op = makePendingOp({
      operation_type: 'correct_entry',
      params: {
        entry_id: 'je-1',
        // missing lines
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(correctEntry).not.toHaveBeenCalled()
  })
})

// ─── reverse_entry ──────────────────────────────────────────────────

describe('commitPendingOperation: reverse_entry', () => {
  it('happy path: posts storno for a posted entry in an open period', async () => {
    vi.mocked(reverseEntry).mockResolvedValueOnce(
      makeJournalEntry({ id: 'je-storno', voucher_number: 99, voucher_series: 'A', fiscal_period_id: 'fp-1' })
    )

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: {
        id: 'je-original',
        status: 'posted',
        fiscal_period_id: 'fp-1',
        fiscal_periods: { is_closed: false },
      },
      error: null,
    }) // executor's pre-flight fetch
    enqueue({ data: null, error: null }) // dispatcher's commit update

    const op = makePendingOp({
      operation_type: 'reverse_entry',
      params: { entry_id: 'je-original' },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      original_entry_id: 'je-original',
      reversal_entry_id: 'je-storno',
      reversal_voucher_number: 99,
      reversal_voucher_series: 'A',
    })
    expect(reverseEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      'je-original',
      undefined
    )
  })

  it('forwards reversal_date when provided', async () => {
    vi.mocked(reverseEntry).mockResolvedValueOnce(
      makeJournalEntry({ id: 'je-storno', voucher_number: 100, fiscal_period_id: 'fp-1' })
    )

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: {
        id: 'je-original',
        status: 'posted',
        fiscal_period_id: 'fp-1',
        fiscal_periods: { is_closed: false },
      },
      error: null,
    })
    enqueue({ data: null, error: null })

    const op = makePendingOp({
      operation_type: 'reverse_entry',
      params: { entry_id: 'je-original', reversal_date: '2026-05-20' },
    })

    await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(reverseEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      'je-original',
      '2026-05-20'
    )
  })

  it('returns 404 when the original entry does not exist', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: null }) // pre-flight finds no row
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const op = makePendingOp({
      operation_type: 'reverse_entry',
      params: { entry_id: 'je-missing' },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('rejected')
    expect(result.auto_rejected).toBe(true)
    expect(result.http_status).toBe(404)
    expect(reverseEntry).not.toHaveBeenCalled()
  })

  it('returns 409 when the original entry is not posted', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({
      data: {
        id: 'je-draft',
        status: 'draft',
        fiscal_period_id: 'fp-1',
        fiscal_periods: { is_closed: false },
      },
      error: null,
    })
    enqueue({ data: null, error: null })

    const op = makePendingOp({
      operation_type: 'reverse_entry',
      params: { entry_id: 'je-draft' },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.error).toMatch(/bokförda verifikationer kan makuleras/)
    expect(reverseEntry).not.toHaveBeenCalled()
  })

  it('returns 409 when the period is closed', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({
      data: {
        id: 'je-original',
        status: 'posted',
        fiscal_period_id: 'fp-1',
        fiscal_periods: { is_closed: true },
      },
      error: null,
    })
    enqueue({ data: null, error: null })

    const op = makePendingOp({
      operation_type: 'reverse_entry',
      params: { entry_id: 'je-original' },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.error).toMatch(/omprövning/i)
    expect(reverseEntry).not.toHaveBeenCalled()
  })

  it('returns 400 when entry_id is missing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: null })

    const op = makePendingOp({
      operation_type: 'reverse_entry',
      params: {},
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(reverseEntry).not.toHaveBeenCalled()
  })

  it('returns 500 with BFL invariant error if engine returns a storno in a different period', async () => {
    // Engine guarantee per BFL 5 kap 5§: storno lands in original.fiscal_period_id
    // (lib/bookkeeping/engine.ts:492). The executor asserts this so a future engine
    // change that breaks the invariant fails fast.
    vi.mocked(reverseEntry).mockResolvedValueOnce(
      makeJournalEntry({ id: 'je-storno', voucher_number: 99, fiscal_period_id: 'fp-WRONG' })
    )

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({
      data: {
        id: 'je-original',
        status: 'posted',
        entry_date: '2026-05-15',
        fiscal_period_id: 'fp-1',
        fiscal_periods: { is_closed: false },
      },
      error: null,
    })
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const op = makePendingOp({
      operation_type: 'reverse_entry',
      params: { entry_id: 'je-original' },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(500)
    expect(result.error).toMatch(/BFL invariant broken/i)
  })

  it('returns 409 when the entry_date is covered by the company-wide lock', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: {
        id: 'je-original',
        status: 'posted',
        entry_date: '2025-12-15',
        fiscal_period_id: 'fp-1',
        fiscal_periods: { is_closed: false },
      },
      error: null,
    }) // pre-flight fetch: per-period OK
    // resolvePeriodStatusForDate: company_settings says 2025-12-31 lock_through.
    enqueue({ data: { bookkeeping_locked_through: '2025-12-31' }, error: null })
    enqueue({ data: { id: 'fp-1' }, error: null }) // covering period lookup
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const op = makePendingOp({
      operation_type: 'reverse_entry',
      params: { entry_id: 'je-original' },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.error).toMatch(/låst|omprövning/i)
    expect(reverseEntry).not.toHaveBeenCalled()
  })
})
