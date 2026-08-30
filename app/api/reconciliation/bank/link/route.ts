import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { linkTransactionToVouchers, manualLink } from '@/lib/reconciliation/bank-reconciliation'
import { validateBody } from '@/lib/api/validate'
import { BankLinkSchema } from '@/lib/api/schemas'

ensureInitialized()

export const POST = withRouteContext(
  'reconciliation.bank.link',
  async (request, { supabase, user, companyId }) => {
    const validation = await validateBody(request, BankLinkSchema)
    if (!validation.success) return validation.response
    const { transaction_id, journal_entry_id, allocations, account_number } = validation.data

    // One verifikat: the plain link. Several: the 1:N split (#1553), all or
    // nothing, slices summing to the transaction.
    const result = journal_entry_id
      ? await manualLink(supabase, companyId, transaction_id, journal_entry_id, user.id, account_number ?? '1930')
      : await linkTransactionToVouchers(
          supabase,
          companyId,
          transaction_id,
          allocations ?? [],
          user.id,
          account_number ?? '1930',
        )

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 })
    }

    // A split echoes the slices as validated (defaults resolved); the plain
    // link has nothing to add.
    const resolvedAllocations = 'allocations' in result ? result.allocations : undefined
    return NextResponse.json({
      data: { success: true, ...(resolvedAllocations ? { allocations: resolvedAllocations } : {}) },
    })
  },
  { requireWrite: true },
)
