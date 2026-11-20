import { truncateToWholeKronor } from '@/lib/money'
import {
  declaredAvgifterRowsForRun,
  reportingCategory,
  type DeclaredAvgifterHybridRow,
  type DeclaredAvgifterRunRow,
} from './declared-avgifter'

/**
 * Regionalt stöd: the särskilt avdrag from arbetsgivaravgifterna for work at
 * a fast driftställe in a stödområde (PH 208).
 *
 * Law: lagen (2001:1170) om särskilda avdrag i vissa fall vid
 * avgiftsberäkningen (stödområdeslagen), 2 § as amended from 2026-01-01
 * (prop. 2025/26:24). The avdrag is 10 % of the avgiftsunderlag for
 * avgiftspliktig ersättning for work performed in näringsverksamhet at a
 * fast driftställe in stödområdet, at most 7 100 kr per month. Ersättning on
 * which only ålderspensionsavgift is paid (2 kap. 27 § socialavgiftslagen:
 * employees 67 or older at the start of the year) is no avgiftspliktig
 * ersättning under the lag. From 2026 the avdrag is a regionalt driftstöd
 * under GBER, and 4 § excludes stål, brunkol och kol, transport och
 * tillhörande infrastruktur, and a main activity in finans och försäkring or
 * koncernintern verksamhet. The company attests that its employees work at
 * such a driftställe and that no exclusion applies, with
 * company_settings.salary_regional_support; the setting is frozen into the
 * run's calculation_params at :calculate, so the booking and the AGI of one
 * run always read the same answer.
 *
 * AGI (Skatteverket, Teknisk beskrivning 1.1.18: Bilaga Fältlista, Kontroller,
 * Summering och beräkningsregler): HU fields UlagRegionaltStod FK471 and
 * AvdragRegionaltStod FK476, both or neither (S_106, S_108); FK476 at most
 * 10 % of FK471 and at most 7 100 kr (S_109, P_032: per koncern and
 * redovisningsperiod); FK471 at most the full-rate plus youth underlag
 * (B_002). Skatteverket's computed avgift IK587 subtracts FK476 and the filed
 * FK487 must equal it (B_006), so FK487, the booked 2731 and the payment are
 * the avgift AFTER the avdrag.
 *
 * The swedish-payroll skill does not cover regionalt stöd; the rules above
 * come from Skatteverket's pages (Regionalt stöd; Så här fyller du i
 * arbetsgivardeklarationen), the Teknisk beskrivning 1.1.18 files and the
 * proposition.
 *
 * Not covered (follow-up): FK463 Annat driftstöd (other driftstöd received
 * during the year, reported only by a company that has some), a lower cap
 * for a company sharing the 7 100 kr inside a koncern, and per-employee
 * eligibility for a company with employees outside the stödområde.
 */

/** Avdrag in percent of the underlag (Skatteverket procentnyckel P_032). */
export const REGIONAL_SUPPORT_PERCENT = 10

/** Highest avdrag per redovisningsperiod, whole kronor (kontroll S_109). */
export const REGIONAL_SUPPORT_MAX_PER_PERIOD = 7100

/** The key the run's calculation_params snapshot carries the setting under. */
export const REGIONAL_SUPPORT_PARAM = 'salary_regional_support'

export interface RegionalSupport {
  /** FK471 UlagRegionaltStod, whole kronor. */
  underlag: number
  /** FK476 AvdragRegionaltStod, whole kronor, at most REGIONAL_SUPPORT_MAX_PER_PERIOD. */
  deduction: number
}

/** True when the run was calculated with regionalt stöd on (its frozen snapshot). */
export function regionalSupportEnabled(calculationParams: Record<string, unknown> | null | undefined): boolean {
  return calculationParams?.[REGIONAL_SUPPORT_PARAM] === true
}

/**
 * FK471 and FK476 for one run's rows, or null when nothing qualifies.
 *
 * A row forms underlag when it is computed by the engine at a sats above the
 * ålderspensionsavgift: full rate or the youth rate (B_002 allows exactly
 * those two underlag). Left out:
 *  - 65+-reduced rows: only ålderspensionsavgift is paid on them (2 §);
 *  - rows with no avgift (born 1937 or earlier, F-skatt at basis 0);
 *  - rows with a manual avgifter_amount_override: the operator's number is
 *    filed as is and may already carry a reduction, so claiming the avdrag
 *    on top could take it twice. Leaving them out can only under-claim.
 * Underlag is whole kronor per row (the IU declares whole kronor), the
 * avdrag 10 % of it with öretal dropped, capped per period.
 */
export function computeRegionalSupport(rows: DeclaredAvgifterHybridRow[]): RegionalSupport | null {
  let underlag = 0
  for (const row of rows) {
    if (row.overrideAmount != null) continue
    if (!(row.rate > 0)) continue
    if (reportingCategory(row) === 'reduced65plus') continue
    const rowUnderlag = truncateToWholeKronor(row.basis)
    if (rowUnderlag > 0) underlag += rowUnderlag
  }
  const deduction = Math.min(
    Math.trunc((underlag * REGIONAL_SUPPORT_PERCENT) / 100),
    REGIONAL_SUPPORT_MAX_PER_PERIOD,
  )
  return deduction > 0 ? { underlag, deduction } : null
}

/**
 * The regionalt stöd a run's AGI declares: null unless the run was
 * calculated with the setting on. Reads the rows exactly as the declared
 * avgifter do (declaredAvgifterRowsForRun).
 */
export function regionalSupportForRun(
  rows: DeclaredAvgifterRunRow[],
  calculationParams: Record<string, unknown> | null | undefined,
): RegionalSupport | null {
  if (!regionalSupportEnabled(calculationParams)) return null
  return computeRegionalSupport(declaredAvgifterRowsForRun(rows))
}
