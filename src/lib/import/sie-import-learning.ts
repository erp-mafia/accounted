import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { formatCurrency } from '@/lib/utils'
import { populateTemplatesFromSieVouchers } from '@/lib/bookkeeping/counterparty-templates'
import { suggestPartiesForCompany, type SuggestSummary } from '@/lib/parties/suggest'
import { findUntransferredResults } from '@/lib/reports/imbalance-diagnosis'
import type { UntransferredResult } from '@/types'
import { makeNotice, type ImportNotice } from './notices'
import type { SIEJob } from './sie-job-contract'
import type { AccountMapping, SIETransactionLine, SIEVoucher } from './types'

/**
 * What a completed SIE import teaches the company.
 *
 * The one-shot writer did three things after a successful import that the
 * job path, live since 2026-09-14, never took over, so every import since
 * then left them undone:
 *
 *  - the untransferred-results check: a prior year whose result was never
 *    moved to equity, which breaks every later derived opening balance. It
 *    belongs in the import's result (the result step and the migration
 *    workspace both render it), so the worker runs it before
 *    complete_sie_import_job stores that result.
 *  - counterparty templates learned from the voucher history, which the
 *    categorization suggestions read.
 *  - suggested parties in the Kontakter register.
 *
 * None of them can fail or roll back the import: every error is logged and
 * swallowed here. Templates and parties run once, after completion, in the
 * invocation that completed the job: populateTemplatesFromSieVouchers adds
 * to an existing template's occurrence count, so a second run of the same
 * import would inflate its confidence.
 */

const log = createLogger('sie-import-learning')

const sek = (amount: number) => formatCurrency(amount, 'SEK', { minimumFractionDigits: 2 })

export interface UntransferredDiagnosis {
  results: UntransferredResult[]
  /** Swedish text for the legacy warnings list, one per period. */
  warnings: string[]
  /** The structured twin of each warning. */
  notices: ImportNotice[]
}

/**
 * Untransferred prior-year results, scoped to periods before the imported
 * year: only those can leak into its opening balance, and an unscoped walk
 * repeated the same culprit under every year of a multi-year migration
 * (#2462). Checked against the ledger, not the file, so it also catches gaps
 * left by separate per-year imports.
 */
export async function diagnoseUntransferredResults(
  supabase: SupabaseClient,
  companyId: string,
  beforePeriodStart: string | null,
): Promise<UntransferredDiagnosis> {
  try {
    const results = await findUntransferredResults(
      supabase,
      companyId,
      beforePeriodStart ? { beforePeriodStart } : undefined,
    )
    return {
      results,
      warnings: results.map((culprit) =>
        `Resultatet för ${culprit.period_name} (${sek(culprit.pl_net)}) har inte förts om till eget kapital: ` +
        'senare års balansräkning visar en differens tills omföringen bokförs i det året.'),
      notices: results.map((culprit) =>
        makeNotice('sie_untransferred_result', 'action', { period: culprit.period_name, amount: sek(culprit.pl_net) })),
    }
  } catch (err) {
    log.warn('untransferred-results check failed; the import is unaffected', {
      companyId,
      message: err instanceof Error ? err.message : String(err),
    })
    return { results: [], warnings: [], notices: [] }
  }
}

/**
 * The file's vouchers on the company's accounts. A template must name the
 * account the ledger uses, not the source system's; a voucher with a line on
 * an unmapped account was skipped by the import, so it teaches nothing.
 */
export function vouchersForLearning(vouchers: SIEVoucher[], mappings: AccountMapping[]): SIEVoucher[] {
  const target = new Map(mappings.filter((m) => m.targetAccount).map((m) => [m.sourceAccount, m.targetAccount]))
  const learnable: SIEVoucher[] = []
  for (const voucher of vouchers) {
    const lines: SIETransactionLine[] = []
    for (const line of voucher.lines) {
      const account = target.get(line.account)
      if (!account) break
      lines.push({ ...line, account })
    }
    if (lines.length === voucher.lines.length) learnable.push({ ...voucher, lines })
  }
  return learnable
}

export interface SIEImportLearningSummary {
  /** Templates written, or null when the step did not run or failed. */
  templates: number | null
  parties: SuggestSummary | null
  skipped?: 'not_a_completed_import' | 'no_vouchers'
}

/** Never throws: the import is final when this runs. */
export async function learnFromCompletedSIEImport(
  supabase: SupabaseClient,
  job: Pick<SIEJob, 'id' | 'company_id' | 'user_id' | 'execution_actor_id' | 'job_state' | 'job_kind'>,
  vouchers: SIEVoucher[],
): Promise<SIEImportLearningSummary> {
  if (job.job_state !== 'completed' || (job.job_kind ?? 'import') !== 'import') {
    return { templates: null, parties: null, skipped: 'not_a_completed_import' }
  }
  if (vouchers.length === 0) return { templates: null, parties: null, skipped: 'no_vouchers' }

  let templates: number | null = null
  try {
    templates = await populateTemplatesFromSieVouchers(supabase, job.company_id, vouchers)
  } catch (err) {
    log.warn('counterparty templates were not learned from the SIE import; the import is unaffected', {
      companyId: job.company_id,
      importId: job.id,
      message: err instanceof Error ? err.message : String(err),
    })
  }

  // Suggested parties only: nothing is confirmed on the user's behalf.
  let parties: SuggestSummary | null = null
  try {
    parties = await suggestPartiesForCompany(supabase, job.company_id, job.execution_actor_id ?? job.user_id)
  } catch (err) {
    log.warn('parties were not suggested after the SIE import; the import is unaffected', {
      companyId: job.company_id,
      importId: job.id,
      message: err instanceof Error ? err.message : String(err),
    })
  }

  log.info('SIE import learning', {
    companyId: job.company_id,
    importId: job.id,
    templates,
    partiesCreated: parties?.created ?? null,
    partiesAttached: parties?.attached ?? null,
  })
  return { templates, parties }
}
