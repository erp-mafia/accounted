import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  makeJournalEntry,
} from '@/tests/helpers'
import { EntryAlreadyReversedError } from '@/lib/bookkeeping/errors'

// Mock dependencies before imports
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

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

const mockReverseEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  reverseEntry: (...args: unknown[]) => mockReverseEntry(...args),
}))

import { POST } from '../route'

describe('POST /api/bookkeeping/journal-entries/[id]/reverse', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: mockUser } }) },
    })
  })

  it('returns 401 when not authenticated', async () => {
    mockCreateClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    })

    const request = createMockRequest('/api/bookkeeping/journal-entries/entry-1/reverse', {
      method: 'POST',
    })
    const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns reversed entry on success', async () => {
    const reversalEntry = makeJournalEntry({
      id: 'reversal-1',
      reverses_id: 'entry-1',
      source_type: 'storno',
    })
    mockReverseEntry.mockResolvedValue(reversalEntry)

    const request = createMockRequest('/api/bookkeeping/journal-entries/entry-1/reverse', {
      method: 'POST',
    })
    const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))
    const { status, body } = await parseJsonResponse<{ data: unknown }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual(reversalEntry)
    expect(mockReverseEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      'entry-1',
      undefined,
      { allowDeepChain: false },
    )
  })

  it('returns 400 for malformed JSON instead of silently reversing without the override', async () => {
    // Raw Request: createMockRequest would JSON.stringify the body and turn
    // the malformed payload into a valid JSON string literal.
    const request = new Request('http://localhost:3000/api/bookkeeping/journal-entries/entry-1/reverse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ allow_deep_chain: tru',
    })
    const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(mockReverseEntry).not.toHaveBeenCalled()
  })

  it('returns 400 for a non-boolean allow_deep_chain', async () => {
    const request = createMockRequest('/api/bookkeeping/journal-entries/entry-1/reverse', {
      method: 'POST',
      body: { allow_deep_chain: 'yes' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(mockReverseEntry).not.toHaveBeenCalled()
  })

  it('forwards allow_deep_chain=true from the body (guard bypass)', async () => {
    const reversalEntry = makeJournalEntry({
      id: 'reversal-1',
      reverses_id: 'entry-1',
      source_type: 'storno',
    })
    mockReverseEntry.mockResolvedValue(reversalEntry)

    const request = createMockRequest('/api/bookkeeping/journal-entries/entry-1/reverse', {
      method: 'POST',
      body: { allow_deep_chain: true },
    })
    const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(mockReverseEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      'entry-1',
      undefined,
      { allowDeepChain: true },
    )
  })

  it('maps a typed concurrent-reversal error to the canonical envelope (409)', async () => {
    // reverseEntry throws the typed error on a concurrent storno; the wrapper
    // routes it through errorResponse() → 409 + { error: { code, ... } }.
    mockReverseEntry.mockRejectedValue(new EntryAlreadyReversedError())

    const request = createMockRequest('/api/bookkeeping/journal-entries/entry-1/reverse', {
      method: 'POST',
    })
    const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('ENTRY_ALREADY_REVERSED')
  })
})
