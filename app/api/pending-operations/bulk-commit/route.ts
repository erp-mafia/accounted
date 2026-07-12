import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
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

export const POST = withRouteContext(
  'pending_operation.bulk_commit',
  async (request, { user, supabase, companyId }) => {
    const validated = await validateBody(request, PendingOperationsBulkSchema)
    if (!validated.success) return validated.response
    const { ids } = validated.data

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
          error: 'Hög risk: kräver individuellt godkännande',
        })
        continue
      }

      const result = await commitPendingOperation(supabase, user.id, companyId, op, {
        userEmail: user.email,
        commitMethod: 'bulk_accept',
        actor: { type: 'user', ...(user.email ? { label: user.email } : {}) },
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
  },
  { requireWrite: true },
)
