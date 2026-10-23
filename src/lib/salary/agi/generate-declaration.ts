/**
 * Shared AGI XML generation + persistence orchestration.
 *
 * Both the internal dashboard route (`GET /api/salary/runs/{id}/agi/xml`)
 * and the v1 public route (`POST /api/v1/companies/{companyId}/salary-runs/{id}/generate-agi`)
 * call this helper. It loads the salary run + employees + per-day absence
 * records, builds the Skatteverket AGI XML, upserts the agi_declarations
 * row (correction-aware: a correction run taking over the period's row
 * resets its filing state), updates `salary_runs.agi_generated_at`, emits
 * `agi.generated`, and auto-completes the `arbetsgivardeklaration` deadline
 * for the period.
 *
 * Returns a discriminated result so callers can wrap it in their own
 * response envelope (internal uses raw `Response`; v1 uses the JSON `ok`
 * envelope with `xml` embedded as a string field).
 *
 * Per agi-filing.md:
 *   - FK570 (specifikationsnummer) MUST stay consistent per employee
 *   - Corrections resubmit with same FK570: a different number = a new record
 *   - XML is räkenskapsinformation; stored for 7-year retention per BFL 7 kap
 *   - Filing deadline: the 12th of the following month (17th in Jan/Aug for
 *     companies ≤ 40 MSEK turnover)
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import {
  generateAGIXml,
  buildIndividuppgifterSnapshot,
  AGIIncompleteDataError,
  AGIPayloadTooLargeError,
} from './xml-generator'
import type { AGIEmployeeData, AGICompanyData, AGITotals, AGIUnderlag } from './xml-generator'
import { agiReportingPeriod, formatAgiPeriodDashed } from './reporting-period'
import { runDeviationWindow } from '../deviation-period'
import { VAXA_STOD_AGI_FIELDS_RETIRED_FROM } from '../vaxa-stod'
import {
  resolveTaxableBenefits,
  staleBenefitTotalRefusal,
  type BenefitItemType,
  type TaxableBenefits,
} from '../benefit-payments'
import { eventBus } from '@/lib/events'
import { truncateToWholeKronor } from '@/lib/money'
import { declaredAvgifterForRun, isFSkattStatus } from '../declared-avgifter'
import type { Logger } from '@/lib/logger'

// Strict runtime validation of the joined salary_run_employees row. Without
// this, columns added by recent migrations (removed_from_agi,
// benefits_adjusted, housing_benefit_type) reaching the mapper as
// null/undefined would silently fall back to Boolean(undefined) = false and
// mis-emit regulatory flags.
// Zod produces an explicit error instead.
const EmployeeJoinSchema = z
  .object({
    personnummer: z.string().min(1, 'employee.personnummer saknas'),
    specification_number: z.number().int().min(1, 'employee.specification_number måste vara ≥ 1'),
    f_skatt_status: z.string(),
    monthly_salary: z.number().nullable().optional(),
    housing_benefit_type: z.enum(['smahus', 'ej_smahus']).nullable().optional(),
  })
  .passthrough()

const LineItemSchema = z
  .object({
    item_type: z.string(),
    amount: z.number().nullable().optional(),
    quantity: z.number().nullable().optional(),
  })
  .passthrough()

const SalaryRunEmployeeRowSchema = z
  .object({
    employee_id: z.string().uuid(),
    // Per-run snapshot of the monthly salary (authoritative for this run; the
    // engine reads it, not the employee master). Used for the FK499
    // sjuklönekostnad daily-rate below.
    monthly_salary: z.number().nullable().optional(),
    gross_salary: z.number(),
    // The taxable förmånsvärde the calculation stored. Optional for parsing
    // only: the roster query selects every column, so real rows carry it.
    benefit_values: z.number().nullable().optional(),
    tax_withheld: z.number(),
    tax_withheld_override: z.number().nullable().optional(),
    avgifter_basis: z.number(),
    avgifter_basis_override: z.number().nullable().optional(),
    avgifter_amount: z.number(),
    avgifter_amount_override: z.number().nullable().optional(),
    avgifter_rate: z.number(),
    avgifter_category: z.string().nullable().optional(),
    removed_from_agi: z.boolean().nullable().optional(),
    benefits_adjusted: z.boolean().nullable().optional(),
    sick_days: z.number().nullable().optional(),
    vab_days: z.number().nullable().optional(),
    parental_days: z.number().nullable().optional(),
    employee: EmployeeJoinSchema.nullable(),
    line_items: z.array(LineItemSchema).nullable().optional(),
  })
  .passthrough()

type SalaryRunEmployeeRow = z.infer<typeof SalaryRunEmployeeRowSchema>

const ELIGIBLE_STATUSES = ['review', 'approved', 'paid', 'booked', 'corrected'] as const

export interface GenerateAgiDeclarationArgs {
  supabase: SupabaseClient
  companyId: string
  userId: string
  /** Falls back into AGI contactEmail when company_settings + profile both have none. */
  userEmail: string | null
  salaryRunId: string
  log: Logger
  requestId: string
  /**
   * Submit-time regeneration (refreshAgiUnderlag in the Skatteverket
   * extension). When the run's stored declaration already says exactly what
   * this generation says (same XML apart from its Skapad timestamp, same
   * stored totals), nothing is written and the stored XML comes back with
   * `unchanged: true`: a submit that changes nothing must not restamp
   * agi_generated_at, which would mark an open signing draft as stale, or
   * emit agi.generated again.
   */
  writeOnlyIfChanged?: boolean
}

export type GenerateAgiDeclarationResult =
  | {
      ok: true
      xml: string
      agiDeclarationId: string
      periodYear: number
      periodMonth: number
      employeeCount: number
      isCorrection: boolean
      totals: AGITotals
      orgNumber: string
      /** writeOnlyIfChanged only: the stored declaration already matched, nothing was written. */
      unchanged?: boolean
    }
  | {
      ok: false
      code: string
      details?: unknown
      status?: number
    }

/** Placeholder for a row whose benefit fields are never emitted (a tombstoned IU). */
const NO_BENEFITS: TaxableBenefits = {
  grossByType: {},
  taxableByType: {},
  grossTotal: 0,
  paid: 0,
  reduction: 0,
  reducedType: null,
  taxableTotal: 0,
}

function sumLineItemAmounts(
  lineItems: Array<Record<string, unknown>>,
  types: string[],
): number {
  return lineItems
    .filter((li) => types.includes(li.item_type as string))
    .reduce((sum, li) => sum + ((li.amount as number) || 0), 0)
}

// Invariant: F-skatt compensation never contributes to the avgifter
// aggregates (per-IU basis, FK061-series categories, FK487, HU totals),
// overrides included. The calculation engine already stores
// avgifter_basis/avgifter_amount = 0 for these rows; a manual advanced-mode
// override must not resurrect them, or the filing would claim social charges
// on pay whose IU simultaneously declares it in FK125 (underlag for the
// recipient's egenavgifter, not the payer's arbetsgivaravgifter).
function isFSkattRow(sre: SalaryRunEmployeeRow): boolean {
  return isFSkattStatus(sre.employee?.f_skatt_status)
}

/**
 * A reviewer's avgiftsunderlag override of 0 kr (avancerat läge) on a
 * payslip that is not an F-skatt payee's: the pay is no underlag for
 * socialavgifter, so the IU declares it in the ej-underlag fields (FK131
 * cash, FK132-FK134 benefits). The common case is ersättning to a person
 * that stays under 1 000 kr in the year (SAL 2 kap. 14 §; Teknisk
 * beskrivning 1.1.18.2 avsnitt 5.4), crm#1372: the override used to reach
 * the booking only, while the IU still declared the pay in FK011/FK012 and
 * Skatteverket charged avgifter on it. A partial override (above 0) has no
 * field it could be declared in: the save refuses it, and a row stored
 * before that is refused here (hasPartialAvgiftUnderlag, #91).
 */
function declaresNoAvgiftUnderlag(sre: SalaryRunEmployeeRow): boolean {
  return !isFSkattRow(sre) && sre.avgifter_basis_override === 0
}

/**
 * An avgiftsunderlag override above 0 on a payslip that is not an F-skatt
 * payee's (#91). The IU can only leave pay out of the underlag through a
 * field that says why (FK131 for pay that is no underlag for socialavgifter,
 * FK019 for utgifter i arbetet by beslut or schablon; Bilaga Fältlista
 * 1.1.18.1), and a bare number says neither, so the IU would declare the
 * full pay in FK011 while the booking and FK487 carry the reduced one.
 * F-skatt rows ignore every avgifter override (isFSkattRow invariant).
 */
function hasPartialAvgiftUnderlag(sre: SalaryRunEmployeeRow): boolean {
  return (
    !isFSkattRow(sre) &&
    sre.avgifter_basis_override != null &&
    sre.avgifter_basis_override !== 0
  )
}

/**
 * The XML without its Avsandare/Skapad stamp, the one element two generations
 * from the same data always disagree on.
 */
function agiXmlWithoutCreatedStamp(xml: string): string {
  return xml.replace(/<gem:Skapad>[^<]*<\/gem:Skapad>/, '')
}

/** The stored row the writeOnlyIfChanged comparison reads. */
interface StoredAgiDeclaration {
  id: string
  salary_run_id: string | null
  xml_content?: string | null
  total_gross?: number | string | null
  total_tax?: number | string | null
  total_avgifter_basis?: number | string | null
  total_avgifter?: number | string | null
  employee_count?: number | null
}

/** True when the stored row holds exactly what this generation would write. */
function storedDeclarationMatches(
  stored: StoredAgiDeclaration,
  fresh: { xml: string; totals: AGITotals; employeeCount: number; totalGross: unknown },
): boolean {
  return (
    typeof stored.xml_content === 'string' &&
    agiXmlWithoutCreatedStamp(stored.xml_content) === agiXmlWithoutCreatedStamp(fresh.xml) &&
    Number(stored.total_tax) === fresh.totals.totalTax &&
    Number(stored.total_avgifter) === fresh.totals.totalAvgifterAmount &&
    Number(stored.total_avgifter_basis) === fresh.totals.totalAvgifterBasis &&
    Number(stored.employee_count) === fresh.employeeCount &&
    Number(stored.total_gross) === Number(fresh.totalGross)
  )
}

export async function generateAgiDeclaration(
  args: GenerateAgiDeclarationArgs,
): Promise<GenerateAgiDeclarationResult> {
  const { supabase, companyId, userId, userEmail, salaryRunId, log, requestId, writeOnlyIfChanged } = args
  const opLog = log.child({ salaryRunId })

  // 1. Run + status precheck.
  const { data: run, error: runError } = await supabase
    .from('salary_runs')
    .select('*')
    .eq('id', salaryRunId)
    .eq('company_id', companyId)
    .single()

  if (runError || !run) {
    return { ok: false, code: 'SALARY_RUN_NOT_FOUND' }
  }
  if (!ELIGIBLE_STATUSES.includes((run.status as typeof ELIGIBLE_STATUSES[number]))) {
    return {
      ok: false,
      code: 'AGI_GENERATE_NOT_BOOKABLE',
      details: { current_status: run.status, eligible_statuses: ELIGIBLE_STATUSES },
    }
  }

  // The redovisningsperiod is the PAYOUT month (kontantprincipen), which for
  // lön i efterskott is the month after run.period_*; see reporting-period.ts.
  const agiPeriod = agiReportingPeriod(run)

  // 2. Company + settings + profile (for contact info).
  const { data: company } = await supabase
    .from('companies')
    .select('name, org_number')
    .eq('id', companyId)
    .single()

  if (!company) {
    return { ok: false, code: 'COMPANY_NOT_FOUND' }
  }

  const { data: settings } = await supabase
    .from('company_settings')
    .select('company_name, org_number, phone, email, tax_contact_name, tax_contact_phone, tax_contact_email')
    .eq('company_id', companyId)
    .single()

  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, email')
    .eq('id', userId)
    .single()

  // 3. Roster + line items + per-day absence.
  const { data: runEmployees } = await supabase
    .from('salary_run_employees')
    .select(
      '*, employee:employees(personnummer, specification_number, f_skatt_status, monthly_salary, housing_benefit_type), line_items:salary_line_items(*)',
    )
    .eq('salary_run_id', salaryRunId)

  // An empty roster is valid: a registered employer must file a
  // nolldeklaration (HU-only, no individuppgifter) for months without payroll.
  // Only a genuine query failure (null) is treated as an error here.
  if (!runEmployees) {
    return { ok: false, code: 'SALARY_RUN_NO_EMPLOYEES' }
  }

  // 4. Build AGI input shapes.
  // Employer name on the arbetsgivardeklaration follows the current company
  // name (company_settings.company_name), not the frozen onboarding companies.name.
  const companyName = settings?.company_name || company.name
  const companyData: AGICompanyData = {
    orgNumber: (settings?.org_number || company.org_number || '').trim(),
    companyName,
    periodYear: agiPeriod.periodYear,
    periodMonth: agiPeriod.periodMonth,
    // The AGI kontaktperson is the company's tax contact when one is set
    // (company_settings.tax_contact_*, the same contact the periodisk
    // sammanställning files with); each field falls back on its own to the
    // company contact details and then the signed-in user.
    contactName: (settings?.tax_contact_name?.trim() || profile?.full_name || companyName || '').trim(),
    contactPhone: (settings?.tax_contact_phone?.trim() || settings?.phone || '').trim(),
    contactEmail: (settings?.tax_contact_email?.trim() || settings?.email || profile?.email || userEmail || '').trim(),
  }

  // Load per-day absence (VAB + parental only: sick days go to FK separately).
  // Read from the run's avvikelseperiod, the same window the calculation
  // deducted from, so the frånvarouppgifter match the payslip: a company on
  // "föregående månads avvikelser" reports August's VAB on the September run.
  const { start: periodStart, end: periodEnd } = runDeviationWindow(run)
  const employeeIds = (runEmployees as Array<{ employee_id: string }>)
    .map((sre) => sre.employee_id)
    .filter(Boolean)

  const absenceByEmployee = new Map<
    string,
    Array<{
      date: string
      type: 'vab' | 'parental'
      hours: number
      specifikationsnummer: number
    }>
  >()
  if (employeeIds.length > 0) {
    const { data: absenceRows } = await supabase
      .from('salary_absence_days')
      .select('employee_id, absence_date, absence_type, hours, franvaro_specifikationsnummer')
      .eq('company_id', companyId)
      .in('absence_type', ['vab', 'parental'])
      .gte('absence_date', periodStart)
      .lte('absence_date', periodEnd)
      .in('employee_id', employeeIds)
    for (const row of (absenceRows ?? []) as Array<{
      employee_id: string
      absence_date: string
      absence_type: 'vab' | 'parental'
      hours: number
      franvaro_specifikationsnummer: number | null
    }>) {
      // Row should always have a number for vab/parental (trigger assigns
      // on insert + backfill migration covers existing data). Defensive
      // fallback: skip rows missing the number rather than emit a bogus 0,
      // which would collide with Skatteverket's unique key.
      if (row.franvaro_specifikationsnummer == null) continue
      const list = absenceByEmployee.get(row.employee_id) ?? []
      list.push({
        date: row.absence_date,
        type: row.absence_type,
        hours: Number(row.hours ?? 8),
        specifikationsnummer: row.franvaro_specifikationsnummer,
      })
      absenceByEmployee.set(row.employee_id, list)
    }
  }

  // Validate the joined rows up-front so a malformed Supabase response
  // (missing column, wrong type, null specification_number, …) surfaces as
  // a clean AGIIncompleteDataError instead of silently emitting wrong
  // flags later. See SalaryRunEmployeeRowSchema definition above.
  const parsedRows: SalaryRunEmployeeRow[] = (runEmployees as unknown[]).map((raw, idx) => {
    const parsed = SalaryRunEmployeeRowSchema.safeParse(raw)
    if (!parsed.success) {
      const fields = parsed.error.issues.map((iss) => iss.path.join('.')).join(', ')
      throw new AGIIncompleteDataError(
        `salary_run_employees rad ${idx} har ogiltig form (saknar/felaktiga fält: ${fields}). ` +
          'Detta blockerar AGI-generering eftersom Skatteverket annars skulle få bogus värden ' +
          '(till exempel emitterade flaggor eller specifikationsnummer = 0).',
        ['salary_run_employees'],
      )
    }
    return parsed.data
  })

  // The förmånsvärde Skatteverket gets is the value AFTER what the employee
  // paid for the benefit, the same value the engine taxed
  // (lib/salary/benefit-payments.ts). Resolved per payslip up front and
  // refused with a structured result: a throw from the row mapping below is
  // outside the try around generateAGIXml and would surface as a 500. This is
  // NOT benefits_adjusted/FK048: that is Skatteverket's own justering
  // decision, a different thing.
  const rowBenefits: TaxableBenefits[] = []
  for (const sre of parsedRows) {
    // A removed employee is an FK205 tombstone: the XML emits identity fields
    // only and skips every amount and benefit field, and the totals already
    // leave the row out. Nothing on it can be inconsistent, so its rows are
    // never a reason to refuse: that would block the very correction that
    // removes the employee. The placeholder keeps the index aligned.
    if (sre.removed_from_agi) {
      rowBenefits.push(NO_BENEFITS)
      continue
    }
    const who = `Anställd ${sre.employee?.specification_number ?? '?'}`
    // A row calculated at the old reduced växa-stöd sats would be declared
    // under standard at 10,21 %: an under-declaration from 202601, when the
    // IU must carry the full avgifter (Lag 2025:1334). The engine no longer
    // writes such rows; one stored before that is refused, not filed.
    if (
      sre.avgifter_category === 'vaxa_stod' &&
      agiPeriod.periodYear * 100 + agiPeriod.periodMonth >= VAXA_STOD_AGI_FIELDS_RETIRED_FROM
    ) {
      return {
        ok: false,
        code: 'AGI_INCOMPLETE_DATA',
        details: {
          missing_fields: ['avgifter_category'],
          message:
            `${who}: arbetsgivaravgifterna är beräknade med växa-stödets nedsatta sats, som inte gäller från ` +
            'redovisningsperiod 2026-01 (Lag 2025:1334). Räkna om lönekörningen så att fulla avgifter redovisas, ' +
            'och ansök om växa-stöd hos Skatteverket i efterhand.',
        },
      }
    }
    const resolution = resolveTaxableBenefits(
      (sre.line_items ?? []).map((li) => ({ itemType: li.item_type, amount: li.amount ?? 0 })),
    )
    if (!resolution.ok) {
      return {
        ok: false,
        code: 'AGI_INCOMPLETE_DATA',
        details: { missing_fields: ['line_items'], message: `${who}: ${resolution.error}` },
      }
    }
    // A payslip calculated before the reduction existed would declare a
    // benefit that disagrees with its own stored tax and underlag. Same rule
    // as the KU route, one helper (staleBenefitTotalRefusal).
    const stale = staleBenefitTotalRefusal({
      who,
      periodYear: run.period_year as number,
      periodMonth: run.period_month as number,
      document: 'arbetsgivardeklarationen',
      storedBenefitValues: sre.benefit_values,
      benefits: resolution.benefits,
    })
    if (stale) {
      return {
        ok: false,
        code: 'AGI_INCOMPLETE_DATA',
        details: { missing_fields: ['benefit_values'], message: stale },
      }
    }
    // An underlag of 0 with an avgift above 0 contradicts itself: the IU
    // declares the pay as no underlag (Skatteverket charges nothing on it)
    // while the booking and FK487 would carry the avgift. The override
    // route refuses to save that pair; a row stored some other way is
    // refused here rather than filed.
    if (
      declaresNoAvgiftUnderlag(sre) &&
      (sre.avgifter_amount_override ?? sre.avgifter_amount) !== 0
    ) {
      return {
        ok: false,
        code: 'AGI_INCOMPLETE_DATA',
        details: {
          missing_fields: ['avgifter_amount_override'],
          message:
            `${who}: avgiftsunderlaget är justerat till 0 kr men arbetsgivaravgiften inte. ` +
            'Ett underlag på 0 kr redovisas som ersättning som inte är underlag för socialavgifter (ruta 131-134), ' +
            'så sätt även arbetsgivaravgiften till 0 kr i avancerat läge, eller rensa justeringen.',
        },
      }
    }
    // A partial underlag cannot be declared (hasPartialAvgiftUnderlag): the
    // save refuses it since #91, and a row stored before that is refused
    // here rather than filed with an IU that contradicts the booking.
    if (hasPartialAvgiftUnderlag(sre)) {
      return {
        ok: false,
        code: 'AGI_INCOMPLETE_DATA',
        details: {
          missing_fields: ['avgifter_basis_override'],
          message:
            `${who}: avgiftsunderlaget är justerat till ett delvis belopp, som inte går att redovisa i arbetsgivardeklarationen. ` +
            'Rensa justeringen i avancerat läge, eller markera att ersättningen inte är underlag för arbetsgivaravgifter.',
        },
      }
    }
    rowBenefits.push(resolution.benefits)
  }

  const employeeData: AGIEmployeeData[] = parsedRows.map((sre, rowIdx) => {
      const emp = sre.employee
      const lineItems = (sre.line_items ?? []) as Array<{ item_type: string; amount?: number | null; quantity?: number | null }>

      // Without a reduction every sum below is the historical one, byte for byte.
      const { reduction, taxableByType } = rowBenefits[rowIdx]
      const reduced = (type: BenefitItemType, historical: number): number =>
        reduction > 0 && taxableByType[type] !== undefined ? (taxableByType[type] as number) : historical

      // A benefit is declared when the payslip HAS it (its förmånsvärde as
      // entered is above 0), at the value after the employee's payment: a
      // benefit paid in full by nettolöneavdrag is still reported, as 0
      // (Teknisk beskrivning 1.1.18.2 avsnitt 5.3; Skatteverket's guidance
      // for rutor 012 and 013: "Om värdet blir noll (0) efter avdrag ska du
      // fylla i en nolla (0)").
      const grossCar = sumLineItemAmounts(lineItems, ['benefit_car'])
      const grossHousing = sumLineItemAmounts(lineItems, ['benefit_housing'])
      const benefitCar = reduced('benefit_car', grossCar)
      const benefitFuel = sumLineItemAmounts(lineItems, ['benefit_fuel'])
      const benefitHousing = reduced('benefit_housing', grossHousing)
      // FK012 SkatteplOvrigaFormanerUlagAG carries every taxable benefit
      // except bil and drivmedel: kost, bike, wellness, "other" PLUS the
      // krona-amount for housing (FK041/FK043 carry only the flag).
      // Kostförmån has no field of its own in Skatteverket's schema (#81).
      const FK012_TYPES = ['benefit_meals', 'benefit_bike', 'benefit_wellness', 'benefit_other'] as const
      const grossFk012Types = sumLineItemAmounts(lineItems, [...FK012_TYPES])
      const grossOther = grossFk012Types + grossHousing
      const benefitOther =
        (reduction > 0
          ? FK012_TYPES.reduce((sum, type) => sum + (taxableByType[type] ?? 0), 0)
          : grossFk012Types) + benefitHousing

      // Default housing type: if the employee got a housing benefit line
      // item but no housing_benefit_type is set, treat as 'ej_smahus' (the
      // more common case). NULL with no benefit line item → no flag emitted.
      // A housing benefit paid in full keeps its flag next to FK012 = 0
      // (kontroll S_155 wants FK012 whenever FK041/FK043 is there).
      let housingBenefit: 'smahus' | 'ej_smahus' | undefined
      if (grossHousing > 0) {
        housingBenefit = emp?.housing_benefit_type ?? 'ej_smahus'
      }

      // FK050 / FK051 flag the TAX-FREE part only: the *_taxfree rows, which
      // the line commands cap at the year's schablon. A *_taxable row is the
      // excess (or a payment that does not qualify) and is already pay in
      // gross_salary, so it sets no flag (Fältlista 1.1.18.1 FK050, FK051).
      const mileageAllowancePaid = sumLineItemAmounts(lineItems, ['mileage_taxfree']) > 0
      const traktamentePaid = sumLineItemAmounts(lineItems, ['traktamente_taxfree']) > 0

      const absenceEvents = absenceByEmployee.get(sre.employee_id)

      const isFSkatt = isFSkattRow(sre)
      // Honor advanced-mode per-employee overrides set during review.
      // F-skatt rows ignore avgifter overrides (see isFSkattRow invariant).
      const effectiveTax = sre.tax_withheld_override ?? sre.tax_withheld
      const effectiveAvgifterBasis = isFSkatt
        ? 0
        : sre.avgifter_basis_override ?? sre.avgifter_basis
      // F-skatt payees: inkomst av tjänst for a mottagare med F-skatt is
      // underlag for egenavgifter, so cash goes to FK125 ONLY and benefits
      // to FK126/FK127/FK128/FK123/FK124 (Fältlista 1.1.18.1 FK125; SAL
      // 2 kap. 5 §, 3 kap. 8 §; #82: it used to go to FK131/FK132, which
      // left it out of the recipient's egenavgifter). Payslips declared
      // with no avgiftsunderlag get FK131 + FK132/FK133/FK134/FK137/FK138.
      // Regular employees get FK011 + FK012/FK013/FK018/FK041/FK043.
      const underlag: AGIUnderlag = isFSkatt
        ? 'egenavgifter'
        : declaresNoAvgiftUnderlag(sre)
          ? 'ej_socialavgifter'
          : 'arbetsgivaravgifter'
      return {
        personnummer: emp?.personnummer ?? '',
        specificationNumber: emp?.specification_number ?? 0,
        removed: Boolean(sre.removed_from_agi),
        grossSalary: sre.gross_salary,
        taxWithheld: effectiveTax,
        avgifterBasis: effectiveAvgifterBasis,
        underlag,
        benefitCar: grossCar > 0 ? benefitCar : undefined,
        benefitFuel: benefitFuel > 0 ? benefitFuel : undefined,
        housingBenefit,
        benefitOther: grossOther > 0 ? benefitOther : undefined,
        benefitsAdjusted: Boolean(sre.benefits_adjusted),
        mileageAllowancePaid,
        traktamentePaid,
        sickDays: (sre.sick_days ?? 0) > 0 ? (sre.sick_days ?? 0) : undefined,
        vabDays: (sre.vab_days ?? 0) > 0 ? (sre.vab_days ?? 0) : undefined,
        parentalDays:
          (sre.parental_days ?? 0) > 0 ? (sre.parental_days ?? 0) : undefined,
        absenceEvents: absenceEvents && absenceEvents.length > 0 ? absenceEvents : undefined,
      }
    },
  )
    // Drop individuppgifter with nothing to report. An employee who took 0 kr
    // and had no benefits, tax-free allowance, tax or absence this month is
    // simply omitted (you only file an IU for a person who received
    // something; a tax-free traktamente alone is reported, as FK051). This yields a clean
    // HU-only nolldeklaration for a full nollkörning, and omits zero-paid
    // employees in a mixed run. Borttag (removed) tombstones are always kept.
    .filter(
      (e) =>
        e.removed === true ||
        (e.grossSalary ?? 0) > 0 ||
        (e.taxWithheld ?? 0) > 0 ||
        e.benefitCar !== undefined ||
        (e.benefitFuel ?? 0) > 0 ||
        e.benefitOther !== undefined ||
        e.housingBenefit !== undefined ||
        e.mileageAllowancePaid === true ||
        e.traktamentePaid === true ||
        (e.sickDays ?? 0) > 0 ||
        (e.vabDays ?? 0) > 0 ||
        (e.parentalDays ?? 0) > 0 ||
        (e.absenceEvents?.length ?? 0) > 0,
    )

  // 5. Build totals: whole-krona declared avgifter (öretal bortfaller, SFF
  // 2011:1261 22 kap. 1 §). Skatteverket does not use the filed FK487 for
  // the beslut: it recomputes the avgift from the declared per-IU underlag,
  // per sats on the whole-krona sums (IK587, kontroll B_006), and draws that
  // amount from the skattekonto. computeDeclaredAvgifter mirrors the
  // computation, and the category map folds from the same cells so the
  // breakdown always cross-foots exactly against the total.
  // Removed-from-AGI rows (FK205 borttag) are tombstones: they must not
  // contribute to FK497/FK487/FK499 because the prior submission's amounts
  // remain on file at Skatteverket; the borttag just removes the IU itself.
  const activeEmployees = parsedRows.filter((sre) => !sre.removed_from_agi)

  // One computation for every roster shape (declaredAvgifterForRun, over
  // computeDeclaredAvgifterWithOverrides). It drops the borttag tombstones
  // and zeroes F-skatt rows (overrides included) itself. Rows WITHOUT an
  // avgifter_amount_override run Skatteverket's underlag computation on the
  // FILED basis (a partial basis override is refused above, #91: it cannot
  // reach the IU fields, and letting it steer FK487 or the payment would
  // file an FK487 contradicting the declaration's own IUs). A basis
  // override of 0 does reach the IU (declaresNoAvgiftUnderlag) and always
  // comes with an amount override of 0, refused above otherwise. Rows WITH an amount
  // override (FoU-avdrag and other manual adjustments) contribute their
  // manual amounts per category instead: a manual adjustment on one employee
  // must not cost the colleagues their SKV-exact declared amounts. The
  // salary booking's split runs the same computation, so booked 2731 ==
  // filed FK487 == stored == paid, and the run page and the
  // Lönesammanställning show the declared figure through this same call
  // (crm#1149).
  const declared = declaredAvgifterForRun(
    parsedRows,
    (run.calculation_params as Record<string, unknown> | null) ?? null,
  )
  const avgifterByCategory = declared.byCategory as AGITotals['avgifterByCategory']
  const totalAvgifterAmount = declared.totalAmount
  const totalAvgifterBasis = declared.totalUnderlag

  // FK497 SummaSkatteavdr must equal the sum of FK001 on active IUs (not
  // run.total_tax, which includes removed rows). Same for FK487.
  // Coalesce override → computed so manual jämkning/FoU adjustments flow
  // into the filed declaration.
  //
  // AGI amounts are whole kronor (öretal bortfaller, SFF 2011:1261
  // 22 kap. 1 §). Each IU serialises FK001 truncated, so the HU total must
  // be the sum of the per-IU truncated values: truncating the öre-exact sum
  // instead could land 1 kr above what the IUs actually declare.
  const totalTax = activeEmployees.reduce(
    (sum, sre) =>
      sum + truncateToWholeKronor((sre.tax_withheld_override ?? sre.tax_withheld) || 0),
    0,
  )

  const totals: AGITotals = {
    totalTax,
    totalAvgifterBasis,
    totalAvgifterAmount,
    avgifterByCategory,
  }

  // Soft AGI deadline check: warn (but don't block) when generating for a
  // future period or one whose Skatteverket correction window is clearly
  // past. Filing deadline is the 12th (17th in Jan/Aug for small employers)
  // of the month after the period; SKV accepts corrections for a long time
  // after, but a period > 13 months in the past is almost certainly a
  // misclick. Surface via the logger so it lands in the audit log. These are
  // warn-level and carry no alert flag, so they do not reach the observability
  // sink (lib/observability); they are a breadcrumb, not a page.
  {
    const now = new Date()
    const currentYM = now.getUTCFullYear() * 100 + (now.getUTCMonth() + 1)
    const periodYM = agiPeriod.periodYear * 100 + agiPeriod.periodMonth
    if (periodYM > currentYM) {
      opLog.warn('AGI generated for future period', {
        companyId,
        periodYear: agiPeriod.periodYear,
        periodMonth: agiPeriod.periodMonth,
      })
    } else if (currentYM - periodYM > 13) {
      opLog.warn('AGI generated for period > 13 months past', {
        companyId,
        periodYear: agiPeriod.periodYear,
        periodMonth: agiPeriod.periodMonth,
      })
    }
  }

  // 6. Existing AGI determines correction status. Use `.maybeSingle()`
  // because the lookup must tolerate the no-row case without throwing:
  // that's the FIRST-time generation path. `.single()` would surface a
  // PGRST116 row-not-found error and abort what should be a clean insert.
  // The stored XML and totals are read too, for writeOnlyIfChanged to compare
  // below (one literal select, so the column guard can check it).
  const { data: existingAgi } = (await supabase
    .from('agi_declarations')
    .select('id, salary_run_id, xml_content, total_gross, total_tax, total_avgifter_basis, total_avgifter, employee_count')
    .eq('company_id', companyId)
    .eq('period_year', agiPeriod.periodYear)
    .eq('period_month', agiPeriod.periodMonth)
    .maybeSingle()) as { data: StoredAgiDeclaration | null }

  // Two runs may share a redovisningsperiod only when one corrects the
  // other (a correction replaces the month's declaration wholesale). Any
  // other run paid out in the same calendar month would have to be MERGED
  // into one declaration, which this generator cannot do: overwriting the
  // existing XML would file the wrong amounts, so refuse instead. Reachable
  // now that the period follows payment_date (#2191): an August run paid
  // 25 Sept and a September run paid 30 Sept both land in 202609.
  if (
    existingAgi?.salary_run_id &&
    existingAgi.salary_run_id !== run.id &&
    existingAgi.salary_run_id !== run.corrects_run_id
  ) {
    const { data: otherRun } = await supabase
      .from('salary_runs')
      .select('id, status, period_year, period_month')
      .eq('id', existingAgi.salary_run_id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (otherRun && otherRun.status !== 'corrected') {
      return {
        ok: false,
        code: 'AGI_PERIOD_CONFLICT',
        details: {
          period: formatAgiPeriodDashed(agiPeriod),
          other_salary_run_id: otherRun.id,
          other_run_period: `${otherRun.period_year}-${String(otherRun.period_month).padStart(2, '0')}`,
        },
      }
    }
  }

  const isCorrection = !!existingAgi

  // 7. Generate XML.
  let xml: string
  try {
    xml = generateAGIXml(companyData, employeeData, totals, isCorrection)
  } catch (err) {
    if (err instanceof AGIIncompleteDataError) {
      return {
        ok: false,
        code: 'AGI_INCOMPLETE_DATA',
        details: { missing_fields: err.missingFields, message: err.message },
      }
    }
    if (err instanceof AGIPayloadTooLargeError) {
      return {
        ok: false,
        code: 'AGI_PAYLOAD_TOO_LARGE',
        details: {
          message: err.message,
          size_bytes: err.sizeBytes,
          limit_bytes: err.limitBytes,
        },
        status: 413,
      }
    }
    throw err
  }
  const individuppgifter = buildIndividuppgifterSnapshot(employeeData)

  // 7b. Submit-time regeneration: the run's own stored declaration already
  // says this, so leave it (and agi_generated_at) exactly as it is.
  if (
    writeOnlyIfChanged &&
    existingAgi &&
    existingAgi.salary_run_id === run.id &&
    storedDeclarationMatches(existingAgi, {
      xml,
      totals,
      employeeCount: employeeData.length,
      totalGross: run.total_gross,
    })
  ) {
    return {
      ok: true,
      xml: existingAgi.xml_content as string,
      agiDeclarationId: existingAgi.id,
      periodYear: agiPeriod.periodYear,
      periodMonth: agiPeriod.periodMonth,
      employeeCount: employeeData.length,
      isCorrection,
      totals,
      orgNumber: companyData.orgNumber,
      unchanged: true,
    }
  }

  // 8. UPSERT agi_declarations.
  let agiDeclarationId: string
  if (existingAgi) {
    // The period's one row now takes another run's declaration: the run this
    // one corrects (or a corrected one before it). That declaration's filing
    // state does not carry over: this XML has not been sent, so the row
    // starts unfiled, and the submit flips it to pending_signature and the
    // kvittens reconciliation promotes it on the correction's OWN kvittens.
    // Keeping 'submitted' left the correction unpromotable and showed the
    // original's receipt as the period's. The original's receipt is not lost:
    // agi_kvittenser keeps every kvittens and its run keeps agi_submitted_at.
    const takesOverAnotherRun = existingAgi.salary_run_id !== run.id
    const { error: updErr } = takesOverAnotherRun
      ? await supabase
          .from('agi_declarations')
          .update({
            xml_content: xml,
            individuppgifter,
            total_gross: run.total_gross,
            // Declared whole-krona totals: see the update below.
            total_tax: totals.totalTax,
            total_avgifter_basis: totals.totalAvgifterBasis,
            total_avgifter: totals.totalAvgifterAmount,
            employee_count: employeeData.length,
            is_correction: true,
            salary_run_id: run.id,
            status: 'generated',
            kvittensnummer: null,
            submitted_at: null,
            submitted_by: null,
            response_data: null,
          })
          .eq('id', existingAgi.id)
      : await supabase
          .from('agi_declarations')
          .update({
            xml_content: xml,
            individuppgifter,
            total_gross: run.total_gross,
            // Declared whole-krona totals, exactly as serialised into the XML
            // (FK497/FK487): the amounts Skatteverket computes from the declared
            // underlag and draws from the skattekonto (modulo the two documented
            // krona-scale approximations in declared-avgifter.ts). This is what
            // agi-tax-settlement matches the draw against. run.total_tax would
            // drift: it keeps öre and includes removed rows.
            total_tax: totals.totalTax,
            total_avgifter_basis: totals.totalAvgifterBasis,
            total_avgifter: totals.totalAvgifterAmount,
            employee_count: employeeData.length,
            is_correction: true,
            salary_run_id: run.id,
          })
          .eq('id', existingAgi.id)
    if (updErr) {
      return { ok: false, code: 'DATABASE_ERROR', details: updErr }
    }
    agiDeclarationId = existingAgi.id as string
  } else {
    const { data: inserted, error: insErr } = await supabase
      .from('agi_declarations')
      .insert({
        company_id: companyId,
        user_id: userId,
        salary_run_id: run.id,
        period_year: agiPeriod.periodYear,
        period_month: agiPeriod.periodMonth,
        xml_content: xml,
        individuppgifter,
        total_gross: run.total_gross,
        // Declared whole-krona totals: see the update branch above.
        total_tax: totals.totalTax,
        total_avgifter_basis: totals.totalAvgifterBasis,
        total_avgifter: totals.totalAvgifterAmount,
        employee_count: employeeData.length,
      })
      .select('id')
      .single()

    if (insErr) {
      // Concurrent-call race: two :generate-agi requests for the same
      // (company, period) reached the INSERT branch simultaneously. The
      // earlier read of `existingAgi` returned null for both, but the
      // first INSERT wins and the second hits the unique constraint.
      // Postgres error 23505 is the unique-violation code; recover by
      // re-fetching the now-existing row and treating this call as a
      // correction (the second caller's XML supersedes the first).
      if ((insErr as { code?: string }).code === '23505') {
        const { data: nowExisting, error: refetchErr } = await supabase
          .from('agi_declarations')
          .select('id')
          .eq('company_id', companyId)
          .eq('period_year', agiPeriod.periodYear)
          .eq('period_month', agiPeriod.periodMonth)
          .maybeSingle()
        if (refetchErr || !nowExisting) {
          return { ok: false, code: 'DATABASE_ERROR', details: refetchErr || insErr }
        }
        const { error: raceUpdErr } = await supabase
          .from('agi_declarations')
          .update({
            xml_content: xml,
            individuppgifter,
            total_gross: run.total_gross,
            // Declared whole-krona totals: see the update branch above.
            total_tax: totals.totalTax,
            total_avgifter_basis: totals.totalAvgifterBasis,
            total_avgifter: totals.totalAvgifterAmount,
            employee_count: employeeData.length,
            is_correction: true,
            salary_run_id: run.id,
          })
          .eq('id', nowExisting.id)
        if (raceUpdErr) {
          return { ok: false, code: 'DATABASE_ERROR', details: raceUpdErr }
        }
        agiDeclarationId = nowExisting.id as string
        opLog.warn('agi_declarations insert raced; recovered via update', {
          companyId,
          periodYear: agiPeriod.periodYear,
          periodMonth: agiPeriod.periodMonth,
        })
        // Note: the caller-facing `isCorrection` flag (set above based on
        // the pre-INSERT existingAgi lookup) reports `false` even though
        // the database state is now technically a correction. Edge case
        // limited to the race window; the agi_declarations row is
        // correctly marked is_correction=true and the next call will
        // see it.
      } else {
        return { ok: false, code: 'DATABASE_ERROR', details: insErr }
      }
    } else if (!inserted) {
      return { ok: false, code: 'DATABASE_ERROR', details: insErr }
    } else {
      agiDeclarationId = inserted.id as string
    }
  }

  // 9. Stamp generation timestamp on salary_runs.
  await supabase
    .from('salary_runs')
    .update({ agi_generated_at: new Date().toISOString() })
    .eq('id', salaryRunId)

  // 10. Emit agi.generated (best-effort: never block the success path).
  try {
    await eventBus.emit({
      type: 'agi.generated',
      payload: {
        agiId: agiDeclarationId,
        periodYear: agiPeriod.periodYear,
        periodMonth: agiPeriod.periodMonth,
        userId,
        companyId,
      },
    })
  } catch (err) {
    opLog.warn('agi.generated emit failed', err as Error)
  }

  // NOTE: generating the XML deliberately does NOT complete the
  // arbetsgivardeklaration deadline. SFL 26 kap. deems the obligation
  // satisfied only when the declaration has come in to Skatteverket; the
  // Skatteverket extension confirms the deadline on kvittens receipt
  // (agi-kvittens-reconcile), and manual filers tick it off themselves.
  // Completing here made a generated-but-never-filed AGI silently sail
  // past its statutory date.

  opLog.info('AGI declaration generated', {
    requestId,
    salaryRunId,
    agiDeclarationId,
    isCorrection,
    employeeCount: employeeData.length,
  })

  return {
    ok: true,
    xml,
    agiDeclarationId,
    periodYear: agiPeriod.periodYear,
    periodMonth: agiPeriod.periodMonth,
    employeeCount: employeeData.length,
    isCorrection,
    totals,
    orgNumber: companyData.orgNumber,
  }
}
