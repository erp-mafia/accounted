import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { isCompanyAdmin } from '@/lib/auth/require-write'
import { AttestSubstituteInput } from '@/lib/operations/supplier-invoice-attest'
import { sessionFailureResponse } from '@/lib/operations/session'
import { loadAttestSettingsView } from '@/lib/supplier-invoices/attest-settings'
import { addAttestSubstitute } from '@/lib/supplier-invoices/attest-service'

/**
 * POST /api/supplier-invoices/attest-policy/substitutes: name a substitute
 * for an attester for a period (#192). Owners and admins for anyone, anyone
 * else for themselves: the service checks it, and the RLS policies of
 * company_attest_substitutes hold the session to the same. Answers the
 * settings section "Attest" as it reads after the change.
 */
export const POST = withRouteContext('supplier_invoice.attest_substitute.create', async (request, { supabase, companyId, user, log, requestId }) => {
  const validation = await validateBody(request, AttestSubstituteInput)
  if (!validation.success) return validation.response
  const outcome = await addAttestSubstitute({ supabase, companyId, userId: user.id, log }, validation.data, {
    isAdmin: await isCompanyAdmin(supabase, companyId),
  })
  if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  return NextResponse.json({ data: await loadAttestSettingsView(supabase, companyId, user.id) })
})
