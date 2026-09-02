/**
 * Static configuration of all Swedish tax deadlines (Skatteverket)
 * Based on Skatteverket's official deadline schedule
 */

import type { TaxDeadlineType, EntityType, MomsPeriod, TaxFilingMethod } from '@/types'
import { isBankingDay } from './swedish-holidays'

// Condition function type for determining if a deadline applies
export type DeadlineCondition = (settings: CompanySettingsForDeadlines) => boolean

export interface TaxAssessmentNoticeForDeadline {
  id: string
  fiscalPeriodName: string
  decisionType: 'final' | 'reassessment'
  paymentDueDate: string
}

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
  kontrolluppgifter_enabled: boolean
  rot_rut_enabled: boolean
  oss_enabled: boolean
  ioss_enabled: boolean
  intrastat_enabled: boolean
  punktskatt_enabled: boolean
  fyllnadsinbetalning_enabled: boolean
  /**
   * Derived, NOT a company_settings column: distinct years with paid ROT/RUT
   * invoices. Populated by the generator from the invoices table (a begäran
   * deadline for year Y only exists when Y actually has ROT/RUT payments,
   * Lag 2009:194 8 §). Undefined in pure-settings contexts (backfill
   * detection), where rot_rut_begaran rows are simply never expected.
   */
  rot_rut_payment_years?: number[]
  /** Derived from active tax_assessment_notices rows by the generator. */
  tax_assessment_notices?: TaxAssessmentNoticeForDeadline[]
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
  /**
   * EU-law deadlines (OSS/IOSS) do not move to the next banking day: the
   * last day of the month stands even on weekends and holidays. Also set
   * for dates that are already computed as banking days (Intrastat).
   */
  skipBankingDayAdjustment?: boolean
}

// A specific instance of a deadline
export interface DeadlineInstance {
  day: number      // Day of month
  month: number    // 0-indexed month
  year: number
  period: string   // e.g., "2025-Q1", "2025-01", "2025"
  periodLabel: string // Human-readable, e.g., "Q1 2025", "januari 2025"
  taxAssessmentNoticeId?: string
}

export interface VatDeadlineCalculationSettings {
  vat_taxable_base_over_40m: boolean
  entity_type?: EntityType | null
  fiscal_year_start_month?: number | null
  vat_has_eu_trade?: boolean | null
  vat_filing_method?: TaxFilingMethod | null
}

interface AnnualVatDeadlineSettings {
  entity_type: 'aktiebolag' | 'enskild_firma'
  fiscal_year_start_month: number
  vat_has_eu_trade: boolean
  vat_filing_method?: TaxFilingMethod | null
}

/**
 * Day-of-month of the nth Swedish banking day in a month (1-based n).
 * Used for Intrastat, whose SCB reporting dates follow the ~10th working
 * day of the month after the reference month.
 */
function nthBankingDayOfMonth(year: number, month: number, n: number): number {
  let count = 0
  for (let day = 1; day <= 31; day++) {
    const date = new Date(year, month, day)
    if (date.getMonth() !== month) break
    if (isBankingDay(date)) {
      count++
      if (count === n) return day
    }
  }
  // A month always has more than 10 banking days; never reached.
  return 28
}

function getFiscalYearLabel(fiscalYearEndMonth: number, fiscalYearEndYear: number): string {
  return fiscalYearEndMonth === 12
    ? `${fiscalYearEndYear}`
    : `${fiscalYearEndYear - 1}/${fiscalYearEndYear}`
}

function getAnnualVatDeadline(
  fiscalYearEndMonth: number,
  fiscalYearEndYear: number,
  settings: AnnualVatDeadlineSettings,
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

/**
 * Resolve the raw statutory VAT filing date for one reporting period.
 * Banking-day adjustment is deliberately left to callers, matching the other
 * deadline configs whose generated instances are adjusted by the generator.
 */
export function getVatDeadlineForPeriod(
  periodType: 'monthly' | 'quarterly' | 'yearly',
  year: number,
  period: number,
  settings: VatDeadlineCalculationSettings,
): DeadlineInstance | null {
  if (periodType === 'monthly') {
    if (period < 1 || period > 12) return null

    const month = period - 1
    const monthOffset = settings.vat_taxable_base_over_40m ? 1 : 2
    const deadlineMonth = (month + monthOffset) % 12
    const deadlineYear = year + Math.floor((month + monthOffset) / 12)
    const day = settings.vat_taxable_base_over_40m
      ? 26
      : (deadlineMonth === 0 || deadlineMonth === 7 ? 17 : 12)

    return {
      day,
      month: deadlineMonth,
      year: deadlineYear,
      period: `${year}-${String(period).padStart(2, '0')}`,
      periodLabel: getMonthLabel(month, year),
    }
  }

  if (periodType === 'quarterly') {
    if (period < 1 || period > 4) return null

    return [
      { day: 12, month: 4, year, period: `${year}-Q1`, periodLabel: `Q1 ${year}` },
      { day: 17, month: 7, year, period: `${year}-Q2`, periodLabel: `Q2 ${year}` },
      { day: 12, month: 10, year, period: `${year}-Q3`, periodLabel: `Q3 ${year}` },
      { day: 12, month: 1, year: year + 1, period: `${year}-Q4`, periodLabel: `Q4 ${year}` },
    ][period - 1]
  }

  if (period !== 1) return null
  if (settings.entity_type !== 'aktiebolag' && settings.entity_type !== 'enskild_firma') {
    return null
  }
  if (typeof settings.vat_has_eu_trade !== 'boolean') return null
  if (
    settings.entity_type === 'aktiebolag'
    && settings.vat_has_eu_trade === false
    && settings.vat_filing_method !== 'electronic'
    && settings.vat_filing_method !== 'paper'
  ) {
    return null
  }

  const configuredFiscalYearStartMonth = settings.fiscal_year_start_month != null
    && settings.fiscal_year_start_month >= 1
    && settings.fiscal_year_start_month <= 12
    ? settings.fiscal_year_start_month
    : null
  if (settings.entity_type === 'aktiebolag' && configuredFiscalYearStartMonth === null) {
    return null
  }
  const fiscalYearStartMonth = settings.entity_type === 'enskild_firma'
    ? 1
    : configuredFiscalYearStartMonth!
  const fiscalYearEndMonth = settings.entity_type === 'enskild_firma'
    ? 12
    : (fiscalYearStartMonth === 1 ? 12 : fiscalYearStartMonth - 1)
  const deadline = getAnnualVatDeadline(fiscalYearEndMonth, year, {
    entity_type: settings.entity_type,
    fiscal_year_start_month: fiscalYearStartMonth,
    vat_has_eu_trade: settings.vat_has_eu_trade,
    vat_filing_method: settings.vat_filing_method,
  })
  const fiscalYearLabel = getFiscalYearLabel(fiscalYearEndMonth, year)

  return {
    ...deadline,
    period: fiscalYearLabel,
    periodLabel: fiscalYearLabel,
  }
}

function generateAnnualVatDates(
  deadlineYear: number,
  settings: CompanySettingsForDeadlines,
): DeadlineInstance[] {
  const results: DeadlineInstance[] = []

  for (const fiscalYearEndYear of [deadlineYear - 1, deadlineYear]) {
    const instance = getVatDeadlineForPeriod('yearly', fiscalYearEndYear, 1, settings)
    if (instance?.year === deadlineYear) results.push(instance)
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
    generateDates: (year, settings) => Array.from(
      { length: 12 },
      (_, month) => getVatDeadlineForPeriod('monthly', year, month + 1, settings)!,
    ),
  },

  // Momsdeklaration (quarterly)
  {
    type: 'moms_quarterly',
    titleTemplate: 'Momsdeklaration {periodLabel}',
    description: 'Momsdeklaration för kvartalsredovisare',
    condition: (s) => s.vat_registered && s.moms_period === 'quarterly',
    priority: 'important',
    linkedReportType: 'vat',
    generateDates: (year, settings) => Array.from(
      { length: 4 },
      (_, quarter) => getVatDeadlineForPeriod('quarterly', year, quarter + 1, settings)!,
    ),
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

  // OSS (unionsordningen): quarterly declaration for B2C distance sales
  // above the EUR 10 000 threshold, filed in Skatteverket's OSS portal
  // (ML 22 kap., Art. 369f VAT directive). Due the last day of the month
  // after the quarter. EU-law deadline: it does NOT move to the next
  // banking day; a Sunday 31st stands.
  {
    type: 'oss_quarterly',
    titleTemplate: 'OSS-deklaration {periodLabel}',
    description: 'OSS-deklaration (unionsordningen) för EU-försäljning till konsumenter',
    condition: (s) => s.vat_registered && s.oss_enabled,
    priority: 'important',
    linkedReportType: null,
    skipBankingDayAdjustment: true,
    generateDates: (year) => [
      { day: 30, month: 3, year, period: `${year}-Q1`, periodLabel: `Q1 ${year}` },
      { day: 31, month: 6, year, period: `${year}-Q2`, periodLabel: `Q2 ${year}` },
      { day: 31, month: 9, year, period: `${year}-Q3`, periodLabel: `Q3 ${year}` },
      { day: 31, month: 0, year: year + 1, period: `${year}-Q4`, periodLabel: `Q4 ${year}` },
    ],
  },

  // IOSS (importordningen): monthly declaration for distance sales of
  // imported low-value goods (Art. 369s VAT directive). Due the last day
  // of the following month; same EU no-shift rule as OSS. Unlike OSS the
  // scheme does not require Swedish VAT registration (Art. 369s applies to
  // registered IOSS sellers regardless), so the opt-in flag stands alone.
  {
    type: 'ioss_monthly',
    titleTemplate: 'IOSS-deklaration {periodLabel}',
    description: 'IOSS-deklaration (importordningen) för distansförsäljning av importerade varor',
    condition: (s) => s.ioss_enabled,
    priority: 'important',
    linkedReportType: null,
    skipBankingDayAdjustment: true,
    generateDates: (year) =>
      Array.from({ length: 12 }, (_, month) => {
        const deadlineYear = month === 11 ? year + 1 : year
        const deadlineMonth = (month + 1) % 12
        // Last day of the month after the reference month.
        const day = new Date(deadlineYear, deadlineMonth + 1, 0).getDate()
        return {
          day,
          month: deadlineMonth,
          year: deadlineYear,
          period: `${year}-${String(month + 1).padStart(2, '0')}`,
          periodLabel: getMonthLabel(month, year),
        }
      }),
  },

  // Intrastat: SCB's monthly trade-in-goods report for companies above the
  // arrival/dispatch thresholds. SCB publishes exact dates yearly; they
  // follow the ~10th working day of the month after the reference month,
  // which is what we compute. Already a banking day, so no adjustment.
  {
    type: 'intrastat_monthly',
    titleTemplate: 'Intrastat {periodLabel}',
    description: 'Intrastat-rapport till SCB för varuhandel inom EU',
    condition: (s) => s.vat_registered && s.intrastat_enabled,
    priority: 'normal',
    linkedReportType: null,
    skipBankingDayAdjustment: true,
    generateDates: (year) =>
      Array.from({ length: 12 }, (_, month) => {
        const deadlineYear = month === 11 ? year + 1 : year
        const deadlineMonth = (month + 1) % 12
        return {
          day: nthBankingDayOfMonth(deadlineYear, deadlineMonth, 10),
          month: deadlineMonth,
          year: deadlineYear,
          period: `${year}-${String(month + 1).padStart(2, '0')}`,
          periodLabel: getMonthLabel(month, year),
        }
      }),
  },

  // Punktskattedeklaration (monthly): excise duties follow the ordinary
  // skattedeklaration schedule (SFL 26 kap.): the 12th of the following
  // month (17th in January and August), the 26th for storföretag.
  {
    type: 'punktskatt_monthly',
    titleTemplate: 'Punktskattedeklaration {periodLabel}',
    description: 'Punktskattedeklaration för punktskattepliktiga företag',
    condition: (s) => s.punktskatt_enabled,
    priority: 'important',
    linkedReportType: null,
    generateDates: (year, settings) => {
      const storforetag = settings.vat_registered && settings.vat_taxable_base_over_40m
      const instances: DeadlineInstance[] = []
      for (let month = 0; month < 12; month++) {
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

  // Fyllnadsinbetalning: extra preliminary tax payments that stop
  // kostnadsränta on the coming kvarskatt (SFL 62 kap. 8 §, 65 kap.).
  // Parts over 30 000 kr must be on skattekontot by the 12th of the second
  // month after the beskattningsår ends (12 Feb for calendar years); the
  // remainder by the 3rd of the fifth month (3 May). Both dates are
  // generated since the app cannot know the kvarskatt amount; the labels
  // say which part each date covers.
  {
    type: 'fyllnadsinbetalning',
    titleTemplate: 'Fyllnadsinbetalning {periodLabel}',
    description: 'Extra inbetalning av preliminärskatt för att undvika kostnadsränta',
    condition: (s) => s.fyllnadsinbetalning_enabled,
    priority: 'normal',
    linkedReportType: null,
    generateDates: (year, settings) => {
      const fyEndMonth = settings.entity_type === 'enskild_firma'
        ? 12
        : (settings.fiscal_year_start_month === 1 ? 12 : settings.fiscal_year_start_month - 1)
      const results: DeadlineInstance[] = []
      for (const fyEndYear of [year - 1, year]) {
        const fyLabel = getFiscalYearLabel(fyEndMonth, fyEndYear)
        // fyEndMonth is 1-indexed; (fyEndMonth - 1 + n) is the 0-indexed
        // month n months after FY end, counted from fyEndYear's January.
        // 12th of the second month after FY end (amounts over 30 000 kr):
        // February for a calendar fiscal year.
        const over = {
          day: 12,
          month: (fyEndMonth + 1) % 12,
          year: fyEndYear + Math.floor((fyEndMonth + 1) / 12),
        }
        if (over.year === year) {
          results.push({
            ...over,
            period: `${fyLabel}-over30k`,
            periodLabel: `belopp över 30 000 kr, beskattningsår ${fyLabel}`,
          })
        }
        // 3rd of the fifth month after FY end (the remainder): May for a
        // calendar fiscal year.
        const rest = {
          day: 3,
          month: (fyEndMonth + 4) % 12,
          year: fyEndYear + Math.floor((fyEndMonth + 4) / 12),
        }
        if (rest.year === year) {
          results.push({
            ...rest,
            period: `${fyLabel}-rest`,
            periodLabel: `resterande belopp, beskattningsår ${fyLabel}`,
          })
        }
      }
      return results
    },
  },

  // Kvarskatt: the payment date is copied exactly from the final tax notice
  // or reassessment decision. It must not be estimated or moved to a banking
  // day because Skatteverket has already determined the statutory due date.
  {
    type: 'kvarskatt',
    titleTemplate: 'Kvarskatt {periodLabel}',
    description: 'Kvarskatt enligt slutskattebesked eller omprövningsbeslut',
    condition: (s) => (s.tax_assessment_notices?.length ?? 0) > 0,
    priority: 'critical',
    linkedReportType: null,
    skipBankingDayAdjustment: true,
    generateDates: (year, settings) => (settings.tax_assessment_notices ?? [])
      .filter((notice) => Number(notice.paymentDueDate.slice(0, 4)) === year)
      .map((notice) => ({
        day: Number(notice.paymentDueDate.slice(8, 10)),
        month: Number(notice.paymentDueDate.slice(5, 7)) - 1,
        year,
        period: `notice:${notice.id}`,
        periodLabel: notice.decisionType === 'reassessment'
          ? `omprövning, ${notice.fiscalPeriodName}`
          : `slutskattebesked, ${notice.fiscalPeriodName}`,
        taxAssessmentNoticeId: notice.id,
      })),
  },

  // Kontrolluppgifter (KU10/KU20/KU31): annual income statements to
  // Skatteverket, due 31 January after the income year (SFL 24 kap. 1 §).
  // KU31 (utdelning) is never covered by the monthly AGI, so a fåmansbolag
  // paying utdelning must file it separately even when all salaries are
  // AGI-reported. Opt-in: the user confirms the flag in tax settings, where
  // a ledger-derived signal (2898 utdelning, 2393/2893 ägarlån) suggests it.
  {
    type: 'kontrolluppgifter',
    titleTemplate: 'Kontrolluppgifter {periodLabel}',
    description: 'Kontrolluppgifter (KU10/KU20/KU31) till Skatteverket',
    condition: (s) => s.kontrolluppgifter_enabled,
    priority: 'important',
    linkedReportType: null,
    generateDates: (year) => {
      // Due 31 January for the previous income year (always calendar year:
      // kontrolluppgifter follow the income year, not the räkenskapsår).
      return [
        { day: 31, month: 0, year, period: `${year - 1}`, periodLabel: `${year - 1}` },
      ]
    },
  },

  // ROT/RUT begäran om utbetalning: the payout request for deductions given
  // during year Y must reach Skatteverket by 31 January of year Y+1
  // (Lag 2009:194 8 §). Missing the date forfeits the payout on account
  // 1513, so this is the one deadline where lateness costs the principal,
  // not a fee. Keyed on PAYMENT years (buyer paid), never invoice dates:
  // rows only exist for years present in rot_rut_payment_years.
  {
    type: 'rot_rut_begaran',
    titleTemplate: 'ROT/RUT-begäran om utbetalning {periodLabel}',
    description: 'Begäran om utbetalning för ROT/RUT-avdrag till Skatteverket',
    condition: (s) => s.rot_rut_enabled,
    priority: 'critical',
    linkedReportType: null,
    generateDates: (year, settings) => {
      if (!(settings.rot_rut_payment_years ?? []).includes(year - 1)) {
        return []
      }
      return [
        { day: 31, month: 0, year, period: `${year - 1}`, periodLabel: `${year - 1}` },
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

  // Årsstämma (AB): within 6 months of FY end per ABL 7 kap. 10 §. Replaces
  // the former non-statutory 'bokslut' milestone (3 months had no legal
  // basis). The stämma gates the årsredovisning chain: the AR is presented
  // and adopted there, and the Bolagsverket filing (arsredovisning row,
  // 7 months) requires the adopted AR.
  {
    type: 'arsstamma',
    titleTemplate: 'Årsstämma räkenskapsår {periodLabel}',
    description: 'Årsstämma för aktiebolag (senast sex månader efter räkenskapsårets utgång)',
    condition: (s) => s.entity_type === 'aktiebolag',
    priority: 'important',
    linkedReportType: null,
    generateDates: (year, settings) => {
      // FY end month (1-indexed)
      const fyEndMonth = settings.fiscal_year_start_month === 1 ? 12 : settings.fiscal_year_start_month - 1

      // Last day of (FY end month + 6). Swedish fiscal years always end on
      // the last day of a calendar month (BFL 3 kap.), so this equals the
      // statutory six-month limit.
      const results: DeadlineInstance[] = []
      for (const endYr of [year - 1, year]) {
        const dlMonth0 = ((fyEndMonth - 1) + 6) % 12
        const dlYear = (fyEndMonth - 1) + 6 >= 12 ? endYr + 1 : endYr
        if (dlYear === year) {
          const lastDay = new Date(dlYear, dlMonth0 + 1, 0).getDate()
          const periodLabel = fyEndMonth === 12 ? `${endYr}` : `${endYr - 1}/${endYr}`
          results.push({
            day: lastDay,
            month: dlMonth0,
            year: dlYear,
            period: periodLabel,
            periodLabel,
          })
        }
      }
      return results
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
