import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClient } from '@/lib/supabase/server'
import { huntCompany, resolveAllowlist } from '@/lib/receipt-hunt/hunt'

ensureInitialized()

/**
 * GET /api/receipt-hunt/cron, daily 05:30 UTC.
 *
 * Pairs unbooked card purchases that have no receipt with the unconsumed
 * underlag the company already holds, and stages each pairing for approval.
 * Runs after the 05:00 bank sync so the night's new transactions are swept the
 * same morning.
 *
 * Writes nothing to the journal: every pairing becomes an
 * `attach_document_to_transaction` pending operation, and the document only
 * reaches a verifikat later, when the user books the transaction.
 *
 * Scoped to `RECEIPT_HUNT_COMPANY_IDS` while the feature is piloted. Unset
 * means the hunt runs for nobody, so a deploy cannot silently start staging
 * proposals in every company at once.
 */
export const GET = withCronContext('cron.receipt_hunt', async (_request, ctx) => {
  const companyIds = resolveAllowlist(process.env.RECEIPT_HUNT_COMPANY_IDS)
  if (companyIds.length === 0) {
    ctx.log.info('receipt hunt skipped: no companies allowlisted')
    return NextResponse.json({
      success: true,
      skipped: true,
      reason: 'RECEIPT_HUNT_COMPANY_IDS is empty',
      total: 0,
    })
  }

  const supabase = createServiceClient()
  const runId = crypto.randomUUID()

  ctx.log.info('receipt hunt starting', { companyCount: companyIds.length, runId })

  const results: Array<{
    companyId: string
    candidates: number
    poolSize: number
    proposed: number
  }> = []

  const summary = await ctx.forEach('company', companyIds, async (companyId, itemCtx) => {
    try {
      const result = await huntCompany(supabase, companyId, runId)
      results.push({
        companyId: result.companyId,
        candidates: result.candidates,
        poolSize: result.poolSize,
        proposed: result.proposed,
      })
      if (result.skippedNoOwner) {
        itemCtx.log.warn('receipt hunt found proposals but the company has no members', {
          companyId,
        })
      }
    } catch (error) {
      itemCtx.log.error('receipt hunt failed for company', error as Error, { companyId })
      throw error
    }
  })

  const proposed = results.reduce((sum, r) => sum + r.proposed, 0)
  ctx.log.info('receipt hunt summary', {
    runId,
    total: summary.total,
    succeeded: summary.succeeded,
    failed: summary.failed,
    proposed,
  })

  return NextResponse.json({
    success: true,
    runId,
    total: summary.total,
    succeeded: summary.succeeded,
    failed: summary.failed,
    failures: summary.failures,
    proposed,
    results,
  })
})

export const POST = GET

/** Companies are hunted sequentially and each does a handful of reads. */
export const maxDuration = 300
