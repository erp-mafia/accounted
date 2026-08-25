import { z } from 'zod'
import { saneIsoDateSchema } from '@/lib/invariants/zod'
import { computeFiscalPeriod } from '@/lib/company/compute-fiscal-period'
import { normalizeOrgNumber } from '@/lib/company-lookup/normalize-org-number'
import { deriveSwedishVatNumber } from '@/lib/vat/vat-number'
import type { CreateCompanyInput } from '@/lib/company/create-company'

/**
 * Typed company-setup input for the agent and API creation paths (the MCP
 * tool gnubok_create_company and POST /api/v1/companies, issue #1814 PR 3),
 * turned into the same `settings` + `fiscalPeriod` shape the web wizard
 * hands to createCompanyCore. One schema, one builder, so the two
 * programmatic paths cannot drift from each other or from the wizard.
 *
 * Compliance rules that must never be skipped: a VAT-registered company
 * needs a moms_period and an org_number (the invoice momsregistreringsnummer
 * derives from it), F-skatt is stated explicitly rather than assumed, and an
 * enskild firma stays on the calendar year even in its first year. Chief
 * among them, the moms_period: a VAT-registered company
 * needs a moms_period. Without it the deadline engine silently generates
 * ZERO VAT deadlines (lib/tax/deadline-config.ts conditions all require a
 * concrete period), which reads as "no VAT duty" to everyone downstream.
 * The schema refuses the combination instead of warning.
 */
export const CompanySetupSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    entity_type: z.enum(['enskild_firma', 'aktiebolag']),
    org_number: z.string().trim().min(1).max(20).optional(),
    vat_registered: z.boolean(),
    moms_period: z.enum(['monthly', 'quarterly', 'yearly']).nullable().optional(),
    accounting_method: z.enum(['accrual', 'cash']),
    /** Godkänd för F-skatt. Explicit on purpose: never assumed (SE-R-005 risk). */
    f_skatt: z.boolean(),
    /** 1-12. Ignored for enskild firma (always calendar year). */
    fiscal_year_start_month: z.number().int().min(1).max(12).optional(),
    /**
     * First fiscal year of a newly formed company (BFL 3 kap.): may be
     * shorter or longer than 12 months. Both dates YYYY-MM-DD.
     */
    first_fiscal_year: z
      .object({
        start: saneIsoDateSchema,
        end: saneIsoDateSchema,
      })
      .optional(),
    address_line1: z.string().trim().max(200).optional(),
    postal_code: z.string().trim().max(20).optional(),
    city: z.string().trim().max(100).optional(),
    /** Team (byrå) to attach the company to. Defaults to the caller's own team. */
    team_id: z.string().uuid().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.vat_registered && !value.moms_period) {
      ctx.addIssue({
        code: 'custom',
        path: ['moms_period'],
        message:
          'moms_period is required when vat_registered is true: without it no VAT deadlines are generated (silent misconfiguration).',
      })
    }
    if (!value.vat_registered && value.moms_period) {
      ctx.addIssue({
        code: 'custom',
        path: ['moms_period'],
        message: 'moms_period must be omitted when the company is not VAT-registered.',
      })
    }
    if (value.vat_registered && !value.org_number) {
      ctx.addIssue({
        code: 'custom',
        path: ['org_number'],
        message:
          'org_number is required for a VAT-registered company: the momsregistreringsnummer on every invoice is derived from it (ML 17 kap 24 §).',
      })
    }
    if (
      value.entity_type === 'enskild_firma' &&
      value.first_fiscal_year &&
      !value.first_fiscal_year.end.endsWith('-12-31')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['first_fiscal_year', 'end'],
        message:
          'An enskild firma always closes its fiscal year on 31 December (BFL 3 kap. 1 §): the first year may be shorter or up to 18 months, but must end on 12-31.',
      })
    }
    if (value.org_number && normalizeOrgNumber(value.org_number) === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['org_number'],
        message: 'org_number is not a valid Swedish organisationsnummer.',
      })
    }
  })

export type CompanySetup = z.infer<typeof CompanySetupSchema>

export type CompanySetupPlan =
  | {
      ok: true
      input: Omit<CreateCompanyInput, 'ticLookup'>
      /** What the fiscal period resolved to, for previews. */
      fiscalPeriod: { startDate: string; endDate: string; name: string }
    }
  | { ok: false; error: string }

/**
 * Resolve validated setup input into the creation payload. The only failure
 * left at this point is an invalid fiscal period (validatePeriodDuration).
 */
export function planCompanySetup(setup: CompanySetup): CompanySetupPlan {
  const isEf = setup.entity_type === 'enskild_firma'
  const firstYear = setup.first_fiscal_year
  const startMonth = isEf ? 1 : (setup.fiscal_year_start_month ?? 1)

  const settings: Record<string, unknown> = {
    entity_type: setup.entity_type,
    company_name: setup.name,
    org_number: setup.org_number ? normalizeOrgNumber(setup.org_number) : null,
    vat_registered: setup.vat_registered,
    vat_number: setup.vat_registered ? deriveSwedishVatNumber(setup.org_number ?? null) : null,
    moms_period: setup.vat_registered ? setup.moms_period ?? null : null,
    accounting_method: setup.accounting_method,
    f_skatt: setup.f_skatt,
    // Enskild firma is calendar-year by law, with or without a first year.
    fiscal_year_start_month: isEf ? 1 : firstYear ? nextMonthAfter(firstYear.end) : startMonth,
    ...(setup.address_line1 ? { address_line1: setup.address_line1 } : {}),
    ...(setup.postal_code ? { postal_code: setup.postal_code } : {}),
    ...(setup.city ? { city: setup.city } : {}),
    // Wizard helpers consumed by computeFiscalPeriod and stripped by
    // createCompanyCore before the settings upsert.
    is_first_fiscal_year: Boolean(firstYear),
    first_year_start: firstYear?.start,
    first_year_end: firstYear?.end,
  }

  const period = computeFiscalPeriod(settings)
  if (period.error) {
    return { ok: false, error: period.error }
  }

  return {
    ok: true,
    input: {
      entityType: setup.entity_type,
      companyName: setup.name,
      orgNumber: setup.org_number,
      settings,
      fiscalPeriod: { startDate: period.startStr, endDate: period.endStr, name: period.periodName },
    },
    fiscalPeriod: { startDate: period.startStr, endDate: period.endStr, name: period.periodName },
  }
}

/** The fiscal_year_start_month implied by a first fiscal year ending in `end`. */
function nextMonthAfter(end: string): number {
  const endMonth = Number(end.split('-')[1])
  if (!Number.isInteger(endMonth) || endMonth < 1 || endMonth > 12) return 1
  return endMonth === 12 ? 1 : endMonth + 1
}
