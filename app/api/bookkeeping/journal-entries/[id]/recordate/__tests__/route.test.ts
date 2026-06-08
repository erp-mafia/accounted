import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  makeJournalEntry,
} from '@/tests/helpers'
import { TargetPeriodLockedError, MeaninglessCorrectionError } from '@/lib/bookkeeping/errors'

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

const mockRecordateEntry = vi.fn()
vi.mock('@/lib/core/bookkeeping/storno-service', () => ({
  recordateEntry: (...args: unknown[]) => mockRecordateEntry(...args),
}))

import { POST } from '../route'

describe('POST /api/bookkeeping/journal-entries/[id]/recordate', () => {
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

    const request = createMockRequest('/api/bookkeeping/journal-entries/entry-1/recordate', {
      method: 'POST',
      body: { new_entry_date: '2025-07-03' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 400 when new_entry_date is missing', async () => {
    const request = createMockRequest('/api/bookkeeping/journal-entries/entry-1/recordate', {
      method: 'POST',
      body: {},
    })
    const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toBe('Validation failed')
  })

  it('returns 400 when new_entry_date is not an ISO date', async () => {
    const request = createMockRequest('/api/bookkeeping/journal-entries/entry-1/recordate', {
      method: 'POST',
      body: { new_entry_date: '03/07/2025' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toBe('Validation failed')
  })

  it('returns reversal and corrected entries on success', async () => {
    const reversal = makeJournalEntry({ id: 'reversal-1', reverses_id: 'entry-1', source_type: 'storno' })
    const corrected = makeJournalEntry({
      id: 'corrected-1',
      correction_of_id: 'entry-1',
      source_type: 'correction',
      entry_date: '2025-07-03',
    })
    mockRecordateEntry.mockResolvedValue({ reversal, corrected })

    const request = createMockRequest('/api/bookkeeping/journal-entries/entry-1/recordate', {
      method: 'POST',
      body: { new_entry_date: '2025-07-03' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))
    const { status, body } = await parseJsonResponse<{ data: { reversal: unknown; corrected: unknown } }>(response)

    expect(status).toBe(200)
    expect(body.data.corrected).toEqual(corrected)
    expect(mockRecordateEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      'entry-1',
      '2025-07-03'
    )
  })

  it('maps a no-op move (same date) to a 400 with the typed reason', async () => {
    mockRecordateEntry.mockRejectedValue(new MeaninglessCorrectionError('no_date_change'))

    const request = createMockRequest('/api/bookkeeping/journal-entries/entry-1/recordate', {
      method: 'POST',
      body: { new_entry_date: '2026-07-03' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string; details: { reason: string } } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('MEANINGLESS_CORRECTION')
    expect(body.error.details.reason).toBe('no_date_change')
  })

  it('maps a locked target period to a 409 with the typed code', async () => {
    mockRecordateEntry.mockRejectedValue(new TargetPeriodLockedError('2025-07-03', '2025-12-31'))

    const request = createMockRequest('/api/bookkeeping/journal-entries/entry-1/recordate', {
      method: 'POST',
      body: { new_entry_date: '2025-07-03' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'entry-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string; details: { lockDate: string } } }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('TARGET_PERIOD_LOCKED')
    expect(body.error.details.lockDate).toBe('2025-12-31')
  })
})
