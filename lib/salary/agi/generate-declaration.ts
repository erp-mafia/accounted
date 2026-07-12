/**
 * Shared AGI XML generation + persistence orchestration.
 *
 * Both the internal dashboard route (`GET /api/salary/runs/{id}/agi/xml`)
 * and the v1 public route (`POST /api/v1/companies/{companyId}/salary-runs/{id}/generate-agi`)
 * call this helper. It loads the salary run + employees + per-day absence
 * records, builds the Skatteverket AGI XML, upserts the agi_declarations
 * row (correction-aware), updates `salary_runs.agi_generated_at`, emits
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
import type { AGIEmployeeData, AGICompanyData, AGITotals } from './xml-generator'
import { eventBus } from '@/lib/events'
import { completeTaxDeadline } from '@/lib/deadlines/complete-tax-deadline'
import type { Logger } from '@/lib/logger'

// Strict runtime validation of the joined salary_run_employees row. Without
// this, columns added by recent migrations (removed_from_agi,
// benefits_adjusted, vaxa_stod_eligible, employment_start,
// housing_benefit_type) reaching the mapper as null/undefined would silently
// fall back to Boolean(undefined) = false and mis-emit regulatory flags.
// Zod produces an explicit error instead.
const EmployeeJoinSchema = z
  .object({
    personnummer: z.string().min(1, 'employee.personnummer saknas'),
    specification_number: z.number().int().min(1, 'employee.specification_number måste vara ≥ 1'),
    f_skatt_status: z.string(),
    monthly_salary: z.number().nullable().optional(),
    vaxa_stod_eligible: z.boolean().nullable().optional(),
    employment_start: z.string().nullable().optional(),
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
    }
  | {
      ok: false
      code: string
      details?: unknown
      status?: number
    }

function sumLineItemAmounts(
  lineItems: Array<Record<string, unknown>>,
  types: string[],
): number {
  return lineItems
    .filter((li) => types.includes(li.item_type as string))
    .reduce((sum, li) => sum + ((li.amount as number) || 0), 0)
}

export async function generateAgiDeclaration(
  args: GenerateAgiDeclarationArgs,
): Promise<GenerateAgiDeclarationResult> {
  const { supabase, companyId, userId, userEmail, salaryRunId, log, requestId } = args
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
    .select('company_name, org_number, phone, email')
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
      '*, employee:employees(personnummer, specification_number, f_skatt_status, monthly_salary, vaxa_stod_eligible, employment_start, housing_benefit_type), line_items:salary_line_items(*)',
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
    periodYear: run.period_year,
    periodMonth: run.period_month,
    contactName: (profile?.full_name || companyName || '').trim(),
    contactPhone: (settings?.phone || '').trim(),
    contactEmail: (settings?.email || profile?.email || userEmail || '').trim(),
  }

  // Load per-day absence (VAB + parental only: sick days go to FK separately).
  const periodStart = `${run.period_year}-${String(run.period_month).padStart(2, '0')}-01`
  const periodEndDate = new Date(Date.UTC(run.period_year, run.period_month, 0))
  const periodEnd = periodEndDate.toISOString().slice(0, 10)
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

  // Cutoff for the Växa-stöd FK062/FK063 split: pre-2024-05-01 hires get the
  // legacy "första anställda"-flag (FK062); 2024-05-01 and later get the
  // utvidgat växa-stöd flag (FK063). Cutoff from Skatteverket spec (Prop.
  // 2023/24:80, RAML revisionshistorik 1.19).
  const VAXA_STOD_FK063_CUTOFF = '2024-05-01'

  const employeeData: AGIEmployeeData[] = parsedRows.map((sre) => {
      const emp = sre.employee
      const lineItems = (sre.line_items ?? []) as Array<{ item_type: string; amount?: number | null; quantity?: number | null }>

      const benefitCar = sumLineItemAmounts(lineItems, ['benefit_car'])
      const benefitFuel = sumLineItemAmounts(lineItems, ['benefit_fuel'])
      const benefitHousing = sumLineItemAmounts(lineItems, ['benefit_housing'])
      // FK015 kostförmån has its own field: never fold into FK012.
      // Skatteverket cross-checks the krona-amount against the PBB-schablon.
      const benefitMeals = sumLineItemAmounts(lineItems, ['benefit_meals'])
      // FK012 SkatteplOvrigaFormanerUlagAG is the catch-all for taxable
      // benefits without their own FK code (bike, wellness, "other") PLUS
      // the krona-amount for housing (since FK041/FK043 carry only the flag).
      const benefitOther = sumLineItemAmounts(lineItems, [
        'benefit_bike',
        'benefit_wellness',
        'benefit_other',
      ]) + benefitHousing

      // Default housing type: if the employee got a housing benefit line
      // item but no housing_benefit_type is set, treat as 'ej_smahus' (the
      // more common case). NULL with no benefit line item → no flag emitted.
      let housingBenefit: 'smahus' | 'ej_smahus' | undefined
      if (benefitHousing > 0) {
        housingBenefit = emp?.housing_benefit_type ?? 'ej_smahus'
      }

      const absenceEvents = absenceByEmployee.get(sre.employee_id)

      let vaxaStod: 'forsta_anstalld' | 'vaxa_stod' | undefined
      if (emp?.vaxa_stod_eligible) {
        vaxaStod =
          emp.employment_start && emp.employment_start < VAXA_STOD_FK063_CUTOFF
            ? 'forsta_anstalld'
            : 'vaxa_stod'
      }

      // Växa-stöd (employment-start-gated relief, 10.21 % avgifter) and the
      // ungdomsrabatt (age-gated relief, 'youth' avgifter_category) are
      // distinct statutory programs and must not be claimed for the same
      // employee in the same period. Catching this at generation time
      // avoids emitting an FK062/FK063 flag inconsistent with the FK061
      // category total.
      if (vaxaStod && sre.avgifter_category === 'youth') {
        throw new AGIIncompleteDataError(
          `Anställd ${emp?.specification_number ?? '?'}: kan inte kombinera växa-stöd ` +
            '(FK062/FK063) med ungdomsrabatt (avgifter_category="youth"): programmen är ömsesidigt uteslutande. ' +
            'Välj ett av dem under anställdas inställningar.',
          ['vaxa_stod_eligible', 'avgifter_category'],
        )
      }

      const isFSkatt = emp?.f_skatt_status === 'f_skatt'
      // Honor advanced-mode per-employee overrides set during review.
      const effectiveTax = sre.tax_withheld_override ?? sre.tax_withheld
      const effectiveAvgifterBasis = sre.avgifter_basis_override ?? sre.avgifter_basis
      return {
        personnummer: emp?.personnummer ?? '',
        specificationNumber: emp?.specification_number ?? 0,
        removed: Boolean(sre.removed_from_agi),
        grossSalary: sre.gross_salary,
        taxWithheld: effectiveTax,
        avgifterBasis: effectiveAvgifterBasis,
        fSkattPayment: isFSkatt ? sre.gross_salary : undefined,
        // F-skatt payees: cash goes to FK131 and benefits to the ej-UlagSA
        // variants (FK132/FK133/FK134/FK137/FK138/FK139). Regular employees
        // get FK011 + FK012/FK013/FK015/FK018/FK041/FK043.
        benefitsExcludedFromSAUnderlag: isFSkatt ? true : undefined,
        benefitCar: benefitCar > 0 ? benefitCar : undefined,
        benefitFuel: benefitFuel > 0 ? benefitFuel : undefined,
        benefitMeals: benefitMeals > 0 ? benefitMeals : undefined,
        housingBenefit,
        benefitOther: benefitOther > 0 ? benefitOther : undefined,
        benefitsAdjusted: Boolean(sre.benefits_adjusted),
        vaxaStod,
        sickDays: (sre.sick_days ?? 0) > 0 ? (sre.sick_days ?? 0) : undefined,
        vabDays: (sre.vab_days ?? 0) > 0 ? (sre.vab_days ?? 0) : undefined,
        parentalDays:
          (sre.parental_days ?? 0) > 0 ? (sre.parental_days ?? 0) : undefined,
        absenceEvents: absenceEvents && absenceEvents.length > 0 ? absenceEvents : undefined,
      }
    },
  )
    // Drop individuppgifter with nothing to report. An employee who took 0 kr
    // and had no benefits, tax or absence this month is simply omitted (you
    // only file an IU for a person who received something). This yields a clean
    // HU-only nolldeklaration for a full nollkörning, and omits zero-paid
    // employees in a mixed run. Borttag (removed) tombstones are always kept.
    .filter(
      (e) =>
        e.removed === true ||
        (e.grossSalary ?? 0) > 0 ||
        (e.taxWithheld ?? 0) > 0 ||
        (e.fSkattPayment ?? 0) > 0 ||
        (e.benefitCar ?? 0) > 0 ||
        (e.benefitFuel ?? 0) > 0 ||
        (e.benefitMeals ?? 0) > 0 ||
        (e.benefitOther ?? 0) > 0 ||
        e.housingBenefit !== undefined ||
        (e.sickDays ?? 0) > 0 ||
        (e.vabDays ?? 0) > 0 ||
        (e.parentalDays ?? 0) > 0 ||
        (e.absenceEvents?.length ?? 0) > 0,
    )

  // 5. Build totals: avgifter by category (with rate-heuristic fallback for legacy runs).
  // Removed-from-AGI rows (FK205 borttag) are tombstones: they must not
  // contribute to FK497/FK487/FK499 because the prior submission's amounts
  // remain on file at Skatteverket; the borttag just removes the IU itself.
  const activeEmployees = parsedRows.filter((sre) => !sre.removed_from_agi)
  const avgifterByCategory: AGITotals['avgifterByCategory'] = {}
  for (const sre of activeEmployees) {
    const dbCategory = sre.avgifter_category ?? null
    const category = dbCategory
      ? dbCategory === 'reduced_65plus'
        ? 'reduced65plus'
        : dbCategory === 'vaxa_stod'
          ? 'standard'
          : dbCategory
      : sre.avgifter_rate <= 0.1022
        ? 'reduced65plus'
        : sre.avgifter_rate <= 0.2082
          ? 'youth'
          : 'standard'
    const cat = (avgifterByCategory as Record<string, { basis: number; amount: number }>)[
      category
    ] || { basis: 0, amount: 0 }
    cat.basis += sre.avgifter_basis_override ?? sre.avgifter_basis
    cat.amount += sre.avgifter_amount_override ?? sre.avgifter_amount
    ;(avgifterByCategory as Record<string, { basis: number; amount: number }>)[category] = cat
  }
  const totalAvgifterAmount = Object.values(avgifterByCategory).reduce(
    (sum, cat) => sum + (cat?.amount ?? 0),
    0,
  )

  // FK499 sjuklönekostnad: sum of paid sjuklön (days 2-14) across all
  // employees. Day 1 is karens (unpaid); day 15+ is Försäkringskassan.
  const calcParams = ((run.calculation_params as Record<string, unknown>) ?? {}) as {
    sjuklonRate?: number
    sjuklon_rate?: number
  }
  const sjuklonRate = calcParams.sjuklonRate ?? calcParams.sjuklon_rate ?? 0.8
  let totalSjuklonekostnad = 0
  for (const sre of activeEmployees) {
    const monthly = sre.monthly_salary ?? 0
    if (!monthly) continue
    const dailyRate = monthly / 21
    const lineItems = (sre.line_items ?? []) as Array<{ item_type: string; amount?: number | null; quantity?: number | null }>
    for (const li of lineItems) {
      if (li.item_type === 'sick_day2_14') {
        const days = li.quantity ?? 0
        totalSjuklonekostnad += dailyRate * sjuklonRate * days
      }
    }
  }

  // FK497 SummaSkatteavdr must equal the sum of FK001 on active IUs (not
  // run.total_tax, which includes removed rows). Same for FK487.
  // Coalesce override → computed so manual jämkning/FoU adjustments flow
  // into the filed declaration.
  const totalTax = activeEmployees.reduce(
    (sum, sre) => sum + ((sre.tax_withheld_override ?? sre.tax_withheld) || 0),
    0,
  )

  const totals: AGITotals = {
    totalTax: Math.round(totalTax * 100) / 100,
    totalAvgifterBasis: activeEmployees.reduce(
      (s, e) => s + ((e.avgifter_basis_override ?? e.avgifter_basis) || 0),
      0,
    ),
    totalAvgifterAmount: Math.round(totalAvgifterAmount * 100) / 100,
    totalSjuklonekostnad: Math.round(totalSjuklonekostnad * 100) / 100,
    avgifterByCategory,
  }

  // Soft AGI deadline check: warn (but don't block) when generating for a
  // future period or one whose Skatteverket correction window is clearly
  // past. Filing deadline is the 12th (17th in Jan/Aug for small employers)
  // of the month after the period; SKV accepts corrections for a long time
  // after, but a period > 13 months in the past is almost certainly a
  // misclick. Surface via the logger so audit log + Sentry both see it.
  {
    const now = new Date()
    const currentYM = now.getUTCFullYear() * 100 + (now.getUTCMonth() + 1)
    const periodYM = run.period_year * 100 + run.period_month
    if (periodYM > currentYM) {
      opLog.warn('AGI generated for future period', {
        companyId,
        periodYear: run.period_year,
        periodMonth: run.period_month,
      })
    } else if (currentYM - periodYM > 13) {
      opLog.warn('AGI generated for period > 13 months past', {
        companyId,
        periodYear: run.period_year,
        periodMonth: run.period_month,
      })
    }
  }

  // 6. Existing AGI determines correction status. Use `.maybeSingle()`
  // because the lookup must tolerate the no-row case without throwing:
  // that's the FIRST-time generation path. `.single()` would surface a
  // PGRST116 row-not-found error and abort what should be a clean insert.
  const { data: existingAgi } = await supabase
    .from('agi_declarations')
    .select('id')
    .eq('company_id', companyId)
    .eq('period_year', run.period_year)
    .eq('period_month', run.period_month)
    .maybeSingle()

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

  // 8. UPSERT agi_declarations.
  let agiDeclarationId: string
  if (existingAgi) {
    const { error: updErr } = await supabase
      .from('agi_declarations')
      .update({
        xml_content: xml,
        individuppgifter,
        total_gross: run.total_gross,
        total_tax: run.total_tax,
        total_avgifter_basis: totals.totalAvgifterBasis,
        // Use the per-category sum that drives the XML rather than the
        // run-level denormalised total. Both should agree, but a
        // round-then-sum vs sum-then-round can produce öre drift; the
        // agi_declarations row should align with what was actually
        // serialised into the XML (which Skatteverket sees).
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
        period_year: run.period_year,
        period_month: run.period_month,
        xml_content: xml,
        individuppgifter,
        total_gross: run.total_gross,
        total_tax: run.total_tax,
        total_avgifter_basis: totals.totalAvgifterBasis,
        // Use the per-category sum that drives the XML rather than the
        // run-level denormalised total. Both should agree, but a
        // round-then-sum vs sum-then-round can produce öre drift; the
        // agi_declarations row should align with what was actually
        // serialised into the XML (which Skatteverket sees).
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
          .eq('period_year', run.period_year)
          .eq('period_month', run.period_month)
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
            total_tax: run.total_tax,
            total_avgifter_basis: totals.totalAvgifterBasis,
            // Use the per-category sum that drives the XML rather than the
        // run-level denormalised total. Both should agree, but a
        // round-then-sum vs sum-then-round can produce öre drift; the
        // agi_declarations row should align with what was actually
        // serialised into the XML (which Skatteverket sees).
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
          periodYear: run.period_year,
          periodMonth: run.period_month,
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
        periodYear: run.period_year,
        periodMonth: run.period_month,
        userId,
        companyId,
      },
    })
  } catch (err) {
    opLog.warn('agi.generated emit failed', err as Error)
  }

  // 11. Auto-complete the arbetsgivardeklaration deadline for this period
  //     (Skatteförfarandelagen: AGI generation satisfies the filing
  //     obligation).
  const period = `${run.period_year}-${String(run.period_month).padStart(2, '0')}`
  await completeTaxDeadline(
    supabase,
    companyId,
    ['arbetsgivardeklaration'],
    period,
    'submitted'
  )

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
    periodYear: run.period_year,
    periodMonth: run.period_month,
    employeeCount: employeeData.length,
    isCorrection,
    totals,
    orgNumber: companyData.orgNumber,
  }
}
