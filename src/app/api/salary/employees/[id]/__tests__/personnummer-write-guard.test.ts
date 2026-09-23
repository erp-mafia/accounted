/**
 * PATCH /api/salary/employees/[id]: the personnummer wipe guard.
 *
 * The route used to build its update payload with `{ ...body }` and then apply
 * the encrypt branch only under `if (body.personnummer)`. For an empty string
 * that branch is skipped, but the spread has already put '' into the payload:
 * the UPDATE would overwrite the AES-256-GCM ciphertext with an empty string and
 * leave personnummer_last4 pointing at the old value. Nothing in the route
 * stopped it. The only thing standing in the way was the 12-digit regex in
 * UpdateEmployeeSchema, i.e. a guard in a DIFFERENT file, and house style in
 * lib/api/schemas.ts adds `.or(z.literal(''))` to optional string fields
 * (see clearing_number, account_number, bankgiro, tax_contact_email, ...).
 * One such edit to the employee schema would have turned a routine "clear this
 * field" idiom into silent destruction of encrypted PII.
 *
 * These tests deliberately mock @/lib/api/schemas so the personnummer field is
 * waved through validation and the request reaches the route body. They therefore
 * assert the defence that lives in the write path, not the one that lives in the
 * schema. `captured.updates` staying null means no UPDATE was issued at all, so
 * the ciphertext survives.
 *
 * Fixtures are obviously synthetic: no real personnummer appears here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest } from '@/tests/helpers'

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getCompanyEntityType: vi.fn().mockResolvedValue('aktiebolag'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

// A schema that validates everything EXCEPT the personnummer shape. The point
// is to prove the route defends on its own, so the field is waved through here
// and the only remaining guard is the one in the write path. The concrete
// production edit that produces the empty-string case is a single
// `.or(z.literal(''))` on the real schema's personnummer field, matching how
// clearing_number, account_number, bankgiro and tax_contact_email are already
// written in lib/api/schemas.ts.
vi.mock('@/lib/api/schemas', async () => {
  const { z } = await import('zod')
  return {
    UpdateEmployeeSchema: z.object({
      first_name: z.string().min(1).max(200).optional(),
      personnummer: z.string().nullable().optional(),
    }),
  }
})

import { PATCH } from '../route'
import { encryptPersonnummer } from '@/lib/salary/personnummer'

const params = { params: Promise.resolve({ id: 'emp-1' }) } as never

const STORED_CIPHERTEXT = encryptPersonnummer('190203040000')

const EXISTING_ROW = {
  id: 'emp-1',
  company_id: 'company-1',
  first_name: 'Test',
  last_name: 'Testsson',
  personnummer: STORED_CIPHERTEXT,
  personnummer_last4: '0000',
  employment_type: 'employee',
  salary_type: 'monthly',
  monthly_salary: 30000,
  f_skatt_status: 'a_skatt',
  is_sidoinkomst: false,
  tax_table_number: 34,
}

function employeeSupabase() {
  const captured: { updates: Record<string, unknown> | null } = { updates: null }

  function chainFor(state: { isUpdate: boolean }): unknown {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          const data = state.isUpdate
            ? { ...EXISTING_ROW, ...(captured.updates ?? {}) }
            : EXISTING_ROW
          return (resolve: (v: unknown) => void) => resolve({ data, error: null })
        }
        return (...args: unknown[]) => {
          if (prop === 'update') {
            state.isUpdate = true
            captured.updates = args[0] as Record<string, unknown>
          }
          return chainFor(state)
        }
      },
    }
    return new Proxy({}, handler)
  }

  return { supabase: { from: vi.fn(() => chainFor({ isUpdate: false })) }, captured }
}

describe('PATCH /api/salary/employees/[id]: personnummer cannot be wiped', () => {
  let captured: { updates: Record<string, unknown> | null }

  beforeEach(() => {
    vi.clearAllMocks()
    const mock = employeeSupabase()
    captured = mock.captured
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: mock.supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('rejects an empty-string personnummer instead of overwriting the ciphertext', async () => {
    const response = await PATCH(
      createMockRequest('/api/salary/employees/emp-1', {
        method: 'PATCH',
        body: { personnummer: '' },
      }),
      params,
    )

    expect(response.status).toBe(400)
    // No UPDATE at all: the ciphertext and personnummer_last4 both survive.
    expect(captured.updates).toBeNull()
  })

  it('rejects a null personnummer (the column is NOT NULL and AGI/KU need it)', async () => {
    const response = await PATCH(
      createMockRequest('/api/salary/employees/emp-1', {
        method: 'PATCH',
        body: { personnummer: null },
      }),
      params,
    )

    expect(response.status).toBe(400)
    expect(captured.updates).toBeNull()
  })

  it('refuses the whole PATCH rather than applying the other fields silently', async () => {
    // Failing loudly matters more than partial success: a caller that thought it
    // was clearing the personnummer must learn that it did not happen.
    const response = await PATCH(
      createMockRequest('/api/salary/employees/emp-1', {
        method: 'PATCH',
        body: { first_name: 'Ny', personnummer: '' },
      }),
      params,
    )

    expect(response.status).toBe(400)
    expect(captured.updates).toBeNull()
  })

  it('rejects a masked personnummer that reached the route past a loose schema', async () => {
    // validatePersonnummer() strips non-digits, so a decorated value carrying 12
    // real digits would sail through it. The explicit mask check is what makes
    // the refusal deterministic.
    const response = await PATCH(
      createMockRequest('/api/salary/employees/emp-1', {
        method: 'PATCH',
        body: { personnummer: '190203040000-XXXX' },
      }),
      params,
    )

    expect(response.status).toBe(400)
    expect(captured.updates).toBeNull()
  })
})
