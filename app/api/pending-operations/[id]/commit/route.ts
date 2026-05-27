import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import { commitPendingOperation } from '@/lib/pending-operations/commit'
import { bookkeepingErrorResponse, AccountsNotInChartError, ACCOUNTS_NOT_IN_CHART } from '@/lib/bookkeeping/errors'
import type { PendingOperation } from '@/types'

ensureInitialized()

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { id } = await params

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  const { data: op, error: fetchError } = await supabase
    .from('pending_operations')
    .select('*')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (fetchError || !op) {
    return NextResponse.json({ error: 'Pending operation not found' }, { status: 404 })
  }

  try {
    const result = await commitPendingOperation(
      supabase,
      user.id,
      companyId,
      op as PendingOperation,
      { userEmail: user.email, commitMethod: 'user_accept' }
    )

    if (result.status === 'committed') {
      return NextResponse.json({ data: result.data })
    }
    // Recoverable accounts-not-in-chart: return the structured envelope (code +
    // account_numbers) so the client can offer activation and retry the still-
    // pending op, instead of leaking the raw error string into the chat.
    if (result.code === ACCOUNTS_NOT_IN_CHART && result.account_numbers?.length) {
      const structured = bookkeepingErrorResponse(
        new AccountsNotInChartError(result.account_numbers)
      )
      if (structured) return structured
    }
    return NextResponse.json(
      { error: result.error },
      { status: result.http_status ?? 500 }
    )
  } catch (err) {
    const typed = bookkeepingErrorResponse(err)
    if (typed) return typed
    throw err
  }
}
