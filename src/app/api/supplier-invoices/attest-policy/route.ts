import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { AttestPolicyInput } from '@/lib/operations/supplier-invoice-attest'
import { sessionFailureResponse } from '@/lib/operations/session'
import { loadAttestSettingsView } from '@/lib/supplier-invoices/attest-settings'
import { saveAttestPolicy } from '@/lib/supplier-invoices/attest-service'

/**
 * GET /api/supplier-invoices/attest-policy: the settings section "Attest":
 * the policy, the members who can be picked as attesters, whether the
 * signed-in user may edit it, and their own switch for the attest mail.
 */
export const GET = withRouteContext('supplier_invoice.attest_policy.read', async (_request, { supabase, companyId, user }) => {
  return NextResponse.json({ data: await loadAttestSettingsView(supabase, companyId, user.id) })
})

/**
 * PUT /api/supplier-invoices/attest-policy: save the policy. Owners and
 * admins: the RLS policy on company_attest_policies is user_is_company_admin,
 * so the route gates with requireAdmin (a member would pass requireWrite and
 * then match zero rows). The rules are lib/supplier-invoices/attest-service.ts.
 */
export const PUT = withRouteContext(
  'supplier_invoice.attest_policy.update',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const validation = await validateBody(request, AttestPolicyInput)
    if (!validation.success) return validation.response
    const outcome = await saveAttestPolicy({ supabase, companyId, userId: user.id, log }, validation.data)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    return NextResponse.json({ data: await loadAttestSettingsView(supabase, companyId, user.id) })
  },
  { requireAdmin: true },
)
