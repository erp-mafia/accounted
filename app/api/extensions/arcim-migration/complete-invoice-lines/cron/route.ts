import { NextResponse } from 'next/server'
import { loadExtensions } from '@/lib/extensions/loader'
import { extensionRegistry } from '@/lib/extensions/registry'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import {
  completeMigratedInvoiceLines,
  type CompleteInvoiceLinesResult,
} from '@/extensions/general/arcim-migration/lib/complete-invoice-lines'

/**
 * GET /api/extensions/arcim-migration/complete-invoice-lines/cron: fetch the
 * rows (and the VAT split) for migrated sales invoices that were imported
 * without them.
 *
 * The migration hydrates the provider's detail form inside a fixed budget
 * and reports the shortfall; this is what picks the shortfall up. Every run
 * walks the accepted consents whose credentials can still be used, newest
 * first, and for each company completes as many of its row-less invoices as
 * its share of the run allows. A company with nothing left costs one query
 * and no provider call (the pass checks our side before it touches the
 * consent), so walking every live consent is cheap and no company waits
 * behind a fixed page of newer ones. Scheduled hourly in vercel.json (and
 * the Docker crontabs); a company the size of Clearstoq (1 125 invoices) is
 * done after two or three runs.
 *
 * "Can still be used" is read off the token row, not the consent's age:
 * Fortnox issues a new refresh token on every refresh and each one lives 45
 * days, so a pair whose access token expired more than 45 days ago has not
 * been refreshed since and its refresh token is dead. Trying such a consent
 * every hour would only log the same PROVIDER_AUTH_EXPIRED; when the company
 * reconnects through the wizard, the token row is renewed and the next run
 * finds it here. A token without an expiry (Bokio's private tokens) is
 * always eligible.
 */

export const maxDuration = 300

/** Leave the function a margin for the DB writes after the last fetch. */
const RUN_BUDGET_MS = 240_000
/** One company's share of provider detail fetches per run. */
const PER_COMPANY_BUDGET_MS = 120_000
/** Below this the remaining companies wait for the next run. */
const MIN_COMPANY_BUDGET_MS = 20_000
/**
 * A token pair not refreshed for this long cannot be refreshed any more
 * (Fortnox: refresh tokens live 45 days and rotate on every refresh).
 */
const TOKEN_STALE_DAYS = 45
/** Hard safety on the consent scan; prod holds ~120 accepted consents in total. */
const MAX_CONSENTS_SCANNED = 500

interface ConsentRow {
  id: string
  company_id: string
  provider: string | null
  created_at: string
  provider_consent_tokens: { token_expires_at: string | null } | { token_expires_at: string | null }[] | null
}

/** The consent's token row, whichever cardinality PostgREST rendered it with. */
function tokenOf(consent: ConsentRow): { token_expires_at: string | null } | null {
  const tokens = consent.provider_consent_tokens
  if (!tokens) return null
  return Array.isArray(tokens) ? (tokens[0] ?? null) : tokens
}

/** Does this consent still hold credentials a run can use? */
export function consentIsUsable(consent: ConsentRow, now: number): boolean {
  const token = tokenOf(consent)
  if (!token) return false
  if (token.token_expires_at === null) return true
  const expiredAt = Date.parse(token.token_expires_at)
  if (Number.isNaN(expiredAt)) return false
  return now - expiredAt <= TOKEN_STALE_DAYS * 24 * 60 * 60 * 1000
}

export const GET = withCronContext('cron.arcim_migration_complete_invoice_lines', async (_request, ctx) => {
  loadExtensions()

  // Physical routes under app/api/extensions/<id>/ compile into every build;
  // the registry (generated from extensions.config.json) is what switches an
  // extension on. A scheduled-but-disabled cron must fail visibly.
  if (!extensionRegistry.get('arcim-migration')) {
    ctx.log.warn('arcim-migration extension is not enabled; cron refused')
    return NextResponse.json(
      { error: 'Migration extension is not enabled', code: 'EXTENSION_DISABLED' },
      { status: 503 },
    )
  }

  const supabase = createServiceClientNoCookies()

  const { data, error } = await supabase
    .from('provider_consents')
    .select('id, company_id, provider, created_at, provider_consent_tokens(token_expires_at)')
    .eq('status', 1)
    .not('provider', 'is', null)
    .order('created_at', { ascending: false })
    .limit(MAX_CONSENTS_SCANNED)

  if (error) {
    throw new Error(`provider_consents lookup failed: ${error.message}`)
  }

  const now = Date.now()
  const scanned = (data ?? []) as ConsentRow[]
  const consents = scanned.filter((consent) => consentIsUsable(consent, now))
  const deadline = now + RUN_BUDGET_MS
  let skippedForBudget = 0
  const totals = {
    companies: 0,
    candidates: 0,
    completed: 0,
    headersUpdated: 0,
    remaining: 0,
    notHydrated: 0,
    totalMismatch: 0,
    rowsMismatch: 0,
    failed: 0,
  }

  const summary = await ctx.forEach('consent', consents, async (consent, itemCtx) => {
    const budgetMs = Math.min(PER_COMPANY_BUDGET_MS, deadline - Date.now())
    if (budgetMs < MIN_COMPANY_BUDGET_MS) {
      skippedForBudget++
      return
    }

    const result: CompleteInvoiceLinesResult = await completeMigratedInvoiceLines({
      supabase,
      companyId: consent.company_id,
      consentId: consent.id,
      budgetMs,
    })

    if (result.candidates > 0) {
      totals.companies++
      totals.candidates += result.candidates
      totals.completed += result.completed
      totals.headersUpdated += result.headersUpdated
      totals.remaining += result.remaining
      totals.notHydrated += result.notHydrated
      totals.totalMismatch += result.totalMismatch
      totals.rowsMismatch += result.rowsMismatch
      totals.failed += result.failed
      itemCtx.log.info('migrated invoice rows completed for company', {
        companyId: consent.company_id,
        provider: consent.provider,
        candidates: result.candidates,
        matched: result.matched,
        completed: result.completed,
        remaining: result.remaining,
        notHydrated: result.notHydrated,
        totalMismatch: result.totalMismatch,
        rowsMismatch: result.rowsMismatch,
        hydration: result.hydration,
      })
    }
  })

  ctx.log.info('complete-invoice-lines run finished', {
    ...totals, skippedForBudget, consents: summary.total, consentsStale: scanned.length - consents.length,
  })

  return NextResponse.json({
    data: {
      consents: summary.total,
      consentsStale: scanned.length - consents.length,
      consentsFailed: summary.failed,
      skippedForBudget,
      ...totals,
    },
  })
})
