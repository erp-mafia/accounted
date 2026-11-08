import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { isCompanyAdmin } from '@/lib/auth/require-write'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { sessionFailureResponse } from '@/lib/operations/session'
import { loadAttestSettingsView } from '@/lib/supplier-invoices/attest-settings'
import { removeAttestSubstitute } from '@/lib/supplier-invoices/attest-service'

const Id = z.string().uuid()

/**
 * DELETE /api/supplier-invoices/attest-policy/substitutes/:id: remove a
 * substitute (#192), ending it at once. Owners and admins remove any, the
 * attester who is away their own. Answers the settings section "Attest".
 */
export const DELETE = withRouteContext(
  'supplier_invoice.attest_substitute.delete',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { supabase, companyId, user, log, requestId } = ctx
    const id = Id.safeParse((await params).id)
    if (!id.success) return errorResponseFromCode('ATTEST_SUBSTITUTE_NOT_FOUND', log, { requestId, reason: 'substitute id is not a uuid' })
    const outcome = await removeAttestSubstitute({ supabase, companyId, userId: user.id, log }, id.data, {
      isAdmin: await isCompanyAdmin(supabase, companyId),
    })
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    return NextResponse.json({ data: await loadAttestSettingsView(supabase, companyId, user.id) })
  },
)
