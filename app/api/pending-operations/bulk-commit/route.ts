import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import { validateBody } from '@/lib/api/validate'
import { PendingOperationsBulkSchema } from '@/lib/api/schemas'
import { commitPendingOperation } from '@/lib/pending-operations/commit'
import type { PendingOperation } from '@/types'

ensureInitialized()

interface BulkCommitItemResult {
  id: string
  status: 'committed' | 'failed' | 'skipped' | 'rejected'
  error?: string
}

export async function POST(request: Request) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const validated = await validateBody(request, PendingOperationsBulkSchema)
  if (!validated.success) return validated.response
  const { ids } = validated.data

  const companyId = await requireCompanyId(supabase, user.id)

  const { data: ops, error: fetchError } = await supabase
    .from('pending_operations')
    .select('*')
    .in('id', ids)
    .eq('company_id', companyId)

  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 })
  }

  const opsById = new Map((ops ?? []).map((op) => [op.id, op as PendingOperation]))
  const results: BulkCommitItemResult[] = []

  for (const id of ids) {
    const op = opsById.get(id)
    if (!op) {
      results.push({ id, status: 'failed', error: 'Operation not found' })
      continue
    }
    if (op.status !== 'pending') {
      results.push({ id, status: 'skipped', error: `Already ${op.status}` })
      continue
    }
    if (op.risk_level === 'high') {
      results.push({
        id,
        status: 'skipped',
        error: 'Hög risk — kräver individuellt godkännande',
      })
      continue
    }

    const result = await commitPendingOperation(supabase, user.id, companyId, op, {
      userEmail: user.email,
      commitMethod: 'bulk_accept',
    })
    if (result.status === 'committed') {
      results.push({ id, status: 'committed' })
    } else if (result.status === 'rejected' && result.auto_rejected) {
      results.push({ id, status: 'rejected', error: result.error ?? 'Avvisad' })
    } else {
      results.push({ id, status: 'failed', error: result.error ?? 'Misslyckades' })
    }
  }

  const summary = {
    total: results.length,
    committed: results.filter((r) => r.status === 'committed').length,
    failed: results.filter((r) => r.status === 'failed').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    rejected: results.filter((r) => r.status === 'rejected').length,
  }

  return NextResponse.json({ data: { results, summary } })
}
