/**
 * Pre-flight of the kontantmetoden year-end cut-off (#3440): run by the
 * staging tool and again by the executor, before any write.
 *
 * The cut-off writes on two kinds of dates: the carries on period_end (the
 * closed year's last VAT period) and, for an invoice paid after period end
 * before the cut-off was posted, a storno and a rättelse on the date of the
 * cash verifikat they correct. Each date must be writable, and a date inside
 * a VAT period already filed changes a filed momsdeklaration.
 *
 *   - A locked or closed date refuses with KONTANTMETOD_CUTOFF_PERIOD_LOCKED.
 *     The database triggers would refuse the write anyway; this says which
 *     date and why before a partial run starts.
 *   - A date inside a filed VAT period refuses with
 *     KONTANTMETOD_CUTOFF_VAT_PERIOD_FILED unless the approver acknowledged
 *     that period by its tax_period label. Acknowledged, the cut-off posts on
 *     the same dates (the moms belongs to that period, it is not moved), and
 *     the result lists amended_vat_periods_required: for each such period a
 *     rättad momsdeklaration has to be filed. Voluntarily and before
 *     Skatteverket finds it, the correction carries no skattetillägg.
 *   - The date of a payment verifikat the cut-off cannot correct by rule (the
 *     manual lists) is not written by the cut-off and refuses nothing, but a
 *     filed VAT period it falls in is reported in amended_vat_periods_required
 *     too: that verifikat declared the moms a second time there, and the
 *     manual correction changes a filed momsdeklaration.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { checkPeriodLock, type PeriodLockVerdict } from '@/lib/api/v1/check-period-lock'
import { listVatFilings } from '@/lib/vat/filing-record-store'
import type { KontantmetodCarryPlan, PaidBeforePosting } from '@/lib/core/bookkeeping/kontantmetod-cutoff'

export const KONTANTMETOD_CUTOFF_PERIOD_LOCKED = 'KONTANTMETOD_CUTOFF_PERIOD_LOCKED' as const
export const KONTANTMETOD_CUTOFF_VAT_PERIOD_FILED = 'KONTANTMETOD_CUTOFF_VAT_PERIOD_FILED' as const

/** A filed VAT period one of the cut-off's dates falls in. */
export interface CutoffFiledVatPeriod {
  tax_period: string
  period_start: string
  period_end: string
  filed_on: string
}

export type KontantmetodCutoffPreflight =
  | {
      ok: true
      /** Filed periods the approver acknowledged: each needs a rättad momsdeklaration. */
      amendedVatPeriodsRequired: CutoffFiledVatPeriod[]
    }
  | {
      ok: false
      code: typeof KONTANTMETOD_CUTOFF_PERIOD_LOCKED
      date: string
      reason: NonNullable<PeriodLockVerdict['reason']>
      message_sv: string
      message_en: string
    }
  | {
      ok: false
      code: typeof KONTANTMETOD_CUTOFF_VAT_PERIOD_FILED
      /** The filed periods not acknowledged. */
      filed: CutoffFiledVatPeriod[]
      message_sv: string
      message_en: string
    }

/**
 * Every date the cut-off would write on: period_end when there is anything
 * to carry, and the date of each cash verifikat it corrects (the storno and
 * the rättelse keep that date). Sorted, unique.
 */
export function kontantmetodCutoffWriteDates(
  periodEnd: string,
  plans: readonly KontantmetodCarryPlan[],
  corrections: ReadonlyArray<Pick<PaidBeforePosting, 'entryDate'>>,
): string[] {
  const dates = new Set<string>()
  if (plans.length > 0) dates.add(periodEnd)
  for (const item of corrections) dates.add(item.entryDate)
  return [...dates].sort()
}

const LOCK_REASON_SV: Record<NonNullable<PeriodLockVerdict['reason']>, string> = {
  company_lock_date_covers: 'bokföringen är låst till och med ett senare datum',
  period_locked_at_set: 'räkenskapsperioden är låst',
  period_is_closed: 'räkenskapsåret är stängt',
  no_fiscal_period: 'det saknas räkenskapsperiod',
  lookup_failed: 'låsstatusen för datumet kunde inte läsas',
}

/** Swedish list of tax periods with their filing dates: "2026-Q4 (inlämnad 2027-02-12)". */
export function describeFiledVatPeriodsSv(periods: readonly CutoffFiledVatPeriod[]): string {
  return periods.map((p) => `${p.tax_period} (inlämnad ${p.filed_on})`).join(', ')
}

/**
 * Check that every date in `dates` is writable and outside an unacknowledged
 * filed VAT period. Reads only; never writes.
 */
export async function kontantmetodCutoffPreflight(
  supabase: SupabaseClient,
  companyId: string,
  opts: {
    dates: readonly string[]
    acknowledgedFiledVatPeriods?: readonly string[]
    /**
     * Dates of payment verifikat left for manual correction. Never refused
     * and never lock-checked (the cut-off does not write there); a filed VAT
     * period covering one is added to amendedVatPeriodsRequired.
     */
    manualCorrectionDates?: readonly string[]
  },
): Promise<KontantmetodCutoffPreflight> {
  const dates = [...new Set(opts.dates)].sort()
  const manualDates = [...new Set(opts.manualCorrectionDates ?? [])].filter((d) => !!d).sort()
  if (dates.length === 0 && manualDates.length === 0) return { ok: true, amendedVatPeriodsRequired: [] }

  for (const date of dates) {
    const verdict = await checkPeriodLock(supabase, companyId, date)
    if (verdict.locked) {
      const reason = verdict.reason ?? 'period_locked_at_set'
      return {
        ok: false,
        code: KONTANTMETOD_CUTOFF_PERIOD_LOCKED,
        date,
        reason,
        // A failed lock read fails closed (checkPeriodLock answers locked) and
        // is retryable: nothing needs to be unlocked.
        message_sv:
          `Kontantmetodens bokslutsavgränsning behöver bokföra den ${date}, men ${LOCK_REASON_SV[reason]}. ` +
          (reason === 'lookup_failed'
            ? 'Försök igen om en stund.'
            : 'Flytta tillbaka låsdatumet för bokföringen eller lås upp perioden och försök igen.'),
        message_en:
          reason === 'lookup_failed'
            ? `The kontantmetoden cut-off has to book on ${date}, and its lock state could not be read. Nothing was staged; try again shortly.`
            : `The kontantmetoden cut-off has to book on ${date}, which is locked (${reason}). ` +
              'Move the company lock date back (the settings ask you to acknowledge any filed VAT period it reopens) or unlock the fiscal period, then stage the cut-off again.',
      }
    }
  }

  const filings = await listVatFilings(supabase, companyId)
  const filedCovering = (candidates: readonly string[]): CutoffFiledVatPeriod[] => {
    const hits = new Map<string, CutoffFiledVatPeriod>()
    for (const filing of filings) {
      if (!candidates.some((date) => filing.period_start <= date && date <= filing.period_end)) continue
      if (hits.has(filing.tax_period)) continue
      hits.set(filing.tax_period, {
        tax_period: filing.tax_period,
        period_start: filing.period_start,
        period_end: filing.period_end,
        filed_on: filing.filed_on,
      })
    }
    return [...hits.values()].sort((a, b) => a.period_start.localeCompare(b.period_start))
  }
  const filed = filedCovering(dates)
  const acknowledged = new Set(opts.acknowledgedFiledVatPeriods ?? [])
  const unacknowledged = filed.filter((p) => !acknowledged.has(p.tax_period))
  if (unacknowledged.length > 0) {
    const labels = unacknowledged.map((p) => p.tax_period)
    return {
      ok: false,
      code: KONTANTMETOD_CUTOFF_VAT_PERIOD_FILED,
      filed: unacknowledged,
      message_sv:
        `Kontantmetodens bokslutsavgränsning ändrar momsen i en momsperiod som redan är deklarerad: ` +
        `${describeFiledVatPeriodsSv(unacknowledged)}. Bekräfta perioden för att bokföra ändå; ` +
        'lämna sedan en rättad momsdeklaration för perioden.',
      message_en:
        `The kontantmetoden cut-off changes the moms of a VAT period already filed: ${labels.join(', ')}. ` +
        'Nothing was staged. To post it anyway, stage again with acknowledge_filed_vat_periods listing these tax periods; ' +
        'a corrected momsdeklaration must then be filed for each of them.',
    }
  }
  const amended = new Map(filed.map((p) => [p.tax_period, p]))
  for (const p of filedCovering(manualDates)) if (!amended.has(p.tax_period)) amended.set(p.tax_period, p)
  return {
    ok: true,
    amendedVatPeriodsRequired: [...amended.values()].sort((a, b) => a.period_start.localeCompare(b.period_start)),
  }
}
