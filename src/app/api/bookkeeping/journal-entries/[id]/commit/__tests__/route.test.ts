import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  makeJournalEntry,
} from '@/tests/helpers'
import { JournalEntryNotBalancedError } from '@/lib/bookkeeping/errors'

const mockCreateClient = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => mockCreateClient(),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

const mockCommitEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  commitEntry: (...args: unknown[]) => mockCommitEntry(...args),
}))

const mockAppendProcessingHistory = vi.fn().mockResolvedValue('event-1')
vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: (...args: unknown[]) => mockAppendProcessingHistory(...args),
}))

/**
 * The draft the route reads before committing, as every query answers it:
 * one thenable chain whose terminal call resolves to `result`.
 */
function clientWithDraft(draft: unknown) {
  const chain: Record<string, unknown> = {}
  const result = { data: draft, error: null }
  for (const method of ['select', 'eq', 'in', 'or', 'gte', 'lte', 'not', 'order', 'limit']) {
    chain[method] = () => chain
  }
  chain.maybeSingle = () => Promise.resolve(result)
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null })
  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } } }), mfa: { listFactors: async () => ({ data: { all: [], totp: [], phone: [] }, error: null }) } },
    from: () => chain,
  }
}

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}))

import { POST } from '../route'

describe('POST /api/bookkeeping/journal-entries/[id]/commit', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: mockUser } }), mfa: { listFactors: async () => ({ data: { all: [], totp: [], phone: [] }, error: null }) } },
      // No typed draft to check: the commit goes straight through.
      from: clientWithDraft(null).from,
    })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 when not authenticated', async () => {
    mockCreateClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }), mfa: { listFactors: async () => ({ data: { all: [], totp: [], phone: [] }, error: null }) } },
    })

    const request = createMockRequest('/api/bookkeeping/journal-entries/entry-1/commit', {
      method: 'POST',
    })
    const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 403 when the caller lacks write permission (role/MFA write gate)', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json(
        { error: 'Du har endast läsbehörighet i detta företag.' },
        { status: 403 },
      ),
    })

    const request = createMockRequest('/api/bookkeeping/journal-entries/entry-1/commit', {
      method: 'POST',
    })
    const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(403)
    expect(mockCommitEntry).not.toHaveBeenCalled()
  })

  it('returns posted entry on success', async () => {
    const postedEntry = makeJournalEntry({
      id: 'entry-1',
      status: 'posted',
      voucher_series: 'A',
      voucher_number: 42,
    })
    mockCommitEntry.mockResolvedValue(postedEntry)

    const request = createMockRequest('/api/bookkeeping/journal-entries/entry-1/commit', {
      method: 'POST',
    })
    const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))
    const { status, body } = await parseJsonResponse<{ data: unknown }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual(postedEntry)
    expect(mockCommitEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      'entry-1',
      'user_accept'
    )
  })

  it('maps a typed engine error to the canonical structured envelope', async () => {
    // commitEntry throws typed bookkeeping errors; the wrapper routes them
    // through errorResponse() → registry status + { error: { code, ... } }.
    mockCommitEntry.mockRejectedValue(new JournalEntryNotBalancedError(1000, 900))

    const request = createMockRequest('/api/bookkeeping/journal-entries/entry-1/commit', {
      method: 'POST',
    })
    const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string; message_en?: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('JOURNAL_ENTRY_NOT_BALANCED')
  })

  describe('booking-time voucher warnings on a typed draft', () => {
    const typedDraft = {
      entry_date: '2026-07-05',
      description: 'Dryck till kontoret',
      source_type: 'manual',
      lines: [
        { account_number: '5460', debit_amount: 195.7, credit_amount: 0 },
        { account_number: '2641', debit_amount: 135.3, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 331 },
      ],
    }

    it('refuses with the warnings and commits nothing', async () => {
      mockCreateClient.mockResolvedValue(clientWithDraft(typedDraft))

      const response = await POST(
        createMockRequest('/api/bookkeeping/journal-entries/entry-1/commit', { method: 'POST' }),
        createMockRouteParams({ id: 'entry-1' }),
      )
      const { status, body } = await parseJsonResponse<{ error: { code: string; details: { warnings: Array<{ code: string }> } } }>(response)

      expect(status).toBe(409)
      expect(body.error.code).toBe('VOUCHER_NEEDS_CONFIRMATION')
      expect(body.error.details.warnings.map((w) => w.code)).toEqual(['INPUT_VAT_ABOVE_RATE'])
      expect(mockCommitEntry).not.toHaveBeenCalled()
    })

    it('commits once the warnings are confirmed and records it', async () => {
      mockCreateClient.mockResolvedValue(clientWithDraft(typedDraft))
      mockCommitEntry.mockResolvedValue(makeJournalEntry({ id: 'entry-1', status: 'posted' }))

      const response = await POST(
        createMockRequest('/api/bookkeeping/journal-entries/entry-1/commit', {
          method: 'POST',
          body: { acknowledged_warnings: ['INPUT_VAT_ABOVE_RATE'] },
        }),
        createMockRouteParams({ id: 'entry-1' }),
      )

      expect((await parseJsonResponse(response)).status).toBe(200)
      expect(mockCommitEntry).toHaveBeenCalledTimes(1)
      expect(mockAppendProcessingHistory).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'VoucherWarningsAcknowledged', aggregateId: 'entry-1' }),
      )
    })

    it('leaves a draft another flow generated to its own checks', async () => {
      mockCreateClient.mockResolvedValue(clientWithDraft({ ...typedDraft, source_type: 'system' }))
      mockCommitEntry.mockResolvedValue(makeJournalEntry({ id: 'entry-1', status: 'posted' }))

      const response = await POST(
        createMockRequest('/api/bookkeeping/journal-entries/entry-1/commit', { method: 'POST' }),
        createMockRouteParams({ id: 'entry-1' }),
      )

      expect((await parseJsonResponse(response)).status).toBe(200)
    })

    it('answers 400 to a body that is not JSON', async () => {
      const request = new Request('http://localhost/api/bookkeeping/journal-entries/entry-1/commit', { method: 'POST', body: '{nope' })
      const response = await POST(request as never, createMockRouteParams({ id: 'entry-1' }))
      expect((await parseJsonResponse(response)).status).toBe(400)
    })
  })
})
