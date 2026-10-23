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
  MeaninglessCorrectionError,
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

import { getErrorMessage } from '@/lib/errors/get-error-message'
import { POST } from '../route'

describe('POST /api/bookkeeping/journal-entries/[id]/correct', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: mockUser } }), mfa: { listFactors: async () => ({ data: { all: [], totp: [], phone: [] }, error: null }) } },
    })
  })

  it('returns 401 when not authenticated', async () => {
    mockCreateClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }), mfa: { listFactors: async () => ({ data: { all: [], totp: [], phone: [] }, error: null }) } },
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
    // Inverted from `toBe('Validation failed')`: the constant was the bug.
    // `error` now names the offending field so a UI reading only `error` is
    // actionable.
    expect(body.error).toMatch(/^Valideringsfel: /)
    expect(body.error).toContain('lines')
  })

  it('returns 400 when lines array is empty', async () => {
    const request = createMockRequest('/api/bookkeeping/journal-entries/entry-1/correct', {
      method: 'POST',
      body: { lines: [] },
    })
    const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toMatch(/^Valideringsfel: /)
    expect(body.error).toContain('At least two lines are required for double-entry')
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
    expect(mockCorrectEntry).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', 'entry-1', lines, {
      description: undefined,
    })
  })

  it('threads an optional description through to correctEntry (issue #1031)', async () => {
    const reversal = makeJournalEntry({ id: 'reversal-1', reverses_id: 'entry-1', source_type: 'storno' })
    const corrected = makeJournalEntry({ id: 'corrected-1', correction_of_id: 'entry-1', source_type: 'correction' })
    mockCorrectEntry.mockResolvedValue({ reversal, corrected })

    const lines = [
      { account_number: '2893', debit_amount: 1000, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
    ]

    const request = createMockRequest('/api/bookkeeping/journal-entries/entry-1/correct', {
      method: 'POST',
      body: { lines, description: 'Rättelse: Skulder till närstående personer, kortfristig del' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(mockCorrectEntry).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', 'entry-1', lines, {
      description: 'Rättelse: Skulder till närstående personer, kortfristig del',
    })
  })

  it('returns 400 when description is blank', async () => {
    const lines = [
      { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
      { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
    ]

    const request = createMockRequest('/api/bookkeeping/journal-entries/entry-1/correct', {
      method: 'POST',
      body: { lines, description: '   ' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toMatch(/^Valideringsfel: /)
    expect(body.error).toContain('description')
    expect(mockCorrectEntry).not.toHaveBeenCalled()
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

  describe('a second reversal and the rättelse date (crm#1397, crm#1368)', () => {
    const swapped = [
      { account_number: '6570', debit_amount: 0, credit_amount: 100 },
      { account_number: '1930', debit_amount: 100, credit_amount: 0 },
    ]
    const ok = () => {
      mockCorrectEntry.mockResolvedValue({
        reversal: makeJournalEntry({ id: 'reversal-1', reverses_id: 'entry-1', source_type: 'storno' }),
        corrected: makeJournalEntry({ id: 'corrected-1', correction_of_id: 'entry-1', source_type: 'correction' }),
      })
    }

    it('answers 400 negates_original with the Swedish way out when the engine refuses a second reversal', async () => {
      mockCorrectEntry.mockRejectedValue(new MeaninglessCorrectionError('negates_original'))

      const request = createMockRequest('/api/bookkeeping/journal-entries/entry-1/correct', {
        method: 'POST',
        body: { lines: swapped },
      })
      const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))
      const { status, body } = await parseJsonResponse<{
        error: { code: string; message: string; details?: { reason?: string } }
      }>(response)

      expect(status).toBe(400)
      expect(body.error.code).toBe('MEANINGLESS_CORRECTION')
      expect(body.error.details?.reason).toBe('negates_original')
      // What the app shows for the envelope (getErrorMessage reads the reason).
      expect(getErrorMessage(body)).toContain('Återför (storno)')
    })

    it('hands sides_swapped to correctEntry as sidesSwapped', async () => {
      ok()
      const request = createMockRequest('/api/bookkeeping/journal-entries/entry-1/correct', {
        method: 'POST',
        body: { lines: swapped, sides_swapped: true },
      })
      const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))

      expect(response.status).toBe(200)
      expect(mockCorrectEntry).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', 'entry-1', swapped, {
        description: undefined,
        sidesSwapped: true,
      })
    })

    it('hands entry_date to correctEntry as the rättelse date', async () => {
      ok()
      const lines = [
        { account_number: '6570', debit_amount: 100, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 100 },
      ]
      const request = createMockRequest('/api/bookkeeping/journal-entries/entry-1/correct', {
        method: 'POST',
        body: { lines, entry_date: '2026-07-27' },
      })
      const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))

      expect(response.status).toBe(200)
      expect(mockCorrectEntry).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', 'entry-1', lines, {
        description: undefined,
        newEntryDate: '2026-07-27',
      })
    })

    it('returns 400 for an entry_date that is not a date', async () => {
      const request = createMockRequest('/api/bookkeeping/journal-entries/entry-1/correct', {
        method: 'POST',
        body: { lines: swapped, entry_date: '27/07/2026' },
      })
      const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))
      const { status, body } = await parseJsonResponse<{ error: string }>(response)

      expect(status).toBe(400)
      expect(body.error).toContain('entry_date')
      expect(mockCorrectEntry).not.toHaveBeenCalled()
    })
  })
})
