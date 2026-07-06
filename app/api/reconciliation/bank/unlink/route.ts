import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { unlinkReconciliation } from '@/lib/reconciliation/bank-reconciliation'
import { validateBody } from '@/lib/api/validate'
import { BankUnlinkSchema } from '@/lib/api/schemas'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  const validation = await validateBody(request, BankUnlinkSchema)
  if (!validation.success) return validation.response
  const { transaction_id } = validation.data

  const result = await unlinkReconciliation(supabase, companyId, transaction_id, user.id)

  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 400 })
  }

  return NextResponse.json({ data: { success: true } })
}
