/**
 * Deadline generator - creates tax deadlines based on company settings
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { TaxDeadlineType, DeadlineStatus } from '@/types'

const log = createLogger('deadline-generator')
import {
  getApplicableDeadlineConfigs,
  type CompanySettingsForDeadlines,
  type DeadlineInstance,
} from './deadline-config'
import { adjustDeadlineToNextBankingDay } from './swedish-holidays'

/**
 * Fields in company_settings that affect tax deadline generation
 */
export const TAX_RELEVANT_FIELDS = [
  'entity_type',
  'moms_period',
  'f_skatt',
  'preliminary_tax_monthly',
  'vat_registered',
  'pays_salaries',
  'employer_registered',
  'employer_seasonal',
  'fiscal_year_start_month',
  'vat_taxable_base_over_40m',
  'vat_has_eu_trade',
  'vat_filing_method',
  'periodisk_sammanstallning_enabled',
  'periodisk_sammanstallning_period',
  'periodisk_sammanstallning_filing_method',
] as const

export const DEADLINE_SETTINGS_SELECT =
  'company_id, entity_type, moms_period, f_skatt, preliminary_tax_monthly, vat_registered, pays_salaries, employer_registered, employer_seasonal, fiscal_year_start_month, vat_taxable_base_over_40m, vat_has_eu_trade, vat_filing_method, periodisk_sammanstallning_enabled, periodisk_sammanstallning_period, periodisk_sammanstallning_filing_method' as const

/**
 * Check if any tax-relevant fields changed
 */
export function didTaxFieldsChange(
  oldSettings: Partial<CompanySettingsForDeadlines>,
  newSettings: Partial<CompanySettingsForDeadlines>
): boolean {
  for (const field of TAX_RELEVANT_FIELDS) {
    if (oldSettings[field] !== newSettings[field]) {
      return true
    }
  }
  return false
}

export function hasTaxRelevantFields(body: Record<string, unknown>): boolean {
  return TAX_RELEVANT_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(body, field))
}

export function toDeadlineSettings(
  settings: Partial<CompanySettingsForDeadlines>,
): CompanySettingsForDeadlines {
  if (settings.entity_type !== 'aktiebolag' && settings.entity_type !== 'enskild_firma') {
    throw new Error('Company entity type is required to generate tax deadlines')
  }

  return {
    entity_type: settings.entity_type,
    moms_period: settings.moms_period ?? null,
    f_skatt: settings.f_skatt ?? true,
    preliminary_tax_monthly: settings.preliminary_tax_monthly ?? null,
    vat_registered: settings.vat_registered ?? false,
    pays_salaries: settings.pays_salaries ?? false,
    employer_registered: settings.employer_registered ?? null,
    employer_seasonal: settings.employer_seasonal ?? false,
    fiscal_year_start_month: settings.fiscal_year_start_month ?? 1,
    vat_taxable_base_over_40m: settings.vat_taxable_base_over_40m ?? false,
    vat_has_eu_trade: settings.vat_has_eu_trade ?? false,
    vat_filing_method: settings.vat_filing_method ?? 'electronic',
    periodisk_sammanstallning_enabled: settings.periodisk_sammanstallning_enabled ?? false,
    periodisk_sammanstallning_period: settings.periodisk_sammanstallning_period ?? 'monthly',
    periodisk_sammanstallning_filing_method:
      settings.periodisk_sammanstallning_filing_method ?? 'electronic',
  }
}

/**
 * Decide whether a settings save should (re)generate tax deadlines.
 *
 * Regenerate when a tax-relevant field changed OR when the company has no
 * system-generated deadlines yet. The second case is the common one: tax
 * settings are filled at onboarding, so a later save with no tax-field change
 * used to skip generation entirely and the deadlines page stayed empty even
 * though the settings were "filled in". Backfilling an empty set is safe: there
 * is no existing status/progress to clobber.
 */
export function shouldRegenerateTaxDeadlines(
  taxFieldsChanged: boolean,
  existingSystemDeadlineCount: number
): boolean {
  return taxFieldsChanged || existingSystemDeadlineCount === 0
}

/**
 * Format date to YYYY-MM-DD
 */
function formatDateISO(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Generate all tax deadlines for a user based on their company settings
 */
export async function generateTaxDeadlinesForUser(
  supabase: SupabaseClient,
  companyId: string,
  settings: CompanySettingsForDeadlines,
  years: number[] = []
): Promise<{ created: number; deleted: number }> {
  // Default to current and next year if not specified
  if (years.length === 0) {
    const currentYear = new Date().getFullYear()
    years = [currentYear, currentYear + 1]
  }

  // Get applicable deadline configs based on settings
  const applicableConfigs = getApplicableDeadlineConfigs(settings)

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayIso = formatDateISO(today)
  const endDate = `${Math.max(...years) + 1}-12-31`

  // Completed deadlines represent real filing progress and dismissed
  // deadlines represent an explicit opt-out; preserve both and do not create
  // a second pending row for the same obligation. The window starts a year
  // before the earliest generated year, NOT today: a completed row can carry
  // a superseded due date that already passed while the current statutory
  // date is still ahead, and filtering on today would resurrect a pending
  // row for an obligation the user already filed.
  const completedFloor = `${Math.min(...years) - 1}-01-01`
  const { data: preservedRows, error: preservedRowsError } = await supabase
    .from('deadlines')
    .select('tax_deadline_type, tax_period')
    .eq('company_id', companyId)
    .eq('source', 'system')
    .or('is_completed.eq.true,dismissed_at.not.is.null')
    .gte('due_date', completedFloor)

  if (preservedRowsError) {
    log.error('Error fetching completed/dismissed deadlines:', preservedRowsError)
    throw preservedRowsError
  }

  const completedKeys = new Set(
    (preservedRows ?? []).map(
      (row: { tax_deadline_type: string | null; tax_period: string | null }) =>
        `${row.tax_deadline_type}:${row.tax_period}`,
    ),
  )

  // Generate new deadlines
  const deadlines: Array<{
    company_id: string
    title: string
    due_date: string
    deadline_type: 'tax'
    priority: 'critical' | 'important' | 'normal'
    is_completed: boolean
    source: 'system'
    status: DeadlineStatus
    tax_deadline_type: TaxDeadlineType
    tax_period: string
    linked_report_type: string | null
    linked_report_period: Record<string, unknown> | null
    reminder_offsets: number[]
    is_auto_generated: boolean
  }> = []

  for (const config of applicableConfigs) {
    for (const year of years) {
      const instances = config.generateDates(year, settings)

      for (const instance of instances) {
        // Create the raw deadline date
        const rawDate = new Date(instance.year, instance.month, instance.day)

        // Adjust for banking days (skip weekends and holidays)
        const adjustedDate = adjustDeadlineToNextBankingDay(rawDate)
        const dueDate = formatDateISO(adjustedDate)

        // Skip if the deadline is in the past
        if (adjustedDate < today) {
          continue
        }

        const deadlineKey = `${config.type}:${instance.period}`
        if (completedKeys.has(deadlineKey)) {
          continue
        }

        // Determine initial status based on days until deadline
        const daysUntil = Math.ceil((adjustedDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
        const status: DeadlineStatus = daysUntil <= 14 ? 'action_needed' : 'upcoming'

        // Generate title from template
        const title = config.titleTemplate.replace('{periodLabel}', instance.periodLabel)

        // Create linked report period data
        const linkedReportPeriod = createLinkedReportPeriod(instance, config.type)

        deadlines.push({
          company_id: companyId,
          title,
          due_date: dueDate,
          deadline_type: 'tax',
          priority: config.priority,
          is_completed: false,
          source: 'system',
          status,
          tax_deadline_type: config.type,
          tax_period: instance.period,
          linked_report_type: config.linkedReportType,
          linked_report_period: linkedReportPeriod,
          reminder_offsets: [14, 7, 1, 0],
          is_auto_generated: true,
        })
      }
    }
  }

  const uniqueDeadlines = Array.from(
    new Map(
      deadlines.map((deadline) => [
        `${deadline.tax_deadline_type}:${deadline.tax_period}`,
        deadline,
      ]),
    ).values(),
  )

  // Insert the replacement rows BEFORE deleting the old set. A failed insert
  // then leaves the previous deadlines intact: the old delete-first order
  // meant any insert failure (like the 23502 user_id regression) wiped the
  // company's tax deadlines without replacing them.
  //
  // Not concurrency-safe: two overlapping regenerations (settings save racing
  // the cron backfill) can each delete the other's freshly inserted rows and
  // leave the company with fewer rows than expected. Accepted: the daily
  // backfill cron detects the missing keys and repairs on its next run.
  let newIds: string[] = []
  if (uniqueDeadlines.length > 0) {
    const { data: insertedData, error: insertError } = await supabase
      .from('deadlines')
      .insert(uniqueDeadlines)
      .select('id')

    if (insertError) {
      log.error('Error inserting deadlines:', insertError)
      throw insertError
    }
    newIds = (insertedData ?? []).map((d: { id: string }) => d.id)
  }

  // Delete the superseded system-generated deadlines for these years,
  // excluding the rows just inserted. Dismissed rows survive: deleting one
  // would erase the opt-out and let the next regeneration recreate the
  // obligation as a fresh pending row.
  let deleteQuery = supabase
    .from('deadlines')
    .delete()
    .eq('company_id', companyId)
    .eq('source', 'system')
    .eq('is_completed', false)
    .is('dismissed_at', null)
    .gte('due_date', todayIso)
    .lte('due_date', endDate)

  if (newIds.length > 0) {
    deleteQuery = deleteQuery.not('id', 'in', `(${newIds.join(',')})`)
  }

  const { data: deletedData, error: deleteError } = await deleteQuery.select('id')

  if (deleteError) {
    log.error('Error deleting existing deadlines:', deleteError)
    throw deleteError
  }

  return {
    created: uniqueDeadlines.length,
    deleted: deletedData?.length || 0,
  }
}

/**
 * Create linked report period object for navigation
 */
function createLinkedReportPeriod(
  instance: DeadlineInstance,
  _type: TaxDeadlineType
): Record<string, unknown> | null {
  const period = instance.period

  // Parse the period string
  if (period.includes('-Q')) {
    // Quarterly: "2025-Q1"
    const [year, quarter] = period.split('-Q')
    return { year: parseInt(year), quarter: parseInt(quarter) }
  }

  if (period.includes('-') && period.length === 7) {
    // Monthly: "2025-01"
    const [year, month] = period.split('-')
    return { year: parseInt(year), month: parseInt(month) }
  }

  if (period.includes('/')) {
    // Fiscal year: "2024/2025"
    const [startYear, endYear] = period.split('/')
    return { startYear: parseInt(startYear), endYear: parseInt(endYear) }
  }

  // Annual: "2025"
  if (/^\d{4}$/.test(period)) {
    return { year: parseInt(period) }
  }

  return null
}

/**
 * Regenerate tax deadlines for a user after settings change
 */
export async function regenerateTaxDeadlinesForUser(
  supabase: SupabaseClient,
  companyId: string,
  newSettings: CompanySettingsForDeadlines
): Promise<{ created: number; deleted: number }> {
  const currentYear = new Date().getFullYear()
  return generateTaxDeadlinesForUser(supabase, companyId, newSettings, [currentYear, currentYear + 1])
}

interface DeadlineSettingsRow extends Partial<CompanySettingsForDeadlines> {
  company_id: string
}

interface UpcomingDeadlineCompanyRow {
  id: string
  company_id: string
  tax_deadline_type: string | null
  tax_period: string | null
  due_date: string | null
  is_completed: boolean | null
  dismissed_at: string | null
}

// The due date is part of the identity: rows created by older schedule logic
// keep their type and period but carry a superseded statutory date, and the
// repair loop must treat those as missing so they get regenerated.
function deadlineIdentity(
  type: string | null,
  period: string | null,
  dueDate: string | null,
): string {
  return `${type}:${period}:${dueDate}`
}

// Completed and dismissed rows use the looser type:period identity (no due
// date): a filed or opted-out obligation is satisfied even when its stored
// date comes from a superseded schedule, and the generator never replaces
// either kind, so flagging them by date would make the repair loop re-run
// for the same company every day without ever converging.
function completedIdentity(type: string | null, period: string | null): string {
  return `${type}:${period}`
}

export function getExpectedUpcomingDeadlineKeys(
  settings: CompanySettingsForDeadlines,
  years: number[] = [],
  fromDate: Date = new Date(),
): Set<string> {
  if (years.length === 0) {
    const currentYear = fromDate.getFullYear()
    years = [currentYear, currentYear + 1]
  }

  const today = new Date(fromDate)
  today.setHours(0, 0, 0, 0)
  const keys = new Set<string>()

  for (const config of getApplicableDeadlineConfigs(settings)) {
    for (const year of years) {
      for (const instance of config.generateDates(year, settings)) {
        const adjustedDate = adjustDeadlineToNextBankingDay(
          new Date(instance.year, instance.month, instance.day),
        )
        if (adjustedDate >= today) {
          keys.add(deadlineIdentity(config.type, instance.period, formatDateISO(adjustedDate)))
        }
      }
    }
  }

  return keys
}

export function findSettingsMissingUpcomingDeadlines(
  settingsRows: DeadlineSettingsRow[],
  upcomingDeadlineRows: UpcomingDeadlineCompanyRow[],
  years: number[] = [],
  fromDate: Date = new Date(),
): DeadlineSettingsRow[] {
  const actualKeysByCompany = new Map<string, Set<string>>()
  const completedKeysByCompany = new Map<string, Set<string>>()
  for (const row of upcomingDeadlineRows) {
    const keys = actualKeysByCompany.get(row.company_id) ?? new Set<string>()
    keys.add(deadlineIdentity(row.tax_deadline_type, row.tax_period, row.due_date))
    actualKeysByCompany.set(row.company_id, keys)

    if (row.is_completed || row.dismissed_at) {
      const completed = completedKeysByCompany.get(row.company_id) ?? new Set<string>()
      completed.add(completedIdentity(row.tax_deadline_type, row.tax_period))
      completedKeysByCompany.set(row.company_id, completed)
    }
  }

  return settingsRows.filter((settings) => {
    try {
      const expectedKeys = getExpectedUpcomingDeadlineKeys(
        toDeadlineSettings(settings),
        years,
        fromDate,
      )
      const actualKeys = actualKeysByCompany.get(settings.company_id) ?? new Set<string>()
      const completedKeys = completedKeysByCompany.get(settings.company_id) ?? new Set<string>()
      return Array.from(expectedKeys).some((key) => {
        if (actualKeys.has(key)) return false
        // key is `${type}:${period}:${dueDate}`; strip the date to compare
        // against the completed set (periods never contain a colon).
        const typeAndPeriod = key.slice(0, key.lastIndexOf(':'))
        return !completedKeys.has(typeAndPeriod)
      })
    } catch {
      // Include malformed settings so the repair loop logs the company-specific
      // generation error without aborting recovery for every other company.
      return true
    }
  })
}

// Paginate: PostgREST silently caps a plain .select() at 1000 rows, which
// would leave companies beyond the cap without deadlines.
async function fetchAllDeadlineSettings(supabase: SupabaseClient): Promise<DeadlineSettingsRow[]> {
  return fetchAllRows<DeadlineSettingsRow>(({ from, to }) =>
    supabase
      .from('company_settings')
      .select(DEADLINE_SETTINGS_SELECT)
      .order('company_id', { ascending: true })
      .range(from, to),
  )
}

/**
 * Generate tax deadlines for the new year for every company.
 */
export async function generateNewYearDeadlines(
  supabase: SupabaseClient
): Promise<{ usersProcessed: number; totalCreated: number }> {
  const newYear = new Date().getFullYear()
  const allSettings = await fetchAllDeadlineSettings(supabase)

  let usersProcessed = 0
  let totalCreated = 0

  for (const settings of allSettings) {
    try {
      const result = await generateTaxDeadlinesForUser(
        supabase,
        settings.company_id,
        toDeadlineSettings(settings),
        [newYear, newYear + 1]
      )
      usersProcessed++
      totalCreated += result.created
    } catch (err) {
      log.error(`Error generating deadlines for company ${settings.company_id}:`, err)
    }
  }

  return { usersProcessed, totalCreated }
}

/**
 * Repair companies whose upcoming system tax deadlines are missing or carry
 * dates from superseded schedule logic.
 */
export async function backfillMissingTaxDeadlines(
  supabase: SupabaseClient,
): Promise<{ companiesScanned: number; companiesRepaired: number; totalCreated: number }> {
  // Window starts a year back, not today: completed rows with a superseded
  // (already passed) due date must still count as satisfied, otherwise the
  // repair loop flags the company forever while the generator (correctly)
  // refuses to recreate a filed obligation. Matches the generator's own
  // completed-row floor.
  const pastFloor = `${new Date().getFullYear() - 1}-01-01`
  const [allSettings, upcomingDeadlineRows] = await Promise.all([
    fetchAllDeadlineSettings(supabase),
    fetchAllRows<UpcomingDeadlineCompanyRow>(({ from, to }) =>
      supabase
        .from('deadlines')
        .select('id, company_id, tax_deadline_type, tax_period, due_date, is_completed, dismissed_at')
        .eq('source', 'system')
        .eq('deadline_type', 'tax')
        .gte('due_date', pastFloor)
        .order('id', { ascending: true })
        .range(from, to),
    ),
  ])

  const missingSettings = findSettingsMissingUpcomingDeadlines(allSettings, upcomingDeadlineRows)
  let companiesRepaired = 0
  let totalCreated = 0

  for (const settings of missingSettings) {
    try {
      const result = await regenerateTaxDeadlinesForUser(
        supabase,
        settings.company_id,
        toDeadlineSettings(settings),
      )
      companiesRepaired++
      totalCreated += result.created
    } catch (err) {
      log.error(`Error repairing deadlines for company ${settings.company_id}:`, err)
    }
  }

  return {
    companiesScanned: allSettings.length,
    companiesRepaired,
    totalCreated,
  }
}
