/**
 * gnubok_approve_pending_operation resent after the approval went through.
 *
 * The stateless MCP revision recovers a broken call by sending it again. An
 * approval whose answer was lost has already committed; the repeat must
 * neither commit again (the claim in commitPendingOperation guarantees that,
 * see lib/pending-operations/__tests__/commit-double-approval.test.ts) nor
 * answer a bare conflict an agent could read as "stage it again", which is
 * how a second verifikat would get made. It answers the stored outcome.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const commitSpy = vi.fn()
vi.mock('@/lib/pending-operations/commit', () => ({
  commitPendingOperation: (...args: unknown[]) => commitSpy(...args),
}))

import { tools } from '../server'

const approve = tools.find((t) => t.name === 'gnubok_approve_pending_operation')!

function operation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'op-1',
    operation_type: 'create_voucher',
    company_id: 'company-1',
    status: 'pending',
    risk_level: 'high',
    params: {},
    result_data: null,
    ...overrides,
  }
}

const run = (supabase: unknown) =>
  approve.execute({ operation_id: 'op-1', confirmed: true }, 'company-1', 'user-1', supabase as never, { type: 'api_key' }) as Promise<
    Record<string, unknown>
  >

beforeEach(() => vi.clearAllMocks())

describe('gnubok_approve_pending_operation: a resent approval', () => {
  it('answers the stored result of an operation already committed, without committing again', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: operation({ status: 'committed', result_data: { journal_entry_id: 'je-1', voucher_number: 'A12' } }), error: null })

    const result = await run(supabase)

    expect(commitSpy).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      status: 'committed',
      operation_id: 'op-1',
      data: { journal_entry_id: 'je-1', voucher_number: 'A12' },
      operation_status: 'committed',
      idempotency_replay: true,
    })
  })

  it('answers the outcome of a concurrent approval that won the claim and settled meanwhile', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: operation(), error: null }) // read: still pending
    enqueue({ data: operation({ status: 'committed', result_data: { journal_entry_id: 'je-1' } }), error: null }) // re-read after the lost claim
    commitSpy.mockResolvedValue({ status: 'failed', error: 'Operation already claimed or resolved by another caller', http_status: 409 })

    const result = await run(supabase)

    expect(commitSpy).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ status: 'committed', data: { journal_entry_id: 'je-1' }, idempotency_replay: true })
  })

  it('keeps the conflict while the other approval is still committing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: operation(), error: null })
    enqueue({ data: operation({ status: 'committing' }), error: null })
    commitSpy.mockResolvedValue({ status: 'failed', error: 'Operation already claimed or resolved by another caller', http_status: 409 })

    const result = await run(supabase)

    expect(result).toMatchObject({ status: 'failed', error: 'Operation already claimed or resolved by another caller' })
    expect(result).not.toHaveProperty('idempotency_replay')
  })

  it('says a rejected operation was rejected and commits nothing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: operation({ status: 'rejected', result_data: { auto_rejected: true, reason: 'Transaktionen är redan bokförd.' } }), error: null })

    const result = await run(supabase)

    expect(commitSpy).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      status: 'rejected',
      error: 'Transaktionen är redan bokförd.',
      auto_rejected: true,
      operation_status: 'rejected',
    })
  })

  it('names the field and the tool when the commit refuses a voucher with new warnings (crm#1714)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: operation(), error: null })
    const warnings = [{ code: 'BANK_MOVEMENT_ALREADY_BOOKED', message_sv: 'x', message_en: 'x', details: {} }]
    commitSpy.mockResolvedValue({
      status: 'rejected',
      auto_rejected: true,
      error: 'Verifikationen avviker.',
      http_status: 409,
      code: 'VOUCHER_NEEDS_CONFIRMATION',
      data: { warnings },
      operation_status: 'rejected',
    })

    const result = await run(supabase)

    expect(result).toMatchObject({
      status: 'rejected',
      error_code: 'VOUCHER_NEEDS_CONFIRMATION',
      data: { warnings },
      next: { tool: 'gnubok_create_voucher' },
    })
    expect((result.next as { description: string }).description).toContain('acknowledged_warnings')
  })

  // crm#1813: two attaches of one statement staged together; the first
  // approval puts the document on its verifikat, the second is refused.
  it('hands on the copy link when an attach is refused because the document went to another verifikat', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: operation({ operation_type: 'attach_document_to_transaction', risk_level: 'medium' }), error: null })
    const next = {
      description: 'Link a copy to the row\'s verifikat.',
      tool: 'gnubok_link_document_to_voucher',
      args: { document_id: 'doc-1', journal_entry_id: 'je-row', copy: true },
    }
    commitSpy.mockResolvedValue({
      status: 'rejected',
      auto_rejected: true,
      error: 'Underlaget är redan kopplat till en annan verifikation.',
      http_status: 409,
      code: 'DOC_ATTACH_OTHER_VERIFIKAT',
      data: { journal_entry_id: 'je-held', document_id: 'doc-1', transaction_journal_entry_id: 'je-row', next },
      operation_status: 'rejected',
    })

    const result = await run(supabase)

    expect(result).toMatchObject({
      status: 'rejected',
      error_code: 'DOC_ATTACH_OTHER_VERIFIKAT',
      data: { transaction_journal_entry_id: 'je-row' },
      next,
    })
  })

  it('adds no next call to that refusal on an unbooked row', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: operation({ operation_type: 'attach_document_to_transaction', risk_level: 'medium' }), error: null })
    commitSpy.mockResolvedValue({
      status: 'rejected',
      auto_rejected: true,
      error: 'Underlaget är redan kopplat till en annan verifikation.',
      http_status: 409,
      code: 'DOC_ATTACH_OTHER_VERIFIKAT',
      data: { journal_entry_id: 'je-held', document_id: 'doc-1', transaction_journal_entry_id: null },
      operation_status: 'rejected',
    })

    const result = await run(supabase)

    expect(result).toMatchObject({ status: 'rejected', error_code: 'DOC_ATTACH_OTHER_VERIFIKAT' })
    expect(result).not.toHaveProperty('next')
  })

  it('adds no voucher hint to any other refusal', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: operation(), error: null })
    commitSpy.mockResolvedValue({ status: 'rejected', auto_rejected: true, error: 'Perioden är låst.', http_status: 409, code: 'PERIOD_LOCKED', operation_status: 'rejected' })

    const result = await run(supabase)

    expect(result).toMatchObject({ status: 'rejected', error_code: 'PERIOD_LOCKED' })
    expect(result).not.toHaveProperty('next')
  })

  it('still demands confirmed=true for a high-risk operation, settled or not', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: operation({ status: 'committed' }), error: null })
    await expect(
      approve.execute({ operation_id: 'op-1' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' }),
    ).rejects.toThrow('confirmed=true')
    expect(commitSpy).not.toHaveBeenCalled()
  })
})
