/**
 * Static configuration of all Swedish tax deadlines (Skatteverket)
 * Based on Skatteverket's official deadline schedule
 */

import type { TaxDeadlineType, EntityType, MomsPeriod, TaxFilingMethod } from '@/types'

// Condition function type for determining if a deadline applies
export type DeadlineCondition = (settings: CompanySettingsForDeadlines) => boolean

// Subset of company settings needed for deadline generation
export interface CompanySettingsForDeadlines {
  entity_type: EntityType
  moms_period: MomsPeriod | null
  f_skatt: boolean
  preliminary_tax_monthly: number | null
  vat_registered: boolean
  pays_salaries: boolean
  // null = never attested; the generator falls back to pays_salaries so
  // rows saved before the registration flag existed keep their deadlines.
  employer_registered: boolean | null
  employer_seasonal: boolean
  fiscal_year_start_month: number // 1-12
  vat_taxable_base_over_40m: boolean
  vat_has_eu_trade: boolean
  vat_filing_method: TaxFilingMethod
  periodisk_sammanstallning_enabled: boolean
  periodisk_sammanstallning_period: 'monthly' | 'quarterly'
  periodisk_sammanstallning_filing_method: TaxFilingMethod
}

// Configuration for a single tax deadline type
export interface TaxDeadlineConfig {
  type: TaxDeadlineType
  titleTemplate: string
  description: string
  condition: DeadlineCondition
  priority: 'critical' | 'important' | 'normal'
  // Function to generate all instances for a year
  generateDates: (year: number, settings: CompanySettingsForDeadlines) => DeadlineInstance[]
  // Link to report type for navigation
  linkedReportType: string | null
}

// A specific instance of a deadline
export interface DeadlineInstance {
  day: number      // Day of month
  month: number    // 0-indexed month
  year: number
  period: string   // e.g., "2025-Q1", "2025-01", "2025"
  periodLabel: string // Human-readable, e.g., "Q1 2025", "januari 2025"
}

function getFiscalYearLabel(fiscalYearEndMonth: number, fiscalYearEndYear: number): string {
  return fiscalYearEndMonth === 12
    ? `${fiscalYearEndYear}`
    : `${fiscalYearEndYear - 1}/${fiscalYearEndYear}`
}

function getAnnualVatDeadline(
  fiscalYearEndMonth: number,
  fiscalYearEndYear: number,
  settings: CompanySettingsForDeadlines,
): { day: number; month: number; year: number } {
  // Enskild firma (calendar year only, BFL 3 kap.): without EU trade the
  // annual momsdeklaration follows the income tax return (12 May); with EU
  // trade it is due 26 February (26 kap. 33-33a §§ SFL, Skatteverket's
  // published helårsmoms schedule).
  if (settings.entity_type === 'enskild_firma') {
    return settings.vat_has_eu_trade
      ? { day: 26, month: 1, year: fiscalYearEndYear + 1 }
      : { day: 12, month: 4, year: fiscalYearEndYear + 1 }
  }

  if (settings.vat_has_eu_trade) {
    const month = (fiscalYearEndMonth + 1) % 12
    const year = fiscalYearEndYear + (fiscalYearEndMonth >= 11 ? 1 : 0)
    // A 26 December due date lands on annandag jul; the banking-day
    // adjustment moves it to Skatteverket's published 27th (or later).
    return { day: 26, month, year }
  }

  const paper = settings.vat_filing_method === 'paper'
  if (fiscalYearEndMonth <= 4) {
    return { day: 12, month: paper ? 10 : 11, year: fiscalYearEndYear }
  }
  if (fiscalYearEndMonth <= 6) {
    return paper
      ? { day: 27, month: 11, year: fiscalYearEndYear }
      : { day: 17, month: 0, year: fiscalYearEndYear + 1 }
  }
  if (fiscalYearEndMonth <= 8) {
    return { day: 12, month: paper ? 2 : 3, year: fiscalYearEndYear + 1 }
  }
  return { day: paper ? 12 : 17, month: paper ? 6 : 7, year: fiscalYearEndYear + 1 }
}

function generateAnnualVatDates(
  deadlineYear: number,
  settings: CompanySettingsForDeadlines,
): DeadlineInstance[] {
  const fiscalYearEndMonth = settings.entity_type === 'enskild_firma'
    ? 12
    : (settings.fiscal_year_start_month === 1 ? 12 : settings.fiscal_year_start_month - 1)
  const results: DeadlineInstance[] = []

  for (const fiscalYearEndYear of [deadlineYear - 1, deadlineYear]) {
    const deadline = getAnnualVatDeadline(fiscalYearEndMonth, fiscalYearEndYear, settings)
    if (deadline.year !== deadlineYear) continue

    const period = getFiscalYearLabel(fiscalYearEndMonth, fiscalYearEndYear)
    results.push({
      ...deadline,
      period,
      periodLabel: period,
    })
  }

  return results
}

/**
 * All tax deadline configurations
 */
export const TAX_DEADLINE_CONFIGS: TaxDeadlineConfig[] = [
  // Momsdeklaration (monthly)
  {
    type: 'moms_monthly',
    titleTemplate: 'Momsdeklaration {periodLabel}',
    description: 'Momsdeklaration för månadsredovisare',
    condition: (s) => s.vat_registered && s.moms_period === 'monthly',
    priority: 'important',
    linkedReportType: 'vat',
    generateDates: (year, settings) => {
      const instances: DeadlineInstance[] = []
      for (let month = 0; month < 12; month++) {
        const monthOffset = settings.vat_taxable_base_over_40m ? 1 : 2
        const deadlineMonth = (month + monthOffset) % 12
        const deadlineYear = year + Math.floor((month + monthOffset) / 12)
        // Above SEK 40M the 26th applies year-round; 26 December is annandag
        // jul, and the banking-day adjustment yields Skatteverket's 27th.
        const day = settings.vat_taxable_base_over_40m
          ? 26
          : (deadlineMonth === 0 || deadlineMonth === 7 ? 17 : 12)
        instances.push({
          day,
          month: deadlineMonth,
          year: deadlineYear,
          period: `${year}-${String(month + 1).padStart(2, '0')}`,
          periodLabel: getMonthLabel(month, year),
        })
      }
      return instances
    },
  },

  // Momsdeklaration (quarterly)
  {
    type: 'moms_quarterly',
    titleTemplate: 'Momsdeklaration {periodLabel}',
    description: 'Momsdeklaration för kvartalsredovisare',
    condition: (s) => s.vat_registered && s.moms_period === 'quarterly',
    priority: 'important',
    linkedReportType: 'vat',
    generateDates: (year) => {
      return [
        { day: 12, month: 4, year, period: `${year}-Q1`, periodLabel: `Q1 ${year}` },
        { day: 17, month: 7, year, period: `${year}-Q2`, periodLabel: `Q2 ${year}` },
        { day: 12, month: 10, year, period: `${year}-Q3`, periodLabel: `Q3 ${year}` },
        { day: 12, month: 1, year: year + 1, period: `${year}-Q4`, periodLabel: `Q4 ${year}` },
      ]
    },
  },

  // Momsdeklaration (yearly)
  {
    type: 'moms_yearly',
    titleTemplate: 'Momsdeklaration {periodLabel}',
    description: 'Momsdeklaration för årsredovisare',
    condition: (s) => s.vat_registered && s.moms_period === 'yearly',
    priority: 'important',
    linkedReportType: 'vat',
    generateDates: (year, settings) => generateAnnualVatDates(year, settings),
  },

  // Debiterad preliminärskatt (monthly payment). Gated on the debited amount,
  // NOT on F-skatt approval: approval is a status with no recurring duty, and
  // Skatteverket debits nothing below 2 400 kr/år (SFL 55 kap. 2 §). The
  // monthly payment obligation exists only while an amount > 0 is debited
  // (SFL 62 kap. 4-5 §§).
  {
    type: 'f_skatt',
    titleTemplate: 'Betala preliminärskatt {periodLabel}',
    description: 'Inbetalning av debiterad preliminärskatt',
    condition: (s) => (s.preliminary_tax_monthly ?? 0) > 0,
    priority: 'important',
    linkedReportType: null,
    generateDates: (year, settings) => {
      // Small-company förfallodagar are the 12th, with the 17th in January
      // and August; storföretag (VAT taxable base over SEK 40M) keep the
      // 12th in August, January-only 17th (62 kap. 3-4 §§ SFL and
      // Skatteverket's published storföretag calendar).
      const storforetag = settings.vat_registered && settings.vat_taxable_base_over_40m
      const instances: DeadlineInstance[] = []
      for (let month = 0; month < 12; month++) {
        instances.push({
          day: month === 0 || (month === 7 && !storforetag) ? 17 : 12,
          month,
          year,
          period: `${year}-${String(month + 1).padStart(2, '0')}`,
          periodLabel: getMonthLabel(month, year),
        })
      }
      return instances
    },
  },

  // Arbetsgivardeklaration (monthly). A REGISTERED employer must file AGI
  // every month, including nil months (SFL 26 kap. 3 §): the gate is
  // registration, not whether salaries were paid, with pays_salaries as a
  // fallback for settings saved before the registration flag existed.
  // Säsongsregistrerade employers file only for months with payments plus a
  // December nil declaration when nothing was paid all year, so they get
  // only the December-period row; payment months are handled by the salary
  // flow itself.
  // The filing day is keyed to the VAT taxable base, not a separate employer
  // measure (SFL 26 kap.): above SEK 40M the whole skattedeklaration (AGI and
  // VAT) is due the 26th of the following month; otherwise the 12th (17th in
  // January and August). Employers without VAT reporting follow the same
  // 12th/17th small-company schedule.
  {
    type: 'arbetsgivardeklaration',
    titleTemplate: 'Arbetsgivardeklaration {periodLabel}',
    description: 'Arbetsgivardeklaration för registrerade arbetsgivare',
    condition: (s) => s.employer_registered ?? s.pays_salaries,
    priority: 'important',
    linkedReportType: null,
    generateDates: (year, settings) => {
      const storforetag = settings.vat_registered && settings.vat_taxable_base_over_40m
      const instances: DeadlineInstance[] = []
      for (let month = 0; month < 12; month++) {
        if (settings.employer_seasonal && month !== 11) continue
        const deadlineMonth = (month + 1) % 12
        const deadlineYear = month === 11 ? year + 1 : year
        const day = storforetag
          ? 26
          : (deadlineMonth === 0 || deadlineMonth === 7 ? 17 : 12)
        instances.push({
          day,
          month: deadlineMonth,
          year: deadlineYear,
          period: `${year}-${String(month + 1).padStart(2, '0')}`,
          periodLabel: getMonthLabel(month, year),
        })
      }
      return instances
    },
  },

  // Skatteinbetalning (storföretag): companies above the SEK 40M VAT taxable
  // base file the skattedeklaration on the 26th but must still have deducted
  // tax and employer contributions paid into skattekontot by the 12th (17th
  // in January). Without this row the 26th filing date hides a payment
  // deadline two weeks earlier.
  {
    type: 'skatteinbetalning',
    titleTemplate: 'Betala skatt och arbetsgivaravgifter {periodLabel}',
    description: 'Inbetalning av avdragen skatt och arbetsgivaravgifter för företag med beskattningsunderlag över 40 miljoner kronor',
    condition: (s) =>
      (s.employer_registered ?? s.pays_salaries) && s.vat_registered && s.vat_taxable_base_over_40m,
    priority: 'important',
    linkedReportType: null,
    generateDates: (year) => {
      const instances: DeadlineInstance[] = []
      for (let month = 0; month < 12; month++) {
        const deadlineMonth = (month + 1) % 12
        const deadlineYear = month === 11 ? year + 1 : year
        instances.push({
          // Deliberately January-only: the 17 August exception applies to the
          // small-company (below SEK 40M) schedule. Storföretag payment dates
          // are the 12th every month except January (62 kap. 3 § SFL and
          // Skatteverket's published storföretag calendar).
          day: deadlineMonth === 0 ? 17 : 12,
          month: deadlineMonth,
          year: deadlineYear,
          period: `${year}-${String(month + 1).padStart(2, '0')}`,
          periodLabel: getMonthLabel(month, year),
        })
      }
      return instances
    },
  },

  // Periodisk sammanställning (EU sales)
  {
    type: 'periodisk_sammanstallning',
    titleTemplate: 'Periodisk sammanställning {periodLabel}',
    description: 'Periodisk sammanställning för EU-försäljning',
    condition: (s) => s.vat_registered && s.periodisk_sammanstallning_enabled,
    priority: 'normal',
    linkedReportType: null,
    generateDates: (year, settings) => {
      const day = settings.periodisk_sammanstallning_filing_method === 'paper' ? 20 : 25
      if (settings.periodisk_sammanstallning_period === 'quarterly') {
        return [
          { day, month: 3, year, period: `${year}-Q1`, periodLabel: `Q1 ${year}` },
          { day, month: 6, year, period: `${year}-Q2`, periodLabel: `Q2 ${year}` },
          { day, month: 9, year, period: `${year}-Q3`, periodLabel: `Q3 ${year}` },
          { day, month: 0, year: year + 1, period: `${year}-Q4`, periodLabel: `Q4 ${year}` },
        ]
      }

      return Array.from({ length: 12 }, (_, month) => ({
        day,
        month: (month + 1) % 12,
        year: month === 11 ? year + 1 : year,
        period: `${year}-${String(month + 1).padStart(2, '0')}`,
        periodLabel: getMonthLabel(month, year),
      }))
    },
  },

  // Inkomstdeklaration (EF) - 2 maj
  {
    type: 'inkomstdeklaration_ef',
    titleTemplate: 'Inkomstdeklaration + NE-bilaga {periodLabel}',
    description: 'Inkomstdeklaration för enskild firma',
    condition: (s) => s.entity_type === 'enskild_firma',
    priority: 'critical',
    linkedReportType: 'ne-declaration',
    generateDates: (year) => {
      // Due May 2nd for previous year's income
      return [
        { day: 2, month: 4, year, period: `${year - 1}`, periodLabel: `${year - 1}` },
      ]
    },
  },

  // Inkomstdeklaration (AB): digital filing deadlines per Skatteverket lookup table
  {
    type: 'inkomstdeklaration_ab',
    titleTemplate: 'Inkomstdeklaration AB {periodLabel}',
    description: 'Inkomstdeklaration för aktiebolag',
    condition: (s) => s.entity_type === 'aktiebolag',
    priority: 'critical',
    linkedReportType: null,
    generateDates: (year, settings) => {
      // FY end month (1-indexed): e.g. start=1 → end=12, start=5 → end=4
      const fyEndMonth = settings.fiscal_year_start_month === 1 ? 12 : settings.fiscal_year_start_month - 1

      // Skatteverket digital filing deadline lookup:
      // FY end Jan-Apr  → Dec 1 same year as FY end
      // FY end May-Jun  → Jan 15 year after FY end
      // FY end Jul-Aug  → Apr 1 year after FY end
      // FY end Sep-Dec  → Aug 1 year after FY end
      const getDeadline = (fyEndYear: number) => {
        if (fyEndMonth >= 1 && fyEndMonth <= 4) {
          return { day: 1, month: 11, year: fyEndYear } // Dec 1
        } else if (fyEndMonth >= 5 && fyEndMonth <= 6) {
          return { day: 15, month: 0, year: fyEndYear + 1 } // Jan 15
        } else if (fyEndMonth >= 7 && fyEndMonth <= 8) {
          return { day: 1, month: 3, year: fyEndYear + 1 } // Apr 1
        } else {
          return { day: 1, month: 7, year: fyEndYear + 1 } // Aug 1
        }
      }

      // We need to find which FY ending produces a deadline in `year`.
      // Try FY endings in year-1 and year (both could produce deadlines in `year`).
      const results: DeadlineInstance[] = []
      for (const fyEndYear of [year - 1, year]) {
        const dl = getDeadline(fyEndYear)
        if (dl.year === year) {
          // Compute the FY start year
          const fyStart = fyEndMonth === 12 ? fyEndYear : fyEndYear
          const periodLabel = fyEndMonth === 12
            ? `${fyEndYear}`
            : `${fyStart - 1}/${fyStart}`
          const period = fyEndMonth === 12
            ? `${fyEndYear}`
            : `${fyStart - 1}/${fyStart}`
          results.push({
            day: dl.day,
            month: dl.month,
            year: dl.year,
            period,
            periodLabel,
          })
        }
      }
      return results
    },
  },

  // Årsredovisning (AB): 7 months after fiscal year end per ÅRL 8:3
  {
    type: 'arsredovisning',
    titleTemplate: 'Årsredovisning till Bolagsverket {periodLabel}',
    description: 'Årsredovisning för aktiebolag',
    condition: (s) => s.entity_type === 'aktiebolag',
    priority: 'critical',
    linkedReportType: null,
    generateDates: (year, settings) => {
      // FY end month (1-indexed)
      const fyEndMonth = settings.fiscal_year_start_month === 1 ? 12 : settings.fiscal_year_start_month - 1

      // 7 months after FY end per ÅRL 8:3
      // Deadline month (0-indexed): ((fyEndMonth - 1) + 7) % 12
      // Last day of the deadline month
      // Determine which year the deadline falls in
      const _wrapsYear = fyEndMonth > 5 // Jun+ wraps into next year
      // For calendar year (Dec end): deadline Jul 31 same year+1
      // The FY ending in `year` produces a deadline:
      const _fyEndYear = year - 1 // By default we show deadline for the FY that ended in year-1
      // Simpler: compute from a concrete FY end date
      // FY ends: fyEndMonth (1-indexed), last day, in some year.
      // We want the deadline that falls in `year`.

      // Try FY endings in year-1 and year
      const results: DeadlineInstance[] = []
      for (const endYr of [year - 1, year]) {
        // Deadline: 7 months after last day of fyEndMonth in endYr
        const dlMonth0 = ((fyEndMonth - 1) + 7) % 12
        const dlYear = (fyEndMonth - 1) + 7 >= 12 ? endYr + 1 : endYr
        if (dlYear === year) {
          const lastDay = new Date(dlYear, dlMonth0 + 1, 0).getDate()
          const periodLabel = fyEndMonth === 12
            ? `${endYr}`
            : `${endYr - 1}/${endYr}`
          const period = periodLabel
          results.push({
            day: lastDay,
            month: dlMonth0,
            year: dlYear,
            period,
            periodLabel,
          })
        }
      }
      return results
    },
  },

  // Bokslut (AB) - 31 mars for calendar year
  {
    type: 'bokslut',
    titleTemplate: 'Bokslut räkenskapsår {periodLabel}',
    description: 'Bokslut för aktiebolag',
    condition: (s) => s.entity_type === 'aktiebolag',
    priority: 'important',
    linkedReportType: null,
    generateDates: (year, settings) => {
      // For calendar year, December 31 is fiscal year end, deadline March 31
      if (settings.fiscal_year_start_month === 1) {
        return [
          { day: 31, month: 2, year, period: `${year - 1}`, periodLabel: `${year - 1}` }, // March
        ]
      }
      // For non-calendar fiscal years, 3 months after year end
      const fiscalYearEnd = settings.fiscal_year_start_month - 1
      const deadlineMonth = (fiscalYearEnd + 3) % 12
      const deadlineYear = deadlineMonth < fiscalYearEnd ? year + 1 : year
      return [
        { day: 31, month: deadlineMonth, year: deadlineYear, period: `${year - 1}/${year}`, periodLabel: `${year - 1}/${year}` },
      ]
    },
  },
]

/**
 * Helper to get month label in Swedish
 */
function getMonthLabel(month: number, year: number): string {
  const months = [
    'januari', 'februari', 'mars', 'april', 'maj', 'juni',
    'juli', 'augusti', 'september', 'oktober', 'november', 'december'
  ]
  return `${months[month]} ${year}`
}

/**
 * Get all applicable deadline configs for given company settings
 */
export function getApplicableDeadlineConfigs(
  settings: CompanySettingsForDeadlines
): TaxDeadlineConfig[] {
  return TAX_DEADLINE_CONFIGS.filter((config) => config.condition(settings))
}

/**
 * Map from tax deadline type to report URL generator
 */
export const REPORT_URLS: Record<string, (period: { year: number; quarter?: number; month?: number }) => string> = {
  vat: (p) => {
    if (p.quarter) {
      return `/reports?tab=vat&year=${p.year}&period=${p.quarter}`
    }
    if (p.month) {
      return `/reports?tab=vat&year=${p.year}&period=${p.month}`
    }
    return `/reports?tab=vat&year=${p.year}`
  },
  'ne-declaration': () => '/reports?tab=ne-declaration',
}

/**
 * Get the report URL for a deadline
 */
export function getReportUrl(
  linkedReportType: string | null,
  linkedReportPeriod: Record<string, unknown> | null
): string | null {
  if (!linkedReportType || !linkedReportPeriod) {
    return null
  }

  const urlGenerator = REPORT_URLS[linkedReportType]
  if (!urlGenerator) {
    return null
  }

  return urlGenerator(linkedReportPeriod as { year: number; quarter?: number; month?: number })
}
