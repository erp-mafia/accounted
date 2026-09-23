import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn(),
}))

import {
  requireWritePermission,
  getCompanyRole,
  isCompanyAdmin,
  companyAdminRequiredResponse,
} from '../require-write'
import { getActiveCompanyId } from '@/lib/company/context'
import type { SupabaseClient } from '@supabase/supabase-js'

const asClient = (mock: unknown) => mock as SupabaseClient

describe('requireWritePermission', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns ok for owner', async () => {
    const { supabase, mockResult } = createMockSupabase()
    vi.mocked(getActiveCompanyId).mockResolvedValue('company-1')
    mockResult({ data: { role: 'owner' } })

    const result = await requireWritePermission(supabase, 'user-1')
    expect(result.ok).toBe(true)
  })

  it('returns ok for admin', async () => {
    const { supabase, mockResult } = createMockSupabase()
    vi.mocked(getActiveCompanyId).mockResolvedValue('company-1')
    mockResult({ data: { role: 'admin' } })

    const result = await requireWritePermission(supabase, 'user-1')
    expect(result.ok).toBe(true)
  })

  it('returns ok for member', async () => {
    const { supabase, mockResult } = createMockSupabase()
    vi.mocked(getActiveCompanyId).mockResolvedValue('company-1')
    mockResult({ data: { role: 'member' } })

    const result = await requireWritePermission(supabase, 'user-1')
    expect(result.ok).toBe(true)
  })

  it('returns 403 for viewer', async () => {
    const { supabase, mockResult } = createMockSupabase()
    vi.mocked(getActiveCompanyId).mockResolvedValue('company-1')
    mockResult({ data: { role: 'viewer' } })

    const result = await requireWritePermission(supabase, 'user-1')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.status).toBe(403)
      const body = await result.response.json()
      expect(body.error).toContain('läsbehörighet')
    }
  })

  it('returns 403 when user has no membership', async () => {
    const { supabase, mockResult } = createMockSupabase()
    vi.mocked(getActiveCompanyId).mockResolvedValue('company-1')
    mockResult({ data: null })

    const result = await requireWritePermission(supabase, 'user-1')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.status).toBe(403)
    }
  })

  it('returns 403 when there is no active company', async () => {
    const { supabase } = createMockSupabase()
    vi.mocked(getActiveCompanyId).mockResolvedValue(null)

    const result = await requireWritePermission(supabase, 'user-1')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.status).toBe(403)
      const body = await result.response.json()
      expect(body.error).toContain('aktivt företag')
    }
  })
})

describe('requireWritePermission with a known route context', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('skips the active-company resolution when companyId is known', async () => {
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: { role: 'member' } })

    const result = await requireWritePermission(supabase, 'user-1', { companyId: 'company-9' })
    expect(result.ok).toBe(true)
    expect(getActiveCompanyId).not.toHaveBeenCalled()
    expect(supabase.from).toHaveBeenCalledTimes(1)
    expect(supabase.from).toHaveBeenCalledWith('company_members')
  })

  it('skips the membership select when the role is known too', async () => {
    const { supabase } = createMockSupabase()

    const result = await requireWritePermission(supabase, 'user-1', {
      companyId: 'company-9',
      role: 'admin',
    })
    expect(result.ok).toBe(true)
    expect(getActiveCompanyId).not.toHaveBeenCalled()
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('still rejects a known viewer role with 403', async () => {
    const { supabase } = createMockSupabase()

    const result = await requireWritePermission(supabase, 'user-1', {
      companyId: 'company-9',
      role: 'viewer',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.response.status).toBe(403)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('a known company with no membership row is rejected, not trusted', async () => {
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: null })

    const result = await requireWritePermission(supabase, 'user-1', { companyId: 'company-9' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.response.status).toBe(403)
  })

  it('falls back to resolution when no context is passed (legacy callers)', async () => {
    const { supabase, mockResult } = createMockSupabase()
    vi.mocked(getActiveCompanyId).mockResolvedValue('company-1')
    mockResult({ data: { role: 'owner' } })

    const result = await requireWritePermission(supabase, 'user-1', undefined)
    expect(result.ok).toBe(true)
    expect(getActiveCompanyId).toHaveBeenCalledTimes(1)
  })
})

describe('getCompanyRole', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns role and companyId for owner', async () => {
    const { supabase, mockResult } = createMockSupabase()
    vi.mocked(getActiveCompanyId).mockResolvedValue('company-1')
    mockResult({ data: { role: 'owner' } })

    const result = await getCompanyRole(supabase, 'user-1')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.role).toBe('owner')
      expect(result.companyId).toBe('company-1')
    }
  })

  it('returns role for viewer (does not block)', async () => {
    const { supabase, mockResult } = createMockSupabase()
    vi.mocked(getActiveCompanyId).mockResolvedValue('company-1')
    mockResult({ data: { role: 'viewer' } })

    const result = await getCompanyRole(supabase, 'user-1')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.role).toBe('viewer')
      expect(result.companyId).toBe('company-1')
    }
  })

  it('returns 403 when user has no membership', async () => {
    const { supabase, mockResult } = createMockSupabase()
    vi.mocked(getActiveCompanyId).mockResolvedValue('company-1')
    mockResult({ data: null })

    const result = await getCompanyRole(supabase, 'user-1')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.status).toBe(403)
    }
  })

  it('returns 403 when there is no active company', async () => {
    const { supabase } = createMockSupabase()
    vi.mocked(getActiveCompanyId).mockResolvedValue(null)

    const result = await getCompanyRole(supabase, 'user-1')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.status).toBe(403)
      const body = await result.response.json()
      expect(body.error).toContain('aktivt företag')
    }
  })
})

describe('isCompanyAdmin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('asks the database predicate the admin-only RLS policies use, for the given company', async () => {
    const { supabase } = createMockSupabase()
    supabase.rpc.mockResolvedValue({ data: true, error: null })

    expect(await isCompanyAdmin(asClient(supabase), 'company-1')).toBe(true)
    expect(supabase.rpc).toHaveBeenCalledWith('user_is_company_admin', { p_company_id: 'company-1' })
    // No second definition in TypeScript: the role is never read here.
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('answers false when the predicate says no (member, viewer, stranger)', async () => {
    const { supabase } = createMockSupabase()
    supabase.rpc.mockResolvedValue({ data: false, error: null })

    expect(await isCompanyAdmin(asClient(supabase), 'company-1')).toBe(false)
  })

  it('fails closed on a null answer', async () => {
    const { supabase } = createMockSupabase()
    supabase.rpc.mockResolvedValue({ data: null, error: null })

    expect(await isCompanyAdmin(asClient(supabase), 'company-1')).toBe(false)
  })

  it('throws when the predicate cannot be evaluated: "could not check" is not "not allowed"', async () => {
    const { supabase } = createMockSupabase()
    supabase.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'function not found' } })

    await expect(isCompanyAdmin(asClient(supabase), 'company-1')).rejects.toMatchObject({ code: 'PGRST202' })
  })
})

describe('companyAdminRequiredResponse', () => {
  it('is the canonical 403 envelope, in Swedish, naming the roles that may act', async () => {
    const log = { error: vi.fn(), warn: vi.fn() }

    const response = companyAdminRequiredResponse(log, 'req_test')

    expect(response.status).toBe(403)
    expect(response.headers.get('X-Request-Id')).toBe('req_test')
    const body = await response.json()
    expect(body.error.code).toBe('FORBIDDEN')
    expect(body.error.message).toBe('Bara företagets ägare eller en administratör kan göra det här.')
    expect(body.error.message_en).toBe('Only the company owner or an administrator can do this.')
    expect(body.error.details).toEqual({ required_roles: ['owner', 'admin'] })
    // An expected refusal, not a server fault: never logged at error level.
    expect(log.error).not.toHaveBeenCalled()
  })
})
