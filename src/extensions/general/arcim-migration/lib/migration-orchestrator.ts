/**
 * What /migrate imports from a provider's API, beside the bookkeeping data
 * (accounts, balances, vouchers), which arrives through SIE files and the core
 * SIE import engine, and the customer, supplier and invoice registers, which
 * the background job imports (migration-job-worker.ts):
 *   1. Company info → pre-fill company_settings
 *   2. Asset register (Fortnox only) → asset register rows, no journal entries
 *   3. Reconcile supplier invoices to GL payment vouchers
 *   4. Fill the Kontakter register with suggested parties
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { MigrationProgress, MigrationResults, MigrationStepError } from '../types'
import type { ProviderName } from '@/lib/providers/types'
import { classifyProviderError } from '@/lib/providers/with-provider-call'
import { fortnoxErrorMessage } from '@/lib/providers/fortnox/client'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { getProviderResourceForbiddenMessage } from '@/lib/errors/get-error-message'
import { resolveConsent } from '@/lib/providers/resolve-consent'
import { normalizeVatNumber, isValidSwedishVatNumber } from '@/lib/vat/vat-number'
import { fetchCompanyInfoDirect } from '@/lib/providers/provider-data-fetcher'
import { suggestPartiesForCompany } from '@/lib/parties/suggest'
import { createLogger } from '@/lib/logger'
import { writeCompanySettings } from '@/lib/company/settings-writer'
import type { CompanySettings } from '@/types'
import { reconcileSupplierInvoiceVouchers } from '@/lib/invoices/bulk-reconcile-supplier-vouchers'
import { importProviderAssets, FortnoxAssetScopesRequiredError } from './import-assets'
import { mapCompanyInfo } from './entity-mapper'

const log = createLogger('extensions/arcim-migration/migration-orchestrator')

export interface MigrationOptions {
  consentId: string
  companyId: string
  userId: string
  supabase: SupabaseClient
  importCompanyInfo?: boolean
  /** Import the provider's asset register (Fortnox only). Default true. */
  importAssets?: boolean
  /** Auto-link imported supplier invoices to GL payment vouchers. Default true. */
  reconcileVouchers?: boolean
  /**
   * Fill the Kontakter register from the migrated data at the end of the
   * run. Default true. The wizard drives one request per step (#2469) and
   * turns this off on all but the last, so the scan runs once per migration.
   */
  suggestParties?: boolean
  /**
   * An earlier request in this migration already received rows on this
   * grant. Seeds ProviderRunState.grantProven so an opaque 403 on the first
   * call of a later per-step request still reads as one closed register,
   * not a dead token (the same rule as within a single request). Only
   * affects how a failure is classified, never what is fetched or written.
   */
  grantProven?: boolean
  onProgress?: (progress: MigrationProgress) => void
}

function emitProgress(options: MigrationOptions, progress: MigrationProgress) {
  options.onProgress?.(progress)
}

/**
 * Codes that doom every remaining provider call in this run: dead/expired
 * grant, missing integration license, API module not activated. Continuing
 * would fail again with the same cause and then report a "successful" run
 * with nothing in it (the failure mode that sent a real config issue to the
 * bug tracker). Rethrow so /migrate answers with the structured code and the
 * wizard shows the actual remediation.
 *
 * PROVIDER_RESOURCE_FORBIDDEN is deliberately NOT here: it means the grant
 * answered other calls in this same run and only one register is closed, so
 * the remaining steps have every chance of succeeding.
 */
const FATAL_STEP_ERROR_CODES = new Set([
  'PROVIDER_AUTH_EXPIRED',
  'PROVIDER_LICENSE_MISSING',
  'PROVIDER_API_MODULE_INACTIVE',
  'BOKIO_PLAN_NO_API',
])

/**
 * What this run has learned about the grant, threaded through the steps so a
 * later failure can be read in context.
 */
interface ProviderRunState {
  /**
   * True once a provider call in this run, or an earlier request of the same
   * migration, has returned data: the access token provably works, so a 403
   * after that point is the provider closing one register, not the grant dying.
   *
   * Set it from data actually returned, never from a fetch that merely
   * resolved: a null company answer also means "no company-information
   * resource for this provider", decided before any request goes out, and a
   * step that never spoke to the provider proves nothing about the grant.
   * Reading it as proof would downgrade a genuine auth expiry on the NEXT step
   * to a non-fatal per-register denial, and the run would report success with
   * empty sections: exactly what FATAL_STEP_ERROR_CODES exists to prevent.
   */
  grantProven: boolean
}

/**
 * Record a failed step on the results so the UI can render it. Non-fatal
 * failures keep the log-and-continue behavior (one bad step must not discard
 * the others' already-persisted rows); fatal connection-level failures
 * rethrow, see FATAL_STEP_ERROR_CODES.
 */
function recordStepError(
  results: MigrationResults,
  step: MigrationStepError['step'],
  err: unknown,
  runState: ProviderRunState,
): void {
  // Company information is step 1, so grantProven is false there by
  // definition. Its 403 is still no proof of a dead grant: the fetch used to
  // swallow every error and return null, and a grant that really is dead says
  // so on the next step, which stays fatal. Letting the opening call abort the
  // run would turn a partial import into no import at all.
  const grantProven = runState.grantProven || step === 'companyInfo'
  const code = classifyProviderError(err, { grantProven })
  if (code && FATAL_STEP_ERROR_CODES.has(code)) throw err

  const rawMessage = err instanceof Error ? err.message : String(err)
  const entry = code ? getErrorEntry(code) : undefined
  let message: string
  if (code === 'PROVIDER_RESOURCE_FORBIDDEN') {
    // The registry cannot hold this copy: the useful half is the provider's
    // own sentence naming the register, which only the error carries. Fortnox
    // is the one provider that sends it (fortnoxErrorMessage caps it at 300
    // chars); the others send an opaque body and get the base message alone.
    message = getProviderResourceForbiddenMessage(fortnoxErrorMessage(err))
  } else {
    message = entry?.message_sv ?? `Leverantören svarade med ett fel: ${rawMessage}`
  }

  results.stepErrors = results.stepErrors ?? []
  results.stepErrors.push({ step, code, message })
}

// ── Main orchestrator ─────────────────────────────────────────────

export async function executeMigration(options: MigrationOptions): Promise<MigrationResults> {
  const { consentId, companyId, userId, supabase } = options
  const results: MigrationResults = {}
  // What this run has proven about the grant, read by recordStepError: a 403
  // once a call has already succeeded is one closed register, not a dead token.
  const runState: ProviderRunState = { grantProven: options.grantProven === true }

  // Resolve consent to get access token and provider
  const resolved = await resolveConsent(companyId, consentId)
  const provider = resolved.consent.provider as ProviderName
  const accessToken = resolved.accessToken
  const providerCompanyId = resolved.providerCompanyId

  try {
    // ── Step 1: Company information ───────────────────────────────
    if (options.importCompanyInfo !== false) {
      emitProgress(options, { status: 'fetching', currentStep: 'Hämtar företagsinformation...', progress: 5 })
      try {
        const companyInfo = await fetchCompanyInfoDirect(provider, accessToken, providerCompanyId)
        if (companyInfo) {
          // A DTO means the provider answered on this token. A null does not:
          // it also means "no company-information resource for this provider",
          // which is decided before any request goes out.
          runState.grantProven = true
          const mapped = mapCompanyInfo(companyInfo)
          const { data: existing } = await supabase
            .from('company_settings')
            .select('company_name, org_number, vat_number')
            .eq('company_id', companyId)
            .single()

          const updates: Partial<CompanySettings> = {}
          if (!existing?.company_name && mapped.company_name) updates.company_name = mapped.company_name
          if (!existing?.org_number && mapped.org_number) updates.org_number = mapped.org_number
          if (!existing?.vat_number && mapped.vat_number) {
            // Normalise provider input; only persist a structurally valid
            // SE+12 momsregistreringsnummer so a malformed value from an
            // external API can't enter company_settings unchecked.
            const normalizedVat = normalizeVatNumber(mapped.vat_number)
            if (isValidSwedishVatNumber(normalizedVat)) {
              updates.vat_number = normalizedVat
              updates.vat_registered = true
            } else {
              // Observability: a provider sent a VAT number we can't normalise
              // to a valid SE+12 momsregistreringsnummer. We drop it (above),
              // but surface the anomaly so consistently-bad provider data is
              // visible. Don't log the raw value: it can embed a personnummer.
              console.warn(
                `[migration] Dropped malformed VAT number from ${provider} for company ${companyId} (normalized length ${normalizedVat.length})`,
              )
            }
          }
          if (mapped.fiscal_year_start_month !== 1) {
            updates.fiscal_year_start_month = mapped.fiscal_year_start_month
          }
          if (mapped.address_line1) updates.address_line1 = mapped.address_line1
          if (mapped.postal_code) updates.postal_code = mapped.postal_code
          if (mapped.city) updates.city = mapped.city
          if (mapped.phone) updates.phone = mapped.phone
          if (mapped.email) updates.email = mapped.email

          // Any writer may run the import; the company's own settings are an
          // owner's or admin's. A fill that did not land is a step that says
          // so, never `imported: true`.
          const written =
            Object.keys(updates).length > 0
              ? await writeCompanySettings({ supabase, companyId, userId, log }, updates)
              : null
          if (written && !written.ok) {
            results.companyInfo = { imported: false }
            results.stepErrors = results.stepErrors ?? []
            results.stepErrors.push({
              step: 'companyInfo',
              code: written.code,
              message: written.messageSv ?? 'Företagsinformationen kunde inte sparas.',
            })
          } else {
            results.companyInfo = { imported: true }
          }
        }
      } catch (err) {
        console.error('Failed to import company info:', err)
        results.companyInfo = { imported: false }
        recordStepError(results, 'companyInfo', err, runState)
      }
    }

    // ── Step 2: Asset register (Fortnox only) ──────────────────────
    // Register metadata only: the bookkeeping values (12xx anskaffning and
    // ackumulerade avskrivningar) already arrived via SIE, so this step never
    // writes journal entries. A consent without the Fortnox assets scope
    // reports scopesMissing instead of failing the migration.
    if (options.importAssets !== false) {
      emitProgress(options, { status: 'importing', currentStep: 'Importerar anläggningstillgångar...', progress: 92 })
      try {
        const assets = await importProviderAssets({ supabase, companyId, userId, consentId })
        if (assets) results.assets = assets
      } catch (err) {
        if (err instanceof FortnoxAssetScopesRequiredError) {
          log.warn('asset register skipped: consent lacks the Fortnox assets scope')
          results.assets = { total: 0, imported: 0, skipped: 0, scopesMissing: true }
        } else {
          console.error('Failed to import assets:', err)
          recordStepError(results, 'assets', err, runState)
        }
      }
    }

    // ── Step 3: Reconcile supplier invoices to GL payment vouchers ────
    // The GL (incl. the Dr 2440 / Cr 1930 bank-payment vouchers) is imported
    // separately via SIE. Supplier invoices arrive (only the open ones) as open
    // payables with no link to those vouchers, so settled invoices would surface
    // as overdue. Auto-link the unambiguous matches. Best-effort: a failure here
    // must never fail the migration: the imported data is already persisted.
    if (options.reconcileVouchers !== false) {
      emitProgress(options, { status: 'importing', currentStep: 'Stämmer av betalningar mot verifikationer...', progress: 95 })
      try {
        const recon = await reconcileSupplierInvoiceVouchers({ supabase, companyId, userId })
        results.reconciliation = {
          scanned: recon.scanned,
          autoLinked: recon.autoLinked,
          ambiguous: recon.ambiguous,
          unmatched: recon.unmatched,
        }
        log.info(
          `Reconcile: ${recon.autoLinked} auto-linked, ${recon.ambiguous} need review, ${recon.unmatched} unmatched (${recon.scanned} scanned)`,
        )
      } catch (err) {
        console.error('Failed to reconcile supplier invoice payments:', err)
        recordStepError(results, 'reconciliation', err, runState)
      }
    }

    // Fill the Kontakter register from the migrated vouchers and documents
    // (non-blocking): suggested parties only, confirmed by the user later.
    if (options.suggestParties !== false) {
      try {
        const summary = await suggestPartiesForCompany(supabase, companyId, userId)
        log.info(`party suggestions: ${summary.created} new, ${summary.attached} attached, ${summary.skipped} skipped`)
      } catch (err) {
        console.error('Failed to suggest parties after migration:', err)
      }
    }

    emitProgress(options, { status: 'completed', progress: 100, results })
    return results
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Migration failed'
    emitProgress(options, { status: 'failed', progress: 0, error: message })
    throw error
  }
}
