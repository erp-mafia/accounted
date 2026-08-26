import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(supabase),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { GET, POST } from '../route'

const params = { params: Promise.resolve({ id: 'company-1' }) }
const validBody = {
  confirm_name: 'Testbolaget AB',
  reason: 'Den första migreringen fick fel periodindelning.',
  confirm_no_filed_declarations: true,
  confirm_retained_archive: true,
}

describe('/api/company/[id]/migration-reset', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    supabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'owner@example.com' } },
      error: null,
    })
  })

  it('returns 401 when unauthenticated', async () => {
    supabase.auth.getUser.mockResolvedValue({ data: { user: null }, error: null })

    const response = await POST(
      createMockRequest('/api/company/company-1/migration-reset', {
        method: 'POST',
        body: validBody,
      }),
      params,
    )

    expect(response.status).toBe(401)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('returns 400 when a strong confirmation is missing', async () => {
    const response = await POST(
      createMockRequest('/api/company/company-1/migration-reset', {
        method: 'POST',
        body: { ...validBody, confirm_retained_archive: false },
      }),
      params,
    )

    expect(response.status).toBe(400)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('returns 400 when the audit reason is too short', async () => {
    const response = await POST(
      createMockRequest('/api/company/company-1/migration-reset', {
        method: 'POST',
        body: { ...validBody, reason: 'För kort' },
      }),
      params,
    )

    expect(response.status).toBe(400)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('returns 404 when the URL is not the active company', async () => {
    const response = await POST(
      createMockRequest('/api/company/company-2/migration-reset', {
        method: 'POST',
        body: validBody,
      }),
      { params: Promise.resolve({ id: 'company-2' }) },
    )

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(404)
    expect(body.error.code).toBe('COMPANY_RESET_NOT_FOUND')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('returns 403 when the eligibility RPC rejects a non-owner', async () => {
    enqueue({ data: { ok: false, code: 'COMPANY_RESET_FORBIDDEN' }, error: null })

    const response = await GET(
      createMockRequest('/api/company/company-1/migration-reset'),
      params,
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(403)
    expect(body.error.code).toBe('COMPANY_RESET_FORBIDDEN')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('returns the owner eligibility preview', async () => {
    enqueue({
      data: {
        ok: true,
        eligibility: {
          eligible: true,
          display_name: 'Testbolaget AB',
          counts: { journal_entries: 0, documents: 2, voucher_sequences: 0 },
          blockers: [],
        },
      },
      error: null,
    })

    const response = await GET(
      createMockRequest('/api/company/company-1/migration-reset'),
      params,
    )
    const { status, body } = await parseJsonResponse<{
      data: { eligible: boolean; counts: { documents: number } }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.eligible).toBe(true)
    expect(body.data.counts.documents).toBe(2)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(supabase.rpc).toHaveBeenCalledWith(
      'get_company_migration_reset_eligibility',
      { p_company_id: 'company-1' },
    )
  })

  it('returns 409 with current blockers when execution is ineligible', async () => {
    enqueue({
      data: {
        ok: false,
        code: 'COMPANY_RESET_INELIGIBLE',
        details: {
          eligible: false,
          blockers: [{ code: 'authority_submission_detected', count: 1 }],
        },
      },
      error: null,
    })

    const response = await POST(
      createMockRequest('/api/company/company-1/migration-reset', {
        method: 'POST',
        body: validBody,
      }),
      params,
    )
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { blockers: Array<{ code: string }> } }
    }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('COMPANY_RESET_INELIGIBLE')
    expect(body.error.details.blockers[0].code).toBe('authority_submission_detected')
  })

  it('returns the replacement and switches the active-company cookie', async () => {
    enqueue({
      data: {
        ok: true,
        reset_id: 'reset-1',
        source_company_id: 'company-1',
        replacement_company_id: 'company-new',
        archived_at: '2026-08-18T09:00:00.000Z',
        counts: { journal_entries: 0, documents: 2 },
      },
      error: null,
    })

    const response = await POST(
      createMockRequest('/api/company/company-1/migration-reset', {
        method: 'POST',
        body: validBody,
      }),
      params,
    )
    const { status, body } = await parseJsonResponse<{
      data: { resetId: string; replacementCompanyId: string; retainedCounts: unknown }
    }>(response)

    expect(status).toBe(200)
    expect(body.data).toMatchObject({
      resetId: 'reset-1',
      replacementCompanyId: 'company-new',
      retainedCounts: { journal_entries: 0, documents: 2 },
    })
    expect(response.headers.get('set-cookie')).toContain('gnubok-company-id=company-new')
    expect(supabase.rpc).toHaveBeenCalledWith('reset_company_for_migration', {
      p_company_id: 'company-1',
      p_confirmed_name: validBody.confirm_name,
      p_reason: validBody.reason,
      p_confirm_no_filed_declarations: true,
      p_confirm_retained_archive: true,
    })
  })

  it('returns 500 when the atomic RPC fails', async () => {
    enqueue({ data: null, error: { code: 'XX000', message: 'transaction failed' } })

    const response = await POST(
      createMockRequest('/api/company/company-1/migration-reset', {
        method: 'POST',
        body: validBody,
      }),
      params,
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(500)
    expect(body.error.code).toBe('COMPANY_RESET_FAILED')
  })

  it('falls back to COMPANY_RESET_FAILED for an unexpected RPC code', async () => {
    enqueue({ data: { ok: false, code: 'SOME_INTERNAL_CODE' }, error: null })

    const response = await POST(
      createMockRequest('/api/company/company-1/migration-reset', {
        method: 'POST',
        body: validBody,
      }),
      params,
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(500)
    expect(body.error.code).toBe('COMPANY_RESET_FAILED')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })
})
