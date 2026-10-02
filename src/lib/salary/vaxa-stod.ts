/**
 * Växa-stöd under Lag (2025:1334) om återbetalning av vissa avgifter till
 * växa-företag, in force 2026-01-01 for ersättning paid after 2025-12-31.
 *
 * Until 2025 växa-stöd was a reduced avgiftssats (10,21 % on pay up to the
 * monthly cap) claimed in the arbetsgivardeklaration with FK062
 * ForstaAnstalld / FK063 VaxaStod. From redovisningsperiod 202601 it is a
 * refund: the AGI declares the full arbetsgivaravgifter, the two fields have
 * no valid period after 202512 (Skatteverket, Teknisk beskrivning 1.1.18.2),
 * and the employer applies to Skatteverket per calendar month, after that
 * month's AGI is filed and no later than one year after the month. The
 * approved amount is credited to the skattekonto
 * (swedish-payroll references/social-charges.md).
 *
 * Payroll rates start in 2026 (salary_payroll_config has no earlier year), so
 * every run the product can calculate falls under the refund model. The engine
 * therefore never reduces the avgifter for an eligible employee and never
 * flags one in the AGI; it only notes the refund the company can apply for.
 */

/** First payment date under the refund model. */
export const VAXA_STOD_REFUND_FROM = '2026-01-01'

/** First AGI redovisningsperiod (YYYYMM) in which FK062/FK063 no longer exist. */
export const VAXA_STOD_AGI_FIELDS_RETIRED_FROM = 202601

/**
 * Employments started on or after this date have the configured monthly cap
 * (salary_payroll_config.avgifter_vaxa_stod_cap, 35 000 kr). Earlier ones
 * have 25 000 kr (social-charges.md), which the config does not carry.
 */
export const VAXA_STOD_CONFIGURED_CAP_FROM = '2024-05-01'

/**
 * Växa-stöd covers at most 24 consecutive calendar months per employee
 * (swedish-payroll social-charges.md), counted from the month the window
 * starts in.
 */
export const VAXA_STOD_MAX_MONTHS = 24

/**
 * Label of the engine's refund note. It is an instruction to the employer, so
 * the employee's lönespecifikation leaves the step out (build-payslip-data.ts).
 */
export const VAXA_STOD_REFUND_STEP_LABEL = 'Växa-stöd: ansök om återbetalning hos Skatteverket'

export interface VaxaStodWindow {
  eligible: boolean
  start: string | null
  /** Optional: an open window runs until the stöd months are used up (VAXA_STOD_MAX_MONTHS). */
  end: string | null
}

/**
 * Last day of the VAXA_STOD_MAX_MONTHS-th calendar month counted from the
 * start month (start 2026-01-15 gives 2027-12-31). Null for a start date that
 * is not YYYY-MM-DD.
 */
export function vaxaStodLastDay(start: string): string | null {
  const match = /^(\d{4})-(\d{2})-\d{2}/.exec(start)
  if (!match) return null
  const lastMonthIndex = Number(match[1]) * 12 + (Number(match[2]) - 1) + VAXA_STOD_MAX_MONTHS - 1
  const year = Math.floor(lastMonthIndex / 12)
  const month = (lastMonthIndex % 12) + 1
  // Day 0 of the following month is the last day of this one.
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * Whether a payment on this date is one the company can apply for a växa-stöd
 * refund on. Same window the reduced sats used to key on, with the end date
 * optional as the employee API documents it. The window never runs past
 * VAXA_STOD_MAX_MONTHS, whether the end date is missing or set later than
 * that.
 */
export function isVaxaStodRefundMonth(vaxaWindow: VaxaStodWindow, paymentDate: string): boolean {
  if (!vaxaWindow.eligible || !vaxaWindow.start) return false
  if (paymentDate < VAXA_STOD_REFUND_FROM) return false
  const lastDay = vaxaStodLastDay(vaxaWindow.start)
  if (lastDay === null) return false
  const end = vaxaWindow.end !== null && vaxaWindow.end < lastDay ? vaxaWindow.end : lastDay
  return paymentDate >= vaxaWindow.start && paymentDate <= end
}

/**
 * Run-level reminder naming every employee whose payment falls in a
 * växa-stöd month: the AGI now carries the avgifter without växa-stöd, and
 * the refund only reaches the company when someone applies for it. Null when
 * no employee has such a month. The engine's per-payment amount caps each
 * payment on its own, so the warning says the cap is per calendar month.
 */
export function vaxaStodRefundWarning(employeeNames: string[]): string | null {
  if (employeeNames.length === 0) return null
  return (
    `Växa-stöd dras inte av i arbetsgivardeklarationen: avgifterna för ${employeeNames.join(', ')} redovisas utan växa-stöd. ` +
    'Ansök om återbetalning hos Skatteverket när månadens arbetsgivardeklaration är lämnad, senast ett år efter kalendermånaden. ' +
    'Förväntat belopp står i beräkningsdetaljerna där det kan beräknas. ' +
    'Taket gäller per kalendermånad: har någon fått flera utbetalningar samma månad, räkna taket på summan av dem.'
  )
}
