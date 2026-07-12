import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { unlinkReconciliation } from '@/lib/reconciliation/bank-reconciliation'
import { validateBody } from '@/lib/api/validate'
import { BankUnlinkSchema } from '@/lib/api/schemas'

export const POST = withRouteContext(
  'reconciliation.bank.unlink',
  async (request, { supabase, user, companyId }) => {
    const validation = await validateBody(request, BankUnlinkSchema)
    if (!validation.success) return validation.response
    const { transaction_id } = validation.data

    const result = await unlinkReconciliation(supabase, companyId, transaction_id, user.id)

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 })
    }

    return NextResponse.json({ data: { success: true } })
  },
  { requireWrite: true },
)
