/**
 * Whether a stored AGI declaration's totals may be paid in to the
 * skattekonto from Accounted (crm#1768).
 *
 * The tax payment file, the skattekonto bank payment named from an AGI (or
 * from its due date) and the run page's tax payment panel pay or show the
 * declaration's total_tax + total_avgifter. One declaration covers every
 * payment of its month, and the generator builds it from one run, so a
 * declaration of a month in which another live run is also paid out holds
 * one run's skatt and avgifter: paid as it is, the other run's are left
 * unpaid. The generator refuses such a month (generateAgiDeclaration), but a
 * row generated before it did, or before the second run went live, keeps its
 * one-run totals. This is the generator's check (readOtherRunsPaidInPeriod)
 * on the paying side, so a declaration that could no longer be generated is
 * not paid either. Both live in the deadlines block (agi-period-runs.ts),
 * which payroll and payments may both import.
 *
 * A filed declaration (submitted, accepted) is what Skatteverket has on
 * record and what it draws from the skattekonto: never refused here.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { AGI_RECEIPT_STATUSES } from '@/lib/deadlines/agi-filed'
import { isSalaryExtraRunsEnabled } from '@/lib/env/salary-extra-runs-switch'
import { agiPeriodConflictDetails, readOtherRunsPaidInPeriod } from './agi-period-runs'

/** The agi_declarations columns the check reads. */
export interface StoredAgiDeclarationToPay {
  salary_run_id: string | null
  status: string
  /** The redovisningsperiod: the payout month. */
  period_year: number
  period_month: number
}

export interface AgiPaymentPeriodConflict {
  code: 'AGI_PAYMENT_PERIOD_CONFLICT'
  /** The generator's refusal keys (period, other_salary_run_id, other_runs, ...) and the Swedish message. */
  details: ReturnType<typeof agiPeriodConflictDetails>
  /** The message, naming the other runs: the refusal's own Swedish sentence. */
  messageSv: string
  /** The same in English, for the English UI. */
  messageEn: string
}

/** "The salary run for 2026-10 paid out 2026-11-05"; several are joined with "and". */
function describeOtherRunsEn(runs: Array<{ run_period: string; payment_date: string }>): string {
  const parts = runs.map((other) => `${other.run_period} paid out ${other.payment_date}`)
  const listed = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0]
  return `The salary ${runs.length > 1 ? 'runs' : 'run'} for ${listed}`
}

/**
 * The refusal to pay `declaration`, or null when it may be paid: it is
 * filed, or no other live run is paid out in its month. A read that fails
 * answers ok false, and the caller refuses rather than pays.
 *
 * A company with several runs in one month (SALARY_EXTRA_RUNS_COMPANY_IDS)
 * is asked about coverage even when the declaration is filed: a run that
 * joined the month after the filing is owed too, and is declared by the
 * month's rättelse, so the filed declaration alone is not what the month owes.
 */
export async function readAgiPaymentPeriodConflict(
  supabase: SupabaseClient,
  companyId: string,
  declaration: StoredAgiDeclarationToPay,
): Promise<{ ok: true; conflict: AgiPaymentPeriodConflict | null } | { ok: false; error: unknown }> {
  const severalRuns = isSalaryExtraRunsEnabled(companyId)
  if (!severalRuns && AGI_RECEIPT_STATUSES.includes(declaration.status)) return { ok: true, conflict: null }

  // The run the declaration was built from: its correction and the run it
  // corrects are the same pay, not another payment. A row whose run is gone
  // covers no live run, so any live run of the month refuses it.
  let run: { id: string; corrects_run_id: string | null } = { id: declaration.salary_run_id ?? '', corrects_run_id: null }
  if (declaration.salary_run_id) {
    const { data, error } = await supabase
      .from('salary_runs')
      .select('id, corrects_run_id')
      .eq('id', declaration.salary_run_id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (error) return { ok: false, error }
    if (data) run = data as { id: string; corrects_run_id: string | null }
  }

  const agiPeriod = { periodYear: declaration.period_year, periodMonth: declaration.period_month }
  const others = await readOtherRunsPaidInPeriod(supabase, companyId, agiPeriod, run)
  if (!others.ok) return { ok: false, error: others.error }
  if (others.runs.length === 0) return { ok: true, conflict: null }

  // Several runs in one month (SALARY_EXTRA_RUNS_COMPANY_IDS): the month's
  // declaration is summed over its runs and lists them (salary_run_ids).
  // When it lists every live run of the month, its total is what the month
  // owes. One that leaves a run out is not paid: generating the month's
  // declaration again sums them (a rättelse when it is filed).
  if (severalRuns) {
    const { data: covering, error: coverError } = await supabase
      .from('agi_declarations')
      .select('salary_run_ids')
      .eq('company_id', companyId)
      .eq('period_year', declaration.period_year)
      .eq('period_month', declaration.period_month)
      .maybeSingle()
    if (coverError) return { ok: false, error: coverError }
    const covered = (covering as { salary_run_ids?: string[] | null } | null)?.salary_run_ids ?? null
    // Exactly the month's live runs: a run it covers that left the month
    // (moved, recalled, corrected) is pay the month no longer owes.
    const live = new Set([run.id, ...others.runs.map((other) => other.id)])
    if (covered && covered.length === live.size && covered.every((id) => live.has(id))) {
      return { ok: true, conflict: null }
    }
    const details = agiPeriodConflictDetails(
      agiPeriod,
      others.runs,
      (named, period) =>
        `${named} hör också till redovisningsperiod ${period}, men arbetsgivardeklarationen som Accounted har för ` +
        `${period} räknar inte med den, så dess belopp betalas inte från Accounted. Ta fram deklarationen för ${period} ` +
        'igen från en av körningarna, så summeras alla (en rättelse om den redan är inlämnad), och betala det belopp den ger.',
    )
    const messageEn =
      `${describeOtherRunsEn(details.other_runs)} also ${details.other_runs.length > 1 ? 'belong' : 'belongs'} to reporting period ${details.period}, ` +
      `but the employer declaration Accounted holds for ${details.period} does not count it, so its amount is not paid from Accounted. ` +
      `Generate the declaration for ${details.period} again from one of the runs to sum them all (a correction if it is already filed), and pay the amount it gives.`
    return { ok: true, conflict: { code: 'AGI_PAYMENT_PERIOD_CONFLICT', details, messageSv: details.message, messageEn } }
  }

  const details = agiPeriodConflictDetails(
    agiPeriod,
    others.runs,
    (named, period) =>
      `${named} hör också till redovisningsperiod ${period}. ` +
      `Arbetsgivardeklarationen som Accounted har för ${period} räknar bara med en av körningarna, ` +
      'så dess belopp betalas inte från Accounted. ' +
      `Lämna in deklarationen för ${period} med summan av körningarna i Skatteverkets e-tjänst och betala det belopp den ger.`,
  )
  const messageEn =
    `${describeOtherRunsEn(details.other_runs)} also ${details.other_runs.length > 1 ? 'belong' : 'belongs'} to reporting period ${details.period}. ` +
    `The employer declaration Accounted holds for ${details.period} covers only one of the runs, so its amount is not paid from Accounted. ` +
    `File the declaration for ${details.period} with the sum of the runs in Skatteverket's e-service and pay the amount it gives.`
  return { ok: true, conflict: { code: 'AGI_PAYMENT_PERIOD_CONFLICT', details, messageSv: details.message, messageEn } }
}
