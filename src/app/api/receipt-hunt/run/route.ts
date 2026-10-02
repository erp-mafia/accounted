import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { createServiceClient } from '@/lib/supabase/server'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { huntCompany } from '@/lib/receipt-hunt/hunt'
import { checkRateLimit, getRedis } from '@/lib/auth/rate-limit-http'

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

/**
 * Purchases whose mailboxes are searched per press.
 *
 * Purchases are searched largest first, and on a real ledger the largest rows
 * are the least likely to have a findable receipt: rent already invoiced,
 * bare payment references, direct debits. A press that only reaches the top of
 * that list finds nothing and looks broken. Measured: 8 purchases and 40 mails
 * took 43s of the 300 available, so the budget was being spent on the wrong
 * end rather than being scarce.
 */
const PURCHASES_PER_RUN = 25

/** Mails read per press. The real cost bound, and what the numbers above buy. */
const MAILS_PER_RUN = 100

/**
 * Receipts fetched per press.
 *
 * The binding constraint on the whole route, and it is the model reading the
 * PDF rather than the network: measured on a real ledger, a fetched receipt
 * costs about 50s from download to a stored amount, while searching and
 * reading a hundred mail bodies costs roughly 100s in total. Seven receipts
 * took 5.8 minutes and four took 5.1, both past the 300s a function gets.
 *
 * Three is what fits. It is also a stopgap: doing the fetch inside the request
 * is the wrong shape for work this slow, and the honest fix is to move it off
 * the request entirely rather than keep shaving this number.
 */
const RECEIPTS_PER_RUN = 3

export const maxDuration = 300

/**
 * Passes one company may run in a day. A full sweep of a busy ledger takes a
 * handful (PURCHASES_PER_RUN purchases each), and every pass may spend up to
 * RECEIPTS_PER_RUN paid AI reads, so this caps the cost of a press loop that
 * someone, or something, keeps restarting.
 */
const PASSES_PER_COMPANY_PER_DAY = 40

/**
 * One pass per company at a time. Held for the longest a pass can run, so a
 * function that dies mid-pass frees the company on its own.
 */
const LEASE_MS = (maxDuration + 15) * 1000

function leaseKey(companyId: string): string {
  return `receipt-hunt:lease:${companyId}`
}

/**
 * Claim the company's single pass slot. Without Redis (local development,
 * self-hosted installs without one) there is no shared store to claim it in,
 * and the per-pass bounds above remain the only limit, as before. A Redis
 * error does not refuse the press either: the lease guards cost, not access.
 */
async function claimPassSlot(companyId: string, runId: string): Promise<boolean> {
  const redis = getRedis()
  if (!redis) return true
  try {
    return (await redis.set(leaseKey(companyId), runId, { nx: true, px: LEASE_MS })) === 'OK'
  } catch {
    return true
  }
}

/** Free the slot, but only if this run still holds it (compare and delete). */
async function releasePassSlot(companyId: string, runId: string): Promise<void> {
  const redis = getRedis()
  if (!redis) return
  try {
    await redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      [leaseKey(companyId)],
      [runId],
    )
  } catch {
    // The lease expires on its own after LEASE_MS.
  }
}

// requireWrite: a press archives documents, files inbox items and stages
// proposals, all through the service role, so RLS cannot stop a viewer.
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

  // One pass at a time per company: the page runs passes one after another,
  // so a second pass in flight is a duplicate press, another tab, or a
  // script, and running both would double the mail reads and the AI spend.
  if (!(await claimPassSlot(companyId, runId))) {
    return NextResponse.json(
      {
        error: 'Kvittojakten letar redan i det här företaget. Vänta tills den är klar.',
        code: 'RECEIPT_HUNT_IN_PROGRESS',
      },
      { status: 409 },
    )
  }

  let result: Awaited<ReturnType<typeof huntCompany>>
  try {
    const budget = await checkRateLimit({
      prefix: 'receipt-hunt-day',
      identifier: companyId,
      maxRequests: PASSES_PER_COMPANY_PER_DAY,
      windowMs: 24 * 60 * 60 * 1000,
    })
    if (!budget.ok) return budget.response as NextResponse

    log.info('manual receipt hunt starting', { companyId, runId, userId: user.id })

    result = await huntCompany(supabase, companyId, runId, {
      searchMail: true,
      mailSearchLimit: PURCHASES_PER_RUN,
      maxMails: MAILS_PER_RUN,
      maxReceipts: RECEIPTS_PER_RUN,
    })
  } finally {
    await releasePassSlot(companyId, runId)
  }

  const searched = result.mail?.searched ?? 0
  // Only purchases the search can look for at all: salary and tax runs, the
  // largest rows on a real ledger, are never searched, so counting them as
  // "left" promised a press work it would never do.
  const searchable = result.mail?.searchable ?? 0
  const searchFailures = result.mail?.searchFailures ?? 0
  if (searchFailures > 0) {
    log.warn('manual receipt hunt: some mailboxes refused the search', {
      companyId,
      runId,
      searchFailures,
    })
  }
  log.info('manual receipt hunt finished', {
    companyId,
    runId,
    searched,
    fetched: result.mail?.ingested ?? 0,
    searchFailures,
    proposed: result.proposed,
  })

  return NextResponse.json({
    data: {
      // What the person needs to decide whether to press again.
      purchasesWithoutReceipt: result.candidates,
      searched,
      fetched: result.mail?.ingested ?? 0,
      proposed: result.proposed,
      remaining: Math.max(0, searchable - searched),
      // Non-zero means a mailbox could not be read. Zero fetched then means
      // "we could not look", not "there is nothing there", and the caller must
      // neither say the second nor treat the run as finished.
      searchFailures,
    },
  })
}, { requireWrite: true })
