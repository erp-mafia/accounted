import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  makeJournalEntry,
} from '@/tests/helpers'
import {
  JournalEntryNotBalancedError,
  CannotCorrectNonPostedError,
} from '@/lib/bookkeeping/errors'

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

const mockCorrectEntry = vi.fn()
vi.mock('@/lib/core/bookkeeping/storno-service', () => ({
  correctEntry: (...args: unknown[]) => mockCorrectEntry(...args),
}))

import { POST } from '../route'

describe('POST /api/bookkeeping/journal-entries/[id]/correct', () => {
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

    const request = createMockRequest('/api/bookkeeping/journal-entries/entry-1/correct', {
      method: 'POST',
      body: { lines: [] },
    })
    const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 400 when lines are missing', async () => {
    const request = createMockRequest('/api/bookkeeping/journal-entries/entry-1/correct', {
      method: 'POST',
      body: {},
    })
    const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toBe('Validation failed')
  })

  it('returns 400 when lines array is empty', async () => {
    const request = createMockRequest('/api/bookkeeping/journal-entries/entry-1/correct', {
      method: 'POST',
      body: { lines: [] },
    })
    const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toBe('Validation failed')
  })

  it('returns reversal and corrected entries on success', async () => {
    const reversal = makeJournalEntry({
      id: 'reversal-1',
      reverses_id: 'entry-1',
      source_type: 'storno',
    })
    const corrected = makeJournalEntry({
      id: 'corrected-1',
      correction_of_id: 'entry-1',
      source_type: 'correction',
    })
    mockCorrectEntry.mockResolvedValue({ reversal, corrected })

    const lines = [
      { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
      { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
    ]

    const request = createMockRequest('/api/bookkeeping/journal-entries/entry-1/correct', {
      method: 'POST',
      body: { lines },
    })
    const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))
    const { status, body } = await parseJsonResponse<{ data: { reversal: unknown; corrected: unknown } }>(response)

    expect(status).toBe(200)
    expect(body.data.reversal).toEqual(reversal)
    expect(body.data.corrected).toEqual(corrected)
    expect(mockCorrectEntry).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', 'entry-1', lines)
  })

  it('maps an unbalanced-correction engine error to the canonical envelope (400)', async () => {
    mockCorrectEntry.mockRejectedValue(new JournalEntryNotBalancedError(1000, 500, 'correction'))

    const lines = [
      { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
      { account_number: '3001', debit_amount: 0, credit_amount: 500 },
    ]

    const request = createMockRequest('/api/bookkeeping/journal-entries/entry-1/correct', {
      method: 'POST',
      body: { lines },
    })
    const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('JOURNAL_ENTRY_NOT_BALANCED')
  })

  it('maps a not-posted engine error to the canonical envelope (400)', async () => {
    mockCorrectEntry.mockRejectedValue(new CannotCorrectNonPostedError('draft'))

    const lines = [
      { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
      { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
    ]

    const request = createMockRequest('/api/bookkeeping/journal-entries/entry-1/correct', {
      method: 'POST',
      body: { lines },
    })
    const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('CANNOT_CORRECT_NON_POSTED')
  })
})
