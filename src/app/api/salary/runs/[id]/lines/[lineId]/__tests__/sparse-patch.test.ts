/**
 * A one-field PATCH must not rewrite the fields it did not name.
 *
 * UpdateSalaryLineItemSchema is CreateSalaryLineItemSchema.partial(), and
 * .partial() does NOT strip .default(). Parsed bare, `{ amount: 5500 }` comes
 * back carrying is_taxable/is_avgift_basis/is_vacation_basis=true,
 * is_gross_deduction/is_net_deduction=false and sort_order=0, and
 * updatePayslipLine spreads the patch straight into .update(). Correcting the
 * amount on a net deduction line would have silently converted it into a
 * taxable, avgift-bearing, vacation-bearing earning: wrong skatteavdrag, wrong
 * arbetsgivaravgifter, wrong semesterlöneskuld.
 *
 * The writer is mocked here on purpose: the assertion is about the exact patch
 * object handed to it, which is the thing that reaches the UPDATE.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse, createMockRouteParams } from '@/tests/helpers'

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/salary/payslip-lines', () => ({
  updatePayslipLine: vi.fn(),
  deletePayslipLine: vi.fn(),
}))

import { PATCH } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { requireWritePermission } from '@/lib/auth/require-write'
import { updatePayslipLine } from '@/lib/salary/payslip-lines'

const params = () => createMockRouteParams({ id: 'run-1', lineId: 'line-1' })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireAuth).mockResolvedValue({
    user: { id: 'user-1', email: 'test@test.se' } as never,
    supabase: {} as never,
    error: null,
  })
  vi.mocked(requireWritePermission).mockResolvedValue({ ok: true } as never)
  vi.mocked(updatePayslipLine).mockResolvedValue({
    ok: true,
    data: { id: 'line-1' } as never,
  })
})

async function patch(body: unknown) {
  return PATCH(
    createMockRequest('/api/salary/runs/run-1/lines/line-1', { method: 'PATCH', body }),
    params(),
  )
}

/** The patch object the route handed to the writer. */
function sentPatch(): Record<string, unknown> {
  const call = vi.mocked(updatePayslipLine).mock.calls[0]
  return (call[1] as { patch: Record<string, unknown> }).patch
}

describe('PATCH /api/salary/runs/[id]/lines/[lineId] sparse patch', () => {
  it('sends ONLY the named field, not the whole default set', async () => {
    const response = await patch({ amount: 5500 })
    expect(response.status).toBe(200)
    expect(sentPatch()).toEqual({ amount: 5500 })
  })

  it('does not resurrect the taxability / avgift / vacation flags', async () => {
    await patch({ amount: 5500 })
    const sent = sentPatch()
    for (const flag of [
      'is_taxable',
      'is_avgift_basis',
      'is_vacation_basis',
      'is_gross_deduction',
      'is_net_deduction',
      'sort_order',
    ]) {
      expect(sent, `${flag} must not be written by an amount-only PATCH`).not.toHaveProperty(flag)
    }
  })

  it('still writes a default-carrying flag when the caller sets it explicitly', async () => {
    await patch({ is_net_deduction: true })
    expect(sentPatch()).toEqual({ is_net_deduction: true })
  })

  it('rejects null on a non-nullable field rather than quietly clearing it', async () => {
    // No field on CreateSalaryLineItemSchema is .nullable(), so "clear this
    // column" is not expressible on this endpoint. sparsePatchBody must keep
    // that a 400 and not translate null into a write. (The null-survives-as-a-
    // deliberate-clear path is covered where the schema allows it: see
    // lib/api/__tests__/sparse-patch.test.ts and the accounts PUT tests.)
    const response = await patch({ account_number: null })
    expect(response.status).toBe(400)
    expect(updatePayslipLine).not.toHaveBeenCalled()
  })

  it('drops unknown keys instead of forwarding them to the update', async () => {
    await patch({ amount: 100, company_id: 'other-company', id: 'other-line' })
    expect(sentPatch()).toEqual({ amount: 100 })
  })

  it('returns 400 for an empty body instead of writing an empty update', async () => {
    const response = await patch({})
    const { status, body } = await parseJsonResponse<{ error: string }>(response)
    expect(status).toBe(400)
    expect(body.error).toBe('Inget att uppdatera')
    expect(updatePayslipLine).not.toHaveBeenCalled()
  })

  it('still rejects an invalid value with a 400', async () => {
    const response = await patch({ amount: 'inte ett tal' })
    expect(response.status).toBe(400)
    expect(updatePayslipLine).not.toHaveBeenCalled()
  })
})
