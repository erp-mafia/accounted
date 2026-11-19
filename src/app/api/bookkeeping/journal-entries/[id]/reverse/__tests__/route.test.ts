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

const mockVoucherOwner = vi.fn()
vi.mock('@/lib/core/bookkeeping/voucher-owner', () => ({
  voucherOwnerOrNull: (...args: unknown[]) => mockVoucherOwner(...args),
}))

import { POST } from '../route'

describe('POST /api/bookkeeping/journal-entries/[id]/reverse', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    mockVoucherOwner.mockResolvedValue(null)
    mockCreateClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: mockUser } }), mfa: { listFactors: async () => ({ data: { all: [], totp: [], phone: [] }, error: null }) } },
    })
  })

  it('returns 401 when not authenticated', async () => {
    mockCreateClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }), mfa: { listFactors: async () => ({ data: { all: [], totp: [], phone: [] }, error: null }) } },
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

  // Advice, never a refusal: an agent or a bulk flow may mean to reverse an
  // invoice's verifikat on its own, so the storno is posted and the answer
  // names the invoice and its own action.
  it('reverses an owned verifikat and names its owner in owned_by', async () => {
    mockReverseEntry.mockResolvedValue(makeJournalEntry({ id: 'reversal-1', reverses_id: 'entry-1', source_type: 'storno' }))
    mockVoucherOwner.mockResolvedValue({ kind: 'supplier_invoice', owner_id: 'si-1', action: 'credit_supplier_invoice' })

    const request = createMockRequest('/api/bookkeeping/journal-entries/entry-1/reverse', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))
    const { status, body } = await parseJsonResponse<{ data: { id: string }; owned_by: { kind: string } | null }>(response)

    expect(status).toBe(200)
    expect(body.data.id).toBe('reversal-1')
    expect(body.owned_by).toMatchObject({ kind: 'supplier_invoice', owner_id: 'si-1' })
    expect(mockVoucherOwner).toHaveBeenCalledWith(expect.anything(), 'company-1', { id: 'entry-1' })
  })

  it('answers owned_by null for a verifikat no object owns', async () => {
    mockReverseEntry.mockResolvedValue(makeJournalEntry({ id: 'reversal-1', reverses_id: 'entry-1', source_type: 'storno' }))

    const request = createMockRequest('/api/bookkeeping/journal-entries/entry-1/reverse', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))
    const { status, body } = await parseJsonResponse<{ owned_by: unknown }>(response)

    expect(status).toBe(200)
    expect(body.owned_by).toBeNull()
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
