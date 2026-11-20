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
const saveAttestMailPreference = vi.fn()
vi.mock('@/lib/supplier-invoices/attest-settings', () => ({
  loadAttestSettingsView: (...args: unknown[]) => loadAttestSettingsView(...args),
  saveAttestMailPreference: (...args: unknown[]) => saveAttestMailPreference(...args),
}))
const saveAttestPolicy = vi.fn()
vi.mock('@/lib/supplier-invoices/attest-service', () => ({
  saveAttestPolicy: (...args: unknown[]) => saveAttestPolicy(...args),
}))

import { GET, PUT } from '../route'
import { PUT as PUT_MAIL } from '../mail/route'

const NO_PARAMS = { params: Promise.resolve({}) }
const VIEW = { policy: { enabled: true, threshold_amount: 5000, mode: 'any', attesters: ['0b8f3e9a-2b1c-4c47-9a39-3a0f6f4f1d11'], preparer_may_attest: false }, candidates: [], can_edit: true, mail_enabled: true, accounting_method: 'accrual' }
const BODY = { enabled: true, threshold_amount: 5000, mode: 'any', attesters: ['0b8f3e9a-2b1c-4c47-9a39-3a0f6f4f1d11'], preparer_may_attest: false }

describe('/api/supplier-invoices/attest-policy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'a@b.se' } } })
    isAdminMock.mockResolvedValue(true)
    loadAttestSettingsView.mockResolvedValue(VIEW)
  })

  it('answers 401 without a session', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    expect((await GET(createMockRequest('/api/supplier-invoices/attest-policy'), NO_PARAMS)).status).toBe(401)
    expect((await PUT(createMockRequest('/api/supplier-invoices/attest-policy', { method: 'PUT', body: BODY }), NO_PARAMS)).status).toBe(401)
  })

  it('GET answers the settings view for the signed-in user', async () => {
    const { status, body } = await parseJsonResponse<{ data: unknown }>(await GET(createMockRequest('/api/supplier-invoices/attest-policy'), NO_PARAMS))
    expect(status).toBe(200)
    expect(body.data).toEqual(VIEW)
    expect(loadAttestSettingsView).toHaveBeenCalledWith(mockSupabase, 'company-1', 'user-1')
  })

  it('PUT is for owners and admins: a member gets 403 and nothing is saved', async () => {
    isAdminMock.mockResolvedValue(false)
    const response = await PUT(createMockRequest('/api/supplier-invoices/attest-policy', { method: 'PUT', body: BODY }), NO_PARAMS)
    expect(response.status).toBe(403)
    expect(saveAttestPolicy).not.toHaveBeenCalled()
  })

  it('PUT answers 400 for an invalid body', async () => {
    const bad = await PUT(createMockRequest('/api/supplier-invoices/attest-policy', { method: 'PUT', body: { ...BODY, mode: 'some', attesters: ['not-a-uuid'] } }), NO_PARAMS)
    expect(bad.status).toBe(400)
    expect(saveAttestPolicy).not.toHaveBeenCalled()
  })

  it('PUT maps a refusal of the rules, and saves and answers the fresh view', async () => {
    saveAttestPolicy.mockResolvedValue({ ok: false, code: 'ATTEST_POLICY_NO_ATTESTERS' })
    const refused = await parseJsonResponse<{ error: { code: string } }>(
      await PUT(createMockRequest('/api/supplier-invoices/attest-policy', { method: 'PUT', body: { ...BODY, attesters: [] } }), NO_PARAMS),
    )
    expect(refused.status).toBe(400)
    expect(refused.body.error.code).toBe('ATTEST_POLICY_NO_ATTESTERS')

    saveAttestPolicy.mockResolvedValue({ ok: true, data: VIEW.policy })
    const saved = await parseJsonResponse<{ data: unknown }>(await PUT(createMockRequest('/api/supplier-invoices/attest-policy', { method: 'PUT', body: BODY }), NO_PARAMS))
    expect(saved.status).toBe(200)
    expect(saved.body.data).toEqual(VIEW)
    expect(saveAttestPolicy).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'user-1', companyId: 'company-1' }), BODY)
  })

  it('PUT takes the levels (#135): two attesters from an amount and a limit per attester', async () => {
    const ANNA = '0b8f3e9a-2b1c-4c47-9a39-3a0f6f4f1d11'
    const BO = '6d2a1c3e-8f4b-4a5d-9e7f-1a2b3c4d5e6f'
    const levels = {
      ...BODY,
      attesters: [ANNA, BO],
      two_step_from_sek: 100000,
      limits: [
        { user_id: ANNA, max_amount_sek: 50000 },
        { user_id: BO, max_amount_sek: null },
      ],
    }
    for (const bad of [
      { ...levels, limits: [{ user_id: ANNA, max_amount_sek: 0 }] },
      // Rounds to 0 kr: refused here, not by the database's check.
      { ...levels, limits: [{ user_id: ANNA, max_amount_sek: 0.001 }] },
      { ...levels, limits: [{ user_id: ANNA, max_amount_sek: -5 }] },
      { ...levels, limits: [{ user_id: 'anna', max_amount_sek: 5 }] },
      { ...levels, two_step_from_sek: -1 },
      { ...levels, two_step_from_sek: '100000' },
    ]) {
      const response = await PUT(createMockRequest('/api/supplier-invoices/attest-policy', { method: 'PUT', body: bad }), NO_PARAMS)
      expect(response.status, JSON.stringify(bad)).toBe(400)
    }
    expect(saveAttestPolicy).not.toHaveBeenCalled()

    saveAttestPolicy.mockResolvedValue({ ok: false, code: 'ATTEST_POLICY_TWO_STEP_NEEDS_TWO' })
    const refused = await parseJsonResponse<{ error: { code: string } }>(
      await PUT(createMockRequest('/api/supplier-invoices/attest-policy', { method: 'PUT', body: { ...levels, attesters: [ANNA] } }), NO_PARAMS),
    )
    expect(refused.status).toBe(400)
    expect(refused.body.error.code).toBe('ATTEST_POLICY_TWO_STEP_NEEDS_TWO')

    saveAttestPolicy.mockResolvedValue({ ok: true, data: VIEW.policy })
    const saved = await PUT(createMockRequest('/api/supplier-invoices/attest-policy', { method: 'PUT', body: levels }), NO_PARAMS)
    expect(saved.status).toBe(200)
    expect(saveAttestPolicy).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'user-1', companyId: 'company-1' }), levels)
  })

  it('mail: any member switches their own attest mail, with a boolean only', async () => {
    expect((await PUT_MAIL(createMockRequest('/api/supplier-invoices/attest-policy/mail', { method: 'PUT', body: { enabled: 'yes' } }), NO_PARAMS)).status).toBe(400)
    const { status, body } = await parseJsonResponse<{ data: unknown }>(
      await PUT_MAIL(createMockRequest('/api/supplier-invoices/attest-policy/mail', { method: 'PUT', body: { enabled: false } }), NO_PARAMS),
    )
    expect(status).toBe(200)
    expect(body.data).toEqual({ enabled: false })
    expect(saveAttestMailPreference).toHaveBeenCalledWith(mockSupabase, 'user-1', false)
  })
})
