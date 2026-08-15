import type { SupabaseClient } from '@supabase/supabase-js'
import { createExtensionContext } from '@/lib/extensions/context-factory'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { createLogger } from '@/lib/logger'
import { syncSkattekonto } from './skattekonto-sync'
import { SkatteverketAuthError } from './api-client'
import { markNeedsReconsent, RECONSENT_ERROR_CODES } from './token-store'
import { reconcileAgiDeclaration, type PendingAgiDeclaration } from './agi-kvittens-reconcile'

const log = createLogger('skatteverket-post-connect')

/**
 * Refresh Skatteverket-derived data right after a successful BankID consent.
 *
 * SKV's `per`-flow tokens (and their refresh tokens) live ~65 minutes, so the
 * nightly skattekonto cron and the 2-hourly kvittens cron usually find them
 * dead: right after consent is the one reliable window where a personal-token
 * fetch is guaranteed to work. The OAuth callback awaits this before
 * responding, so when the popup closes the skattekonto rows are upserted, AGI
 * tax payments are auto-settled, and stuck pending-signature declarations have
 * had their kvittens re-checked; UI listeners can refetch without racing a
 * background job.
 *
 * Best-effort by contract: every step has its own try/catch and this function
 * never throws. A refresh failure must never fail the connect that just
 * succeeded.
 */
export interface PostConnectRefreshResult {
  synced: boolean
  reconciled: number
}

/**
 * Bound the kvittens re-checks so a pathological backlog cannot stall the
 * OAuth callback: 12 covers a full year of monthly AGI periods.
 */
const MAX_KVITTENS_CHECKS = 12

export async function runPostConnectRefresh(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
): Promise<PostConnectRefreshResult> {
  const result: PostConnectRefreshResult = { synced: false, reconciled: 0 }

  try {
    if (!(await hasCapability(supabase, companyId, CAPABILITY.skatteverket))) {
      return result
    }
  } catch (err) {
    log.warn('post-connect capability check failed', {
      companyId,
      message: err instanceof Error ? err.message : String(err),
    })
    return result
  }

  const ctx = createExtensionContext(supabase, userId, companyId, 'skatteverket')

  try {
    await syncSkattekonto(ctx)
    result.synced = true
  } catch (err) {
    log.warn('post-connect skattekonto sync failed', {
      companyId,
      message: err instanceof Error ? err.message : String(err),
    })
    // A terminal auth error immediately after a fresh consent means the
    // just-granted token itself is unusable; in practice MISSING_SCOPE,
    // when the user skipped a behörighet on SKV's consent page. Persist
    // the health flag (same mechanism as the crons) so /status reports
    // needsReconsent and the connect panel can prompt with a specific
    // "godkänn alla behörigheter" message instead of a silent success.
    if (
      err instanceof SkatteverketAuthError &&
      (RECONSENT_ERROR_CODES as readonly string[]).includes(err.code)
    ) {
      await markNeedsReconsent(supabase, userId, companyId, err.code)
    }
  }

  try {
    const { data: pending, error: pendingError } = await supabase
      .from('agi_declarations')
      .select('id, company_id, salary_run_id, period_year, period_month')
      .eq('company_id', companyId)
      .eq('status', 'pending_signature')
      .order('created_at', { ascending: true })
      .limit(MAX_KVITTENS_CHECKS)

    // Supabase returns query failures as a value, not a throw: without this
    // branch a transient lookup failure would masquerade as "no pending rows".
    if (pendingError) {
      log.warn('post-connect kvittens lookup failed', {
        companyId,
        message: pendingError.message,
      })
      return result
    }

    for (const decl of (pending ?? []) as PendingAgiDeclaration[]) {
      try {
        const outcome = await reconcileAgiDeclaration(supabase, decl, {
          reconciledBy: 'post-connect',
          userId,
        })
        if (outcome.status === 'signed') {
          result.reconciled++
        } else if (outcome.status === 'error') {
          // Non-throw failures (SKV HTTP errors, claim-update failures) are
          // returned as an outcome; surface them so they stay attributable.
          log.warn('post-connect kvittens reconcile returned error', {
            companyId,
            declarationId: decl.id,
            message: outcome.error,
          })
        }
      } catch (err) {
        log.warn('post-connect kvittens reconcile failed', {
          companyId,
          declarationId: decl.id,
          message: err instanceof Error ? err.message : String(err),
        })
      }
    }
  } catch (err) {
    log.warn('post-connect kvittens lookup failed', {
      companyId,
      message: err instanceof Error ? err.message : String(err),
    })
  }

  return result
}
