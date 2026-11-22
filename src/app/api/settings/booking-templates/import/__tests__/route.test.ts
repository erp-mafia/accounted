/**
 * Tests for POST /api/settings/booking-templates/import.
 *
 * The file comes from another company, so a line's dimensions (that company's
 * own cost centre and project codes) are not imported with it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

import { POST } from '../route'

/** A supabase whose insert records its rows and answers them back. */
function createInsertingSupabase(error: { message: string } | null = null) {
  const inserted: Array<Record<string, unknown>[]> = []
  const supabase = {
    from: () => ({
      insert: (rows: Record<string, unknown>[]) => {
        inserted.push(rows)
        return { select: () => Promise.resolve({ data: error ? null : rows, error }) }
      },
    }),
  }
  return { supabase, inserted }
}

const lines = [
  { account: '5010', label: 'Hyra', side: 'debit', type: 'business', ratio: 1 },
  { account: '1930', label: 'Bank', side: 'credit', type: 'settlement', ratio: 1 },
]

const emptyParams = { params: Promise.resolve({}) }

function importRequest(body: unknown) {
  return createMockRequest('/api/settings/booking-templates/import', { method: 'POST', body })
}

function auth(supabase: unknown) {
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
}

beforeEach(() => {
  vi.clearAllMocks()
  requireWriteMock.mockResolvedValue({ ok: true })
})

describe('POST /api/settings/booking-templates/import', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await POST(importRequest({ version: 1, templates: [{ name: 'Hyra', lines }] }), emptyParams)
    expect(response.status).toBe(401)
  })

  it('returns 400 for a template with fewer than two lines', async () => {
    const { supabase, inserted } = createInsertingSupabase()
    auth(supabase)
    const { status } = await parseJsonResponse(
      await POST(importRequest({ version: 1, templates: [{ name: 'Hyra', lines: [lines[0]] }] }), emptyParams),
    )
    expect(status).toBe(400)
    expect(inserted).toHaveLength(0)
  })

  it('imports the templates into the active company', async () => {
    const { supabase, inserted } = createInsertingSupabase()
    auth(supabase)
    const { status, body } = await parseJsonResponse<{ imported: number }>(
      await POST(importRequest({ version: 1, templates: [{ name: 'Hyra', lines }] }), emptyParams),
    )
    expect(status).toBe(201)
    expect(body.imported).toBe(1)
    expect(inserted[0][0]).toMatchObject({ company_id: 'company-1', team_id: null, name: 'Hyra', lines, is_system: false })
  })

  it("leaves the exporting company's dimension codes out of the imported lines", async () => {
    const { supabase, inserted } = createInsertingSupabase()
    auth(supabase)
    const tagged = [{ ...lines[0], dimensions: { '1': 'KS01', '6': 'P001' } }, lines[1]]
    const { status } = await parseJsonResponse(
      await POST(importRequest({ version: 1, templates: [{ name: 'Hyra', lines: tagged }] }), emptyParams),
    )
    expect(status).toBe(201)
    expect(inserted[0][0].lines).toEqual(lines)
  })

  it('returns 500 when the insert fails', async () => {
    const { supabase } = createInsertingSupabase({ message: 'boom' })
    auth(supabase)
    const { status } = await parseJsonResponse(
      await POST(importRequest({ version: 1, templates: [{ name: 'Hyra', lines }] }), emptyParams),
    )
    expect(status).toBe(500)
  })
})
