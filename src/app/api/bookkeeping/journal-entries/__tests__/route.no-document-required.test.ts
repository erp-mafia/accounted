import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse, createQueuedMockSupabase, makeJournalEntry } from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

const { mockLogError } = vi.hoisted(() => ({ mockLogError: vi.fn() }))
vi.mock('@/lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: mockLogError, child: (): unknown => logger }
  return { createLogger: () => logger }
})

const mockCreateJournalEntry = vi.fn()
const mockCreateDraftEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: (...args: unknown[]) => mockCreateJournalEntry(...args),
  createDraftEntry: (...args: unknown[]) => mockCreateDraftEntry(...args),
}))

const mockSetNoDocumentRequired = vi.fn()
vi.mock('@/lib/bookkeeping/no-doc-required', () => ({
  setNoDocumentRequired: (...args: unknown[]) => mockSetNoDocumentRequired(...args),
}))

import { POST } from '../route'

const emptyParams = { params: Promise.resolve({}) }

const VALID_UUID = '11111111-1111-4111-8111-111111111111'

/** A bank fee: the kind of verifikat that has no external underlag. */
const BANK_FEE = {
  fiscal_period_id: VALID_UUID,
  entry_date: '2026-11-02',
  description: 'Bankavgift november',
  lines: [
    { account_number: '6570', debit_amount: 95, credit_amount: 0 },
    { account_number: '1930', debit_amount: 0, credit_amount: 95 },
  ],
}

const post = (body: unknown, query = '') =>
  POST(createMockRequest(`/api/bookkeeping/journal-entries${query}`, { method: 'POST', body }), emptyParams)

describe('POST /api/bookkeeping/journal-entries: "Inget underlag krävs" at creation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } } })
    mockSetNoDocumentRequired.mockResolvedValue({
      ok: true,
      data: { journal_entry_id: 'je-1', exempted: true, reason: null },
    })
  })

  it('returns 401 when not authenticated, and marks nothing', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const response = await post({ ...BANK_FEE, no_document_required: { reason: 'Bankavgift' } })

    expect(response.status).toBe(401)
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
    expect(mockSetNoDocumentRequired).not.toHaveBeenCalled()
  })

  it('refuses a reason over 200 characters with 400 before anything is posted', async () => {
    const response = await post({ ...BANK_FEE, no_document_required: { reason: 'x'.repeat(201) } })
    const { status, body } = await parseJsonResponse<{ errors: Array<{ field: string }> }>(response)

    expect(status).toBe(400)
    expect(body.errors.map((e) => e.field)).toEqual(['no_document_required.reason'])
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
    expect(mockSetNoDocumentRequired).not.toHaveBeenCalled()
  })

  it('refuses an unknown key in the choice with 400', async () => {
    const response = await post({ ...BANK_FEE, no_document_required: { reason: null, user_id: 'someone-else' } })

    expect(response.status).toBe(400)
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('posts the verifikat, then marks it with the reason through the shared rule', async () => {
    const entry = makeJournalEntry({ id: 'je-1', voucher_series: 'A', voucher_number: 7 })
    mockCreateJournalEntry.mockResolvedValue(entry)

    const response = await post({ ...BANK_FEE, no_document_required: { reason: '  Bankavgift  ' } })
    const { status, body } = await parseJsonResponse<{ data: unknown; no_document_required: boolean }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual(entry)
    expect(body.no_document_required).toBe(true)
    // The engine never sees the choice.
    expect(mockCreateJournalEntry).toHaveBeenCalledTimes(1)
    expect(mockCreateJournalEntry.mock.calls[0][3]).not.toHaveProperty('no_document_required')
    expect(mockSetNoDocumentRequired).toHaveBeenCalledTimes(1)
    expect(mockSetNoDocumentRequired).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }),
      'je-1',
      'Bankavgift',
    )
    // Marked after the posting, never before.
    expect(mockCreateJournalEntry.mock.invocationCallOrder[0]).toBeLessThan(
      mockSetNoDocumentRequired.mock.invocationCallOrder[0],
    )
  })

  it('stores no reason for an empty or missing one', async () => {
    mockCreateJournalEntry.mockResolvedValue(makeJournalEntry({ id: 'je-1' }))

    await post({ ...BANK_FEE, no_document_required: { reason: '   ' } })
    await post({ ...BANK_FEE, no_document_required: {} })

    expect(mockSetNoDocumentRequired).toHaveBeenNthCalledWith(1, expect.anything(), 'je-1', null)
    expect(mockSetNoDocumentRequired).toHaveBeenNthCalledWith(2, expect.anything(), 'je-1', null)
  })

  it('marks nothing and answers as before when the choice is not sent', async () => {
    mockCreateJournalEntry.mockResolvedValue(makeJournalEntry({ id: 'je-1' }))

    const response = await post(BANK_FEE)
    const { status, body } = await parseJsonResponse<Record<string, unknown>>(response)

    expect(status).toBe(200)
    expect(body).not.toHaveProperty('no_document_required')
    expect(mockSetNoDocumentRequired).not.toHaveBeenCalled()
  })

  it('marks nothing on a draft: only a posting is marked', async () => {
    mockCreateDraftEntry.mockResolvedValue(makeJournalEntry({ id: 'draft-1', status: 'draft' }))

    const response = await post({ ...BANK_FEE, no_document_required: { reason: 'Bankavgift' } }, '?as_draft=true')
    const { status, body } = await parseJsonResponse<Record<string, unknown>>(response)

    expect(status).toBe(200)
    expect(body).not.toHaveProperty('no_document_required')
    expect(mockCreateDraftEntry).toHaveBeenCalledTimes(1)
    expect(mockCreateDraftEntry.mock.calls[0][3]).not.toHaveProperty('no_document_required')
    expect(mockSetNoDocumentRequired).not.toHaveBeenCalled()
  })

  it('answers the posted verifikat with no_document_required false when the mark is refused, and logs it', async () => {
    const entry = makeJournalEntry({ id: 'je-1' })
    mockCreateJournalEntry.mockResolvedValue(entry)
    mockSetNoDocumentRequired.mockResolvedValue({ ok: false, code: 'NO_DOC_REQUIRED_FAILED' })

    const response = await post({ ...BANK_FEE, no_document_required: { reason: 'Bankavgift' } })
    const { status, body } = await parseJsonResponse<{ data: unknown; no_document_required: boolean }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual(entry)
    expect(body.no_document_required).toBe(false)
    expect(mockLogError).toHaveBeenCalledWith(
      'posted verifikat could not be marked no-document-required',
      undefined,
      expect.objectContaining({ journal_entry_id: 'je-1', code: 'NO_DOC_REQUIRED_FAILED' }),
    )
  })

  it('still answers the posted verifikat when the mark throws', async () => {
    const entry = makeJournalEntry({ id: 'je-1' })
    mockCreateJournalEntry.mockResolvedValue(entry)
    mockSetNoDocumentRequired.mockRejectedValue(new Error('connection reset'))

    const response = await post({ ...BANK_FEE, no_document_required: { reason: null } })
    const { status, body } = await parseJsonResponse<{ data: unknown; no_document_required: boolean }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual(entry)
    expect(body.no_document_required).toBe(false)
    expect(mockLogError).toHaveBeenCalledWith(
      'posted verifikat could not be marked no-document-required',
      expect.any(Error),
      expect.objectContaining({ journal_entry_id: 'je-1' }),
    )
  })

  it('marks nothing when the posting fails', async () => {
    mockCreateJournalEntry.mockRejectedValue(new Error('Unbalanced entry'))

    const response = await post({ ...BANK_FEE, no_document_required: { reason: 'Bankavgift' } })

    expect(response.status).toBe(400)
    expect(mockSetNoDocumentRequired).not.toHaveBeenCalled()
  })
})
