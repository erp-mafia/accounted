import { NextResponse } from 'next/server'
import { loadExtensions } from '@/lib/extensions/loader'
import { extensionRegistry } from '@/lib/extensions/registry'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import {
  completeMigratedInvoiceLines,
  countRowlessInvoices,
  type CompleteInvoiceLinesResult,
} from '@/extensions/general/arcim-migration/lib/complete-invoice-lines'

/**
 * GET /api/extensions/arcim-migration/complete-invoice-lines/cron: fetch the
 * rows (and the VAT split) for migrated sales invoices that were imported
 * without them.
 *
 * The migration hydrates the provider's detail form inside a fixed budget
 * and reports the shortfall; this is what picks the shortfall up. Every run
 * walks the accepted consents whose credentials can still be used, in two
 * phases. First it sizes each register on our side: one indexed count of the
 * invoices still without rows per consent, no provider call. Then it hands
 * the registers with anything left to the pass smallest first, each within
 * its share of the run. Shortest job first: a register that fits its share
 * is finished this run whatever was accepted after it, and a register that
 * needs several runs takes what is left of each instead of pushing every
 * older company back by an hour per run (on 2026-09-05 a 1 125-invoice
 * register on the newest consent used two runs in a row while a 384-invoice
 * register three consents older, about 100 s of work, was skipped for budget
 * both times). Nothing is stored between runs: the counts are taken fresh
 * every hour, so a register the wizard or an earlier run finished simply
 * stops appearing.
 *
 * What a run does not reach is, by construction, its largest registers. They
 * are reported as deferred with their counts in the run summary and in the
 * response, so a register that is deferred hour after hour (possible only
 * while smaller registers keep arriving faster than the run clears them) is
 * visible rather than silent. Scheduled hourly in vercel.json (and the
 * Docker crontabs); a company the size of Clearstoq (1 125 invoices) is done
 * after two or three runs.
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
/** Below this the registers still in line (the largest ones) wait for the next run. */
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

/** A usable consent whose company still has invoices without rows, sized by that count. */
interface Register {
  consent: ConsentRow
  candidates: number
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
    // A stable scan order under the cap, and the tiebreak between registers
    // of equal size (the sort below is stable): the newer consent goes first.
    .order('created_at', { ascending: false })
    .limit(MAX_CONSENTS_SCANNED)

  if (error) {
    throw new Error(`provider_consents lookup failed: ${error.message}`)
  }

  const now = Date.now()
  const scanned = (data ?? []) as ConsentRow[]
  const usable = scanned.filter((consent) => consentIsUsable(consent, now))
  const deadline = now + RUN_BUDGET_MS

  // Phase 1: size every register on our side. No consent is touched here, so
  // a company with nothing left costs one count and no token refresh.
  const registers: Register[] = []
  const sizing = await ctx.forEach('consent', usable, async (consent) => {
    const candidates = await countRowlessInvoices(supabase, consent.company_id)
    if (candidates > 0) registers.push({ consent, candidates })
  })
  registers.sort((a, b) => a.candidates - b.candidates)

  if (registers.length > 0) {
    ctx.log.info('registers with row-less invoices, smallest first', {
      registers: registers.map((r) => ({
        companyId: r.consent.company_id, provider: r.consent.provider, candidates: r.candidates,
      })),
    })
  }

  // Phase 2: complete them smallest first, each within its share of the run.
  const deferred: { companyId: string; candidates: number }[] = []
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

  const completing = await ctx.forEach('register', registers, async ({ consent, candidates }, itemCtx) => {
    const budgetMs = Math.min(PER_COMPANY_BUDGET_MS, deadline - Date.now())
    if (budgetMs < MIN_COMPANY_BUDGET_MS) {
      deferred.push({ companyId: consent.company_id, candidates })
      return
    }

    const result: CompleteInvoiceLinesResult = await completeMigratedInvoiceLines({
      supabase,
      companyId: consent.company_id,
      consentId: consent.id,
      budgetMs,
    })

    // The pass re-reads our side before it touches the consent; a register
    // the wizard finished between the count and now is neither worked on nor
    // counted as a company.
    if (result.candidates === 0) return
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
  })

  if (deferred.length > 0) {
    ctx.log.warn('run deadline reached; the largest registers wait for the next run', { deferred })
  }

  const summary = {
    consents: usable.length,
    consentsStale: scanned.length - usable.length,
    consentsFailed: sizing.failed + completing.failed,
    skippedForBudget: deferred.length,
    deferred,
    ...totals,
  }
  ctx.log.info('complete-invoice-lines run finished', summary)

  return NextResponse.json({ data: summary })
})
