import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({ createClient: () => Promise.resolve(mockSupabase) }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
const isAdminMock = vi.fn()
vi.mock('@/lib/auth/require-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/require-write')>()
  return {
    requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
    isCompanyAdmin: (...args: unknown[]) => isAdminMock(...args),
    getCompanyRole: actual.getCompanyRole,
    companyAdminRequiredResponse: actual.companyAdminRequiredResponse,
  }
})
const loadAttestSettingsView = vi.fn()
vi.mock('@/lib/supplier-invoices/attest-settings', () => ({
  loadAttestSettingsView: (...args: unknown[]) => loadAttestSettingsView(...args),
}))
const addAttestSubstitute = vi.fn()
const removeAttestSubstitute = vi.fn()
vi.mock('@/lib/supplier-invoices/attest-service', () => ({
  addAttestSubstitute: (...args: unknown[]) => addAttestSubstitute(...args),
  removeAttestSubstitute: (...args: unknown[]) => removeAttestSubstitute(...args),
}))

import { POST } from '../substitutes/route'
import { DELETE } from '../substitutes/[id]/route'

const EVA = '0b8f3e9a-2b1c-4c47-9a39-3a0f6f4f1d11'
const BOSSE = '6d2a1c3e-8f4b-4a5d-9e7f-1a2b3c4d5e6f'
const SUB_ID = '9a1b7c3e-1d2f-4a5b-8c6d-7e8f9a0b1c2d'
const NO_PARAMS = { params: Promise.resolve({}) }
const VIEW = { policy: { enabled: true }, substitutes: [{ id: SUB_ID, user_id: EVA, substitute_user_id: BOSSE, starts_on: '2026-12-21', ends_on: '2027-01-06', active: false }] }
const BODY = { user_id: EVA, substitute_user_id: BOSSE, starts_on: '2026-12-21', ends_on: '2027-01-06' }

describe('/api/supplier-invoices/attest-policy/substitutes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: EVA, email: 'eva@example.se' } } })
    isAdminMock.mockResolvedValue(false)
    loadAttestSettingsView.mockResolvedValue(VIEW)
  })

  it('answers 401 without a session', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    expect((await POST(createMockRequest('/x', { method: 'POST', body: BODY }), NO_PARAMS)).status).toBe(401)
    expect((await DELETE(createMockRequest('/x', { method: 'DELETE' }), { params: Promise.resolve({ id: SUB_ID }) })).status).toBe(401)
  })

  it('answers 400 for oneself as substitute, a reversed period or one over a year, and saves nothing', async () => {
    for (const body of [
      { ...BODY, substitute_user_id: EVA },
      { ...BODY, ends_on: '2026-12-01' },
      { ...BODY, ends_on: '2028-01-06' },
      { ...BODY, starts_on: '21/12' },
    ]) {
      expect((await POST(createMockRequest('/x', { method: 'POST', body }), NO_PARAMS)).status).toBe(400)
    }
    expect(addAttestSubstitute).not.toHaveBeenCalled()
  })

  it('adds as the signed-in member, telling the service whether they are an admin, and answers the fresh view', async () => {
    addAttestSubstitute.mockResolvedValue({ ok: true, data: { id: SUB_ID } })
    const { status, body } = await parseJsonResponse<{ data: unknown }>(await POST(createMockRequest('/x', { method: 'POST', body: BODY }), NO_PARAMS))
    expect(status).toBe(200)
    expect(body.data).toEqual(VIEW)
    expect(addAttestSubstitute).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1', userId: EVA }), BODY, { isAdmin: false })
  })

  it('maps the service\'s refusals', async () => {
    addAttestSubstitute.mockResolvedValue({ ok: false, code: 'FORBIDDEN', messageSv: 'Du kan bara välja ersättare för dig själv.' })
    expect((await POST(createMockRequest('/x', { method: 'POST', body: { ...BODY, user_id: BOSSE, substitute_user_id: EVA } }), NO_PARAMS)).status).toBe(403)
    addAttestSubstitute.mockResolvedValue({ ok: false, code: 'ATTEST_SUBSTITUTE_NOT_MEMBER', details: { user_ids: [BOSSE] } })
    const notMember = await parseJsonResponse<{ error: { code: string } }>(await POST(createMockRequest('/x', { method: 'POST', body: BODY }), NO_PARAMS))
    expect(notMember.status).toBe(400)
    expect(notMember.body.error.code).toBe('ATTEST_SUBSTITUTE_NOT_MEMBER')
  })

  it('DELETE answers 404 for an unknown or malformed id, and removes one', async () => {
    const malformed = await DELETE(createMockRequest('/x', { method: 'DELETE' }), { params: Promise.resolve({ id: 'nope' }) })
    expect(malformed.status).toBe(404)
    removeAttestSubstitute.mockResolvedValue({ ok: false, code: 'ATTEST_SUBSTITUTE_NOT_FOUND' })
    expect((await DELETE(createMockRequest('/x', { method: 'DELETE' }), { params: Promise.resolve({ id: SUB_ID }) })).status).toBe(404)
    removeAttestSubstitute.mockResolvedValue({ ok: true, data: { id: SUB_ID, removed: true } })
    const removed = await parseJsonResponse<{ data: unknown }>(await DELETE(createMockRequest('/x', { method: 'DELETE' }), { params: Promise.resolve({ id: SUB_ID }) }))
    expect(removed.status).toBe(200)
    expect(removeAttestSubstitute).toHaveBeenLastCalledWith(expect.objectContaining({ userId: EVA }), SUB_ID, { isAdmin: false })
  })
})
