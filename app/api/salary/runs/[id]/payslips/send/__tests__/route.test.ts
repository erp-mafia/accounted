import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
} from '@/tests/helpers'

// The route is wrapped in withRouteContext (auth via requireAuth, company via
// getActiveCompanyId, write gate via requireWritePermission) — mock those.
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/email/service', () => ({ getEmailService: vi.fn() }))
vi.mock('@/lib/entitlements/has-capability', () => ({
  requireCapability: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/lib/branding/service', () => ({
  getBranding: () => ({ appUrl: 'https://app.example.test' }),
}))
vi.mock('@/lib/salary/payslips/links', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/salary/payslips/links')>()
  return {
    ...actual,
    rotateLinkForEmployee: vi.fn(),
  }
})

import { POST } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { getEmailService } from '@/lib/email/service'
import { rotateLinkForEmployee } from '@/lib/salary/payslips/links'

const mockUser = { id: 'user-1', email: 'test@test.se' }

function authed(supabase: unknown) {
  vi.mocked(requireAuth).mockResolvedValue({
    user: mockUser as never,
    supabase: supabase as never,
    error: null,
  } as never)
}

function mockEmail(result: { success: boolean; messageId?: string; error?: string }) {
  const sendEmail = vi.fn().mockResolvedValue(result)
  vi.mocked(getEmailService).mockReturnValue({
    sendEmail,
    isConfigured: () => true,
  })
  return sendEmail
}

const RUN = {
  id: 'run-1',
  company_id: 'company-1',
  status: 'approved',
  period_year: 2026,
  period_month: 6,
  payment_date: '2026-06-25',
}

describe('POST /api/salary/runs/[id]/payslips/send', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(rotateLinkForEmployee).mockResolvedValue({ token: 'T'.repeat(43) })
  })

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null,
      supabase: null,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    } as never)

    const request = createMockRequest('/api/salary/runs/run-1/payslips/send', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'run-1' }))
    expect(response.status).toBe(401)
  })

  it('returns 403 when the company lacks the email_send capability', async () => {
    const { requireCapability } = await import('@/lib/entitlements/has-capability')
    vi.mocked(requireCapability).mockResolvedValueOnce(
      NextResponse.json({ capability_blocked: true }, { status: 403 }),
    )
    const { supabase } = createQueuedMockSupabase()
    authed(supabase)
    mockEmail({ success: true })

    const request = createMockRequest('/api/salary/runs/run-1/payslips/send', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'run-1' }))
    expect(response.status).toBe(403)
  })

  it('returns 404 when the run does not exist', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    authed(supabase)
    mockEmail({ success: true })
    enqueueMany([{ data: null }])

    const request = createMockRequest('/api/salary/runs/run-x/payslips/send', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'run-x' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(404)
    expect(body.error.code).toBe('SALARY_RUN_NOT_FOUND')
  })

  it('returns 400 for a draft run', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    authed(supabase)
    mockEmail({ success: true })
    enqueueMany([{ data: { ...RUN, status: 'draft' } }])

    const request = createMockRequest('/api/salary/runs/run-1/payslips/send', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'run-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('SALARY_PAYSLIPS_SEND_INVALID_STATUS')
  })

  it('skips employees without email and records the skip', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    authed(supabase)
    const sendEmail = mockEmail({ success: true })

    enqueueMany([
      { data: RUN },
      { data: { name: 'Bolaget AB', org_number: '5560000000' } },
      {
        data: [
          {
            employee_id: 'emp-1',
            employee: { first_name: 'Anna', last_name: 'A', email: null },
          },
        ],
      },
      // delivery insert consumes a default queue entry
    ])

    const request = createMockRequest('/api/salary/runs/run-1/payslips/send', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'run-1' }))
    const { status, body } = await parseJsonResponse<{
      data: { sent: number; skipped: number; total: number }
    }>(response)

    expect(status).toBe(200)
    expect(body.data).toMatchObject({ sent: 0, skipped: 1, total: 1 })
    expect(sendEmail).not.toHaveBeenCalled()
    expect(rotateLinkForEmployee).not.toHaveBeenCalled()
  })

  it('rotates a link and emails a URL — never an attachment', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    authed(supabase)
    const sendEmail = mockEmail({ success: true, messageId: 'msg-1' })

    enqueueMany([
      { data: RUN },
      { data: { name: 'Bolaget AB', org_number: '5560000000' } },
      {
        data: [
          {
            employee_id: 'emp-1',
            employee: { first_name: 'Anna', last_name: 'A', email: 'anna@example.test' },
          },
        ],
      },
    ])

    const request = createMockRequest('/api/salary/runs/run-1/payslips/send', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'run-1' }))
    const { status, body } = await parseJsonResponse<{
      data: { sent: number; skipped: number }
    }>(response)

    expect(status).toBe(200)
    expect(body.data).toMatchObject({ sent: 1, skipped: 0 })
    expect(rotateLinkForEmployee).toHaveBeenCalledWith(supabase, {
      companyId: 'company-1',
      salaryRunId: 'run-1',
      employeeId: 'emp-1',
      userId: 'user-1',
    })

    const emailArgs = sendEmail.mock.calls[0][0]
    expect(emailArgs.to).toBe('anna@example.test')
    expect(emailArgs.html).toContain(`https://app.example.test/payslip/${'T'.repeat(43)}`)
    expect(emailArgs.attachments).toBeUndefined()
  })

  it('records provider failures without failing the whole batch', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    authed(supabase)
    mockEmail({ success: false, error: 'rate limited' })

    enqueueMany([
      { data: RUN },
      { data: { name: 'Bolaget AB', org_number: '5560000000' } },
      {
        data: [
          {
            employee_id: 'emp-1',
            employee: { first_name: 'Anna', last_name: 'A', email: 'anna@example.test' },
          },
        ],
      },
    ])

    const request = createMockRequest('/api/salary/runs/run-1/payslips/send', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'run-1' }))
    const { status, body } = await parseJsonResponse<{
      data: { sent: number; errors?: string[] }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.sent).toBe(0)
    expect(body.data.errors).toHaveLength(1)
    expect(body.data.errors?.[0]).toContain('rate limited')
  })
})
