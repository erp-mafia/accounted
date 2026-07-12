import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { manualLink } from '@/lib/reconciliation/bank-reconciliation'
import { validateBody } from '@/lib/api/validate'
import { BankLinkSchema } from '@/lib/api/schemas'

ensureInitialized()

export const POST = withRouteContext(
  'reconciliation.bank.link',
  async (request, { supabase, user, companyId }) => {
    const validation = await validateBody(request, BankLinkSchema)
    if (!validation.success) return validation.response
    const { transaction_id, journal_entry_id, account_number } = validation.data

    const result = await manualLink(
      supabase,
      companyId,
      transaction_id,
      journal_entry_id,
      user.id,
      account_number ?? '1930',
    )

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 })
    }

    return NextResponse.json({ data: { success: true } })
  },
  { requireWrite: true },
)
