/**
 * The commit route's answer to a refused approval (tracker #206 point 2):
 * the structured code and details reach the client, agent wording never
 * reaches a person, and the answer says where the proposal landed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, createMockRouteParams, parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'
import type { CommitResult } from '@/lib/pending-operations/commit'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/pending-operations/record-app-approval', () => ({
  recordAppApproval: vi.fn(async () => undefined),
}))
const mockCommit = vi.fn(async (..._args: unknown[]): Promise<CommitResult> => ({ status: 'committed' }))
vi.mock('@/lib/pending-operations/commit', () => ({
  commitPendingOperation: (...args: unknown[]) => mockCommit(...args),
}))

import { POST } from '../route'

type Envelope = {
  error: { code: string; message: string; details?: Record<string, unknown> } | string
  operation_status?: string
  data?: unknown
}

const routeParams = createMockRouteParams({ id: 'op-1' })

function operationRow(operationType: string) {
  return { id: 'op-1', user_id: 'user-1', company_id: 'company-1', operation_type: operationType, status: 'pending', params: {}, preview_data: {} }
}

async function approve(operationType: string, result: CommitResult, body?: unknown) {
  enqueue({ data: operationRow(operationType), error: null })
  mockCommit.mockResolvedValueOnce(result)
  const request = createMockRequest('/api/pending-operations/op-1/commit', { method: 'POST', ...(body ? { body } : {}) })
  return parseJsonResponse<Envelope>(await POST(request, routeParams))
}

describe('POST /api/pending-operations/:id/commit: a refused approval', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const request = createMockRequest('/api/pending-operations/op-1/commit', { method: 'POST' })
    const { status } = await parseJsonResponse(await POST(request, routeParams))
    expect(status).toBe(401)
    expect(mockCommit).not.toHaveBeenCalled()
  })

  it('returns 404 when the operation is not found', async () => {
    enqueue({ data: null, error: { message: 'not found' } })
    const request = createMockRequest('/api/pending-operations/op-1/commit', { method: 'POST' })
    const { status } = await parseJsonResponse(await POST(request, routeParams))
    expect(status).toBe(404)
    expect(mockCommit).not.toHaveBeenCalled()
  })

  it('answers a committed approval with its data, unchanged', async () => {
    const { status, body } = await approve('create_voucher', {
      status: 'committed',
      data: { journal_entry_id: 'je-1' },
      operation_status: 'committed',
    })
    expect(status).toBe(200)
    expect(body).toEqual({ data: { journal_entry_id: 'je-1' } })
  })

  it('carries the code, the details and where the proposal landed', async () => {
    const { status, body } = await approve('create_voucher', {
      status: 'rejected',
      auto_rejected: true,
      error: 'Underlaget är redan bokfört.',
      http_status: 409,
      code: 'INBOX_ITEM_ALREADY_BOOKED',
      data: { journal_entry_id: 'je-9' },
      operation_status: 'rejected',
    })
    expect(status).toBe(409)
    expect(body.error).toMatchObject({
      code: 'INBOX_ITEM_ALREADY_BOOKED',
      message: 'Underlaget är redan bokfört.',
      details: { journal_entry_id: 'je-9', operation_status: 'rejected' },
    })
  })

  it('keeps the executor sentence but drops the sentence written for an agent', async () => {
    const { status, body } = await approve('mark_invoice_paid', {
      status: 'rejected',
      auto_rejected: true,
      error:
        'Möjlig dubbelbetalning: en obokförd banktransaktion ser ut att vara betalningen för faktura F-12. ' +
        'Matcha banktransaktionen mot fakturan (gnubok_match_transaction_to_invoice) i stället för att bokföra en separat betalning. ' +
        'Om det verkligen rör sig om en annan betalning, kör om med allow_duplicate=true.',
      http_status: 409,
      operation_status: 'rejected',
    })
    expect(status).toBe(409)
    expect(body.operation_status).toBe('rejected')
    expect(body.error).toBe(
      'Möjlig dubbelbetalning: en obokförd banktransaktion ser ut att vara betalningen för faktura F-12. ' +
        'Matcha banktransaktionen mot fakturan i stället för att bokföra en separat betalning.',
    )
  })

  it('answers the registry sentence for the code when the executor sentence is only a raw code', async () => {
    const { body } = await approve('create_voucher', {
      status: 'rejected',
      auto_rejected: true,
      error: 'ENTRY_NOT_OPEN',
      http_status: 409,
      code: 'VOUCHER_NEEDS_CONFIRMATION',
      operation_status: 'rejected',
    })
    const error = body.error as { code: string; message: string }
    expect(error.code).toBe('VOUCHER_NEEDS_CONFIRMATION')
    expect(error.message).not.toContain('ENTRY_NOT_OPEN')
    expect(error.message).toContain('Läs varningarna')
  })

  it('never answers raw English: an uncoded English refusal gets the sentence for its status', async () => {
    const { status, body } = await approve('send_invoice', {
      status: 'rejected',
      auto_rejected: true,
      error: 'Credit notes must be issued through the invoice send flow',
      http_status: 409,
      operation_status: 'rejected',
    })
    expect(status).toBe(409)
    expect(typeof body.error).toBe('string')
    expect(body.error).not.toContain('Credit notes')
    expect(body.operation_status).toBe('rejected')
  })

  it('approves as the app door: fixable refusals keep the proposal, no warnings confirmed', async () => {
    await approve('create_voucher', { status: 'committed', operation_status: 'committed' })
    const opts = mockCommit.mock.calls[0][4] as Record<string, unknown>
    expect(opts.keepFixableRefusals).toBe(true)
    expect(opts.commitMethod).toBe('user_accept')
    expect(opts).not.toHaveProperty('acknowledgedWarnings')
  })

  it('VOUCHER_NEEDS_CONFIRMATION: the proposal stays pending and the warnings reach the client', async () => {
    const warnings = [{ code: 'VOUCHER_DUPLICATE_IN_BOOKS', message_sv: 'Finns redan.', message_en: 'Exists.', details: {} }]
    const { status, body } = await approve('create_voucher', {
      status: 'failed',
      error: 'Verifikationen avviker från hur en sådan verifikation brukar se ut. Läs varningarna och bekräfta att den stämmer, eller rätta raderna.',
      http_status: 409,
      code: 'VOUCHER_NEEDS_CONFIRMATION',
      data: { warnings },
      operation_status: 'pending',
    })
    expect(status).toBe(409)
    expect(body.error).toMatchObject({
      code: 'VOUCHER_NEEDS_CONFIRMATION',
      details: { warnings, operation_status: 'pending' },
    })
  })

  it('passes the warnings the person confirmed on to the approval', async () => {
    const { status } = await approve(
      'create_voucher',
      { status: 'committed', data: { journal_entry_id: 'je-1' }, operation_status: 'committed' },
      { acknowledged_warnings: ['VOUCHER_DUPLICATE_IN_BOOKS'] },
    )
    expect(status).toBe(200)
    expect(mockCommit.mock.calls[0][4]).toMatchObject({
      keepFixableRefusals: true,
      acknowledgedWarnings: ['VOUCHER_DUPLICATE_IN_BOOKS'],
    })
  })

  it('takes both answers in one body: the duplicate booked over and the warnings confirmed', async () => {
    const duplicate = '7b1f6f0e-51c4-4a0a-9a1e-0f5e3c1b2a10'
    const { status } = await approve(
      'create_voucher',
      { status: 'committed', data: { journal_entry_id: 'je-1' }, operation_status: 'committed' },
      { acknowledged_warnings: ['VOUCHER_DUPLICATE_IN_BOOKS'], expected_duplicate_journal_entry_id: duplicate },
    )
    expect(status).toBe(200)
    expect(mockCommit.mock.calls[0][4]).toMatchObject({
      keepFixableRefusals: true,
      acknowledgedWarnings: ['VOUCHER_DUPLICATE_IN_BOOKS'],
      duplicateReview: { expectedJournalEntryId: duplicate },
    })
  })

  it('returns 400 for a body that is not the approval body, before anything runs', async () => {
    const request = createMockRequest('/api/pending-operations/op-1/commit', {
      method: 'POST',
      body: { acknowledged_warnings: 'VOUCHER_DUPLICATE_IN_BOOKS' },
    })
    const { status, body } = await parseJsonResponse<Envelope>(await POST(request, routeParams))
    expect(status).toBe(400)
    expect((body.error as { code: string }).code).toBe('VALIDATION_ERROR')
    expect(mockCommit).not.toHaveBeenCalled()
  })

  it('says a proposal kept by a recoverable refusal is still pending', async () => {
    const { status, body } = await approve('submit_vat_declaration', {
      status: 'failed',
      error: 'Sessionen har gått ut. Logga in med BankID igen.',
      http_status: 401,
      code: 'SKATTEVERKET_NOT_CONNECTED',
      operation_status: 'pending',
    })
    expect(status).toBe(401)
    expect(body.error).toMatchObject({
      code: 'SKATTEVERKET_NOT_CONNECTED',
      details: { operation_status: 'pending' },
    })
  })
})
