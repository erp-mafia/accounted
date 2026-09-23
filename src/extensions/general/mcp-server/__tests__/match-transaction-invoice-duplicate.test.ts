/**
 * gnubok_match_transaction_to_invoice: the soft-duplicate guard at stage time
 * (issue #2294, parity with the dashboard match-invoice route's
 * MATCH_INVOICE_POSSIBLE_DUPLICATE / MATCH_INVOICE_FORCE_CANDIDATE_MISMATCH).
 *
 * A manual verifikation that already books the receipt is surfaced before
 * anything is staged, with the voucher named and the link call that resolves
 * it; force is bound to that exact candidate and travels with the op so the
 * commit executor can re-validate it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { mockDetectCandidate } = vi.hoisted(() => ({ mockDetectCandidate: vi.fn() }))
vi.mock('@/lib/invoices/duplicate-payment-detection', () => ({
  detectDuplicatePaymentVoucher: mockDetectCandidate,
  detectExplainingVoucherSetForTransaction: vi.fn(async () => null),
}))

import { tools } from '../server'

const match = tools.find((t) => t.name === 'gnubok_match_transaction_to_invoice')!

const TX_ID = '11111111-1111-4111-8111-111111111111'
const INV_ID = '22222222-2222-4222-8222-222222222222'
const JE_MANUAL = '55555555-5555-4555-8555-555555555555'
const JE_OTHER = '66666666-6666-4666-8666-666666666666'

const txRow = {
  id: TX_ID,
  description: 'SWISH INBET',
  merchant_name: null,
  amount: 1000,
  currency: 'SEK',
  amount_sek: null,
  exchange_rate: null,
  date: '2026-05-15',
  invoice_id: null,
}

const invoiceRow = {
  id: INV_ID,
  invoice_number: 'F-2026001',
  status: 'sent',
  document_type: 'invoice',
  total: 1000,
  currency: 'SEK',
  invoice_date: '2026-05-01',
  customer: { name: 'Kund AB' },
}

const candidate = {
  journal_entry_id: JE_MANUAL,
  voucher_label: 'A12',
  entry_date: '2026-05-15',
  description: 'Inbetalning faktura',
  amount: 1000,
  bank_account_number: '1930',
  reason: 'exact_amount_same_date',
  amount_verified: true,
  unverified_reason: null,
}

function run(supabase: unknown, extra: Record<string, unknown> = {}) {
  return match.execute(
    { transaction_id: TX_ID, invoice_id: INV_ID, ...extra },
    'company-1',
    'user-1',
    supabase as never,
    { type: 'api_key' } as never,
  )
}

function enqueuePreGuard(enqueue: (r: { data?: unknown; error?: unknown }) => void) {
  enqueue({ data: txRow, error: null })
  enqueue({ data: invoiceRow, error: null })
}

function enqueueStage(enqueue: (r: { data?: unknown; error?: unknown }) => void) {
  enqueue({ data: { bookkeeping_locked_through: null }, error: null }) // company_settings
  enqueue({ data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null }) // fiscal_periods
  enqueue({ data: { id: 'op-match-1' }, error: null }) // pending_operations insert
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDetectCandidate.mockResolvedValue(null)
})

describe('gnubok_match_transaction_to_invoice: soft-duplicate guard at stage time', () => {
  it('refuses to stage, coded MATCH_INVOICE_POSSIBLE_DUPLICATE, naming the voucher, the link tool and the force binding', async () => {
    mockDetectCandidate.mockResolvedValue(candidate)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueuePreGuard(enqueue)

    const err = await run(supabase).then(() => null, (e: Error & { code?: string }) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err!.code).toBe('MATCH_INVOICE_POSSIBLE_DUPLICATE')
    expect(err!.message).toContain('verifikat A12')
    expect(err!.message).toContain('gnubok_link_transaction_to_journal_entry')
    expect(err!.message).toContain(`expected_journal_entry_id="${JE_MANUAL}"`)
    expect(mockDetectCandidate).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ companyId: 'company-1', transactionId: TX_ID, transactionAmount: 1000, transactionCurrency: 'SEK' }),
    )
    const tables = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(tables).not.toContain('pending_operations')
  })

  it('stages with a compliance warning when force echoes the detected candidate, and persists the binding', async () => {
    mockDetectCandidate.mockResolvedValue(candidate)
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueuePreGuard(enqueue)
    enqueueStage(enqueue)

    const result = (await run(supabase, { force: true, expected_journal_entry_id: JE_MANUAL })) as {
      staged: boolean
      operation_id?: string
      preview: Record<string, unknown>
    }
    expect(result.staged).toBe(true)
    expect(result.operation_id).toBe('op-match-1')
    expect(result.preview.compliance_warning).toContain('A12')
    const inserted = findCall('pending_operations', 'insert')?.[0] as { params: Record<string, unknown> }
    expect(inserted.params).toMatchObject({
      transaction_id: TX_ID,
      invoice_id: INV_ID,
      force: true,
      expected_journal_entry_id: JE_MANUAL,
    })
  })

  it('refuses a stale force id as MATCH_INVOICE_FORCE_CANDIDATE_MISMATCH', async () => {
    mockDetectCandidate.mockResolvedValue(candidate)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueuePreGuard(enqueue)

    const err = await run(supabase, { force: true, expected_journal_entry_id: JE_OTHER }).then(
      () => null,
      (e: Error & { code?: string }) => e,
    )
    expect(err!.code).toBe('MATCH_INVOICE_FORCE_CANDIDATE_MISMATCH')
    expect(err!.message).toContain(JE_OTHER)
    expect(err!.message).toContain(JE_MANUAL)
  })

  it('refuses force when no candidate is detected any more (force is moot)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueuePreGuard(enqueue)

    await expect(run(supabase, { force: true, expected_journal_entry_id: JE_MANUAL })).rejects.toMatchObject({
      code: 'MATCH_INVOICE_FORCE_CANDIDATE_MISMATCH',
    })
  })

  it('rejects force without expected_journal_entry_id before any query runs', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(run(supabase, { force: true })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('rejects a non-string expected_journal_entry_id at the boundary instead of silently dropping it', async () => {
    for (const bad of [42, '', [JE_MANUAL]]) {
      const { supabase } = createQueuedMockSupabase()
      await expect(run(supabase, { expected_journal_entry_id: bad })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
      expect(supabase.from).not.toHaveBeenCalled()
    }
  })

  it('fails open when the detector throws without force, but the approval card says the check did not run', async () => {
    mockDetectCandidate.mockRejectedValue(new Error('scan failed'))
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueuePreGuard(enqueue)
    enqueueStage(enqueue)

    const result = (await run(supabase)) as { staged: boolean; preview: Record<string, unknown> }
    expect(result.staged).toBe(true)
    expect(result.preview.compliance_warning).toContain('Dubblettkontrollen kunde inte köras')
    // Persisted with the op: MatchTransactionInvoicePreview renders it on /pending.
    const inserted = findCall('pending_operations', 'insert')?.[0] as { preview_data: Record<string, unknown> }
    expect(inserted.preview_data.compliance_warning).toContain('Dubblettkontrollen kunde inte köras')
  })

  it('refuses force=true when the detector throws: an override that cannot be re-verified is never staged', async () => {
    mockDetectCandidate.mockRejectedValue(new Error('scan failed'))
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueuePreGuard(enqueue)

    await expect(run(supabase, { force: true, expected_journal_entry_id: JE_MANUAL })).rejects.toMatchObject({
      code: 'MATCH_INVOICE_FORCE_CANDIDATE_MISMATCH',
    })
    const tables = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(tables).not.toContain('pending_operations')
  })

  it('stages a clean match without a binding or a warning', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueuePreGuard(enqueue)
    enqueueStage(enqueue)

    const result = (await run(supabase)) as { staged: boolean; preview: Record<string, unknown> }
    expect(result.staged).toBe(true)
    expect(result.preview.compliance_warning).toBeUndefined()
    const inserted = findCall('pending_operations', 'insert')?.[0] as { params: Record<string, unknown> }
    expect(inserted.params).toEqual({ transaction_id: TX_ID, invoice_id: INV_ID })
  })
})
