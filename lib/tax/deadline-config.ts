/**
 * Static configuration of all Swedish tax deadlines (Skatteverket)
 * Based on Skatteverket's official deadline schedule
 */

import type { TaxDeadlineType, EntityType, MomsPeriod } from '@/types'

// Condition function type for determining if a deadline applies
export type DeadlineCondition = (settings: CompanySettingsForDeadlines) => boolean

// Subset of company settings needed for deadline generation
export interface CompanySettingsForDeadlines {
  entity_type: EntityType
  moms_period: MomsPeriod | null
  f_skatt: boolean
  vat_registered: boolean
  pays_salaries: boolean
  fiscal_year_start_month: number // 1-12
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
    generateDates: (year) => {
      const instances: DeadlineInstance[] = []
      // Due on the 12th of the following month
      for (let month = 0; month < 12; month++) {
        // Deadline for month X is on 12th of month X+1
        const deadlineMonth = (month + 1) % 12
        const deadlineYear = month === 11 ? year + 1 : year
        instances.push({
          day: 12,
          month: deadlineMonth,
          year: deadlineYear,
          period: `${year}-${String(month + 1).padStart(2, '0')}`,
          periodLabel: getMonthLabel(month, year),
        })
      }
      return instances
    },
  },

  // Momsdeklaration (quarterly) - e-tjänst deadline (26:e)
  {
    type: 'moms_quarterly',
    titleTemplate: 'Momsdeklaration {periodLabel}',
    description: 'Momsdeklaration för kvartalsredovisare (e-tjänst)',
    condition: (s) => s.vat_registered && s.moms_period === 'quarterly',
    priority: 'important',
    linkedReportType: 'vat',
    generateDates: (year) => {
      // Q1 (Jan-Mar) -> 26 april
      // Q2 (Apr-Jun) -> 26 juli
      // Q3 (Jul-Sep) -> 26 oktober
      // Q4 (Oct-Dec) -> 26 januari next year
      return [
        { day: 26, month: 3, year, period: `${year}-Q1`, periodLabel: `Q1 ${year}` },   // April
        { day: 26, month: 6, year, period: `${year}-Q2`, periodLabel: `Q2 ${year}` },   // July
        { day: 26, month: 9, year, period: `${year}-Q3`, periodLabel: `Q3 ${year}` },   // October
        { day: 26, month: 0, year: year + 1, period: `${year}-Q4`, periodLabel: `Q4 ${year}` }, // January next year
      ]
    },
  },

  // F-skatt (monthly)
  {
    type: 'f_skatt',
    titleTemplate: 'F-skatt {periodLabel}',
    description: 'Inbetalning av preliminär skatt',
    condition: (s) => s.f_skatt,
    priority: 'important',
    linkedReportType: null,
    generateDates: (year) => {
      const instances: DeadlineInstance[] = []
      // Due on the 17th of each month
      for (let month = 0; month < 12; month++) {
        instances.push({
          day: 17,
          month,
          year,
          period: `${year}-${String(month + 1).padStart(2, '0')}`,
          periodLabel: getMonthLabel(month, year),
        })
      }
      return instances
    },
  },

  // Arbetsgivardeklaration (monthly, any employer with employees: AB or EF)
  // Per Skatteförfarandelagen: every employer paying salary must file AGI monthly.
  // Deadline: 12th of following month (17th in Jan/Aug for turnover ≤40 MSEK per agi-filing.md)
  {
    type: 'arbetsgivardeklaration',
    titleTemplate: 'Arbetsgivardeklaration {periodLabel}',
    description: 'Arbetsgivardeklaration för arbetsgivare med anställda',
    condition: (s) => s.pays_salaries,
    priority: 'important',
    linkedReportType: null,
    generateDates: (year) => {
      const instances: DeadlineInstance[] = []
      // Due on the 12th of the following month
      // Exception: January (for Dec) and August (for Jul) = 17th for ≤40 MSEK turnover
      for (let month = 0; month < 12; month++) {
        const deadlineMonth = (month + 1) % 12
        const deadlineYear = month === 11 ? year + 1 : year
        // Jan (deadlineMonth=0) and Aug (deadlineMonth=7) get 17th
        const day = (deadlineMonth === 0 || deadlineMonth === 7) ? 17 : 12
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

  // Periodisk sammanställning (quarterly, EU sales)
  {
    type: 'periodisk_sammanstallning',
    titleTemplate: 'Periodisk sammanställning {periodLabel}',
    description: 'Periodisk sammanställning för EU-försäljning',
    condition: (s) => s.vat_registered, // Simplified - in reality depends on EU sales
    priority: 'normal',
    linkedReportType: null,
    generateDates: (year) => {
      // Q1 -> 20 april, Q2 -> 20 juli, Q3 -> 20 oktober, Q4 -> 20 januari
      return [
        { day: 20, month: 3, year, period: `${year}-Q1`, periodLabel: `Q1 ${year}` },
        { day: 20, month: 6, year, period: `${year}-Q2`, periodLabel: `Q2 ${year}` },
        { day: 20, month: 9, year, period: `${year}-Q3`, periodLabel: `Q3 ${year}` },
        { day: 20, month: 0, year: year + 1, period: `${year}-Q4`, periodLabel: `Q4 ${year}` },
      ]
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
