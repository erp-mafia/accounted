import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { createServiceClient } from '@/lib/supabase/server'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { huntCompany } from '@/lib/receipt-hunt/hunt'

// The hunt uploads documents, and uploading emits document.uploaded, which is
// what makes the extraction extension read the amount out of a fetched PDF.
// Without this the receipts land with no amount and can never be paired.
ensureInitialized()

/**
 * A run of the hunt that a person asked for.
 *
 * The nightly cron exists but is deliberately not searching mailboxes yet: a
 * sweep of one real 172-message mailbox took over 600s, and a scheduled
 * function has 300. Pressing a button is the honest shape for that. A bounded
 * pass reports what it found and what is left, and the person decides whether
 * to press again, which a silent nightly truncation could never do.
 *
 * Writes no journal entries. Every pairing becomes an
 * `attach_document_to_transaction` proposal that still waits for approval.
 */

/** Purchases whose mailboxes are searched per press. */
const PURCHASES_PER_RUN = 8

/** Receipts fetched per press, so one press cannot bury the granskningskö. */
const RECEIPTS_PER_RUN = 10

export const maxDuration = 300

export const POST = withRouteContext('receipt_hunt.run', async (_request, ctx) => {
  const { companyId, user, log } = ctx

  // Reading a PDF is what turns a fetched attachment into something matchable,
  // and that is the paid AI tier. Without it the hunt would file documents that
  // can never pair, which is worse than not running.
  const blocked = await requireCapability(ctx.supabase, companyId, CAPABILITY.ai)
  if (blocked) return blocked

  // Service role: the hunt reads mail_connections, whose RLS has no policies
  // precisely so a browser session can never select a refresh token.
  const supabase = createServiceClient()
  const runId = crypto.randomUUID()

  log.info('manual receipt hunt starting', { companyId, runId, userId: user.id })

  const result = await huntCompany(supabase, companyId, runId, {
    searchMail: true,
    mailSearchLimit: PURCHASES_PER_RUN,
    maxReceipts: RECEIPTS_PER_RUN,
  })

  const searched = result.mail?.searched ?? 0
  log.info('manual receipt hunt finished', {
    companyId,
    runId,
    searched,
    fetched: result.mail?.ingested ?? 0,
    proposed: result.proposed,
  })

  return NextResponse.json({
    data: {
      // What the person needs to decide whether to press again.
      purchasesWithoutReceipt: result.candidates,
      searched,
      fetched: result.mail?.ingested ?? 0,
      proposed: result.proposed,
      remaining: Math.max(0, result.candidates - searched),
    },
  })
})
