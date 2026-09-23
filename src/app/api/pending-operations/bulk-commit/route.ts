import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { PendingOperationsBulkSchema } from '@/lib/api/schemas'
import { commitPendingOperation } from '@/lib/pending-operations/commit'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { PendingOperation } from '@/types'

ensureInitialized()

interface BulkCommitItemResult {
  id: string
  status: 'committed' | 'failed' | 'skipped' | 'rejected'
  error?: string
}

// Swedish display labels for already-handled operations; the raw enum values
// are English and must not reach the user-visible per-item error strings.
const STATUS_LABELS_SV: Record<string, string> = {
  committing: 'godkänns just nu',
  committed: 'godkänd',
  rejected: 'avvisad',
  failed_partial: 'delvis genomförd',
}

export const POST = withRouteContext(
  'pending_operation.bulk_commit',
  async (request, { user, supabase, companyId, log }) => {
    const validated = await validateBody(request, PendingOperationsBulkSchema)
    if (!validated.success) return validated.response
    const { ids } = validated.data

    const { data: ops, error: fetchError } = await supabase
      .from('pending_operations')
      .select('*')
      .in('id', ids)
      .eq('company_id', companyId)

    if (fetchError) {
      log.error('failed to fetch pending operations for bulk commit', fetchError)
      return NextResponse.json(
        { error: 'Åtgärderna kunde inte hämtas. Försök igen.' },
        { status: 500 }
      )
    }

    const opsById = new Map((ops ?? []).map((op) => [op.id, op as PendingOperation]))
    const results: BulkCommitItemResult[] = []

    for (const id of ids) {
      const op = opsById.get(id)
      if (!op) {
        results.push({ id, status: 'failed', error: 'Åtgärden kunde inte hittas.' })
        continue
      }
      if (op.status !== 'pending') {
        results.push({
          id,
          status: 'skipped',
          error: `Redan hanterad (${STATUS_LABELS_SV[op.status] ?? op.status})`,
        })
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
      } else {
        // The executor's error strings mix Swedish user messages with raw
        // Supabase/Zod English: map to Swedish before they land in the
        // user-visible per-item results (issue #337). Raw stays in logs.
        log.warn('bulk commit item failed', {
          operationId: id,
          rawError: result.error,
          status: result.http_status,
        })
        const mapped = getErrorMessage(result.error ?? null, {
          statusCode: result.http_status ?? 500,
        })
        if (result.status === 'rejected' && result.auto_rejected) {
          results.push({ id, status: 'rejected', error: mapped })
        } else {
          results.push({ id, status: 'failed', error: mapped })
        }
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
