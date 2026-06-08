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
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: mockUser } }) },
    })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 when not authenticated', async () => {
    mockCreateClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
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
})
