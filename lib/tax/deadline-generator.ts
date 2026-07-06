/**
 * Deadline generator - creates tax deadlines based on company settings
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
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
  'vat_registered',
  'pays_salaries',
  'fiscal_year_start_month',
] as const

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

  const startDate = `${Math.min(...years)}-01-01`
  const endDate = `${Math.max(...years)}-12-31`

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
        const today = new Date()
        today.setHours(0, 0, 0, 0)
        if (adjustedDate < today) {
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

  // Insert the replacement rows BEFORE deleting the old set. A failed insert
  // then leaves the previous deadlines intact — the old delete-first order
  // meant any insert failure (like the 23502 user_id regression) wiped the
  // company's tax deadlines without replacing them.
  let newIds: string[] = []
  if (deadlines.length > 0) {
    const { data: insertedData, error: insertError } = await supabase
      .from('deadlines')
      .insert(deadlines)
      .select('id')

    if (insertError) {
      log.error('Error inserting deadlines:', insertError)
      throw insertError
    }
    newIds = (insertedData ?? []).map((d: { id: string }) => d.id)
  }

  // Delete the superseded system-generated deadlines for these years,
  // excluding the rows just inserted.
  let deleteQuery = supabase
    .from('deadlines')
    .delete()
    .eq('company_id', companyId)
    .eq('source', 'system')
    .gte('due_date', startDate)
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
    created: deadlines.length,
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

/**
 * Generate tax deadlines for the new year (called by annual cron job)
 */
export async function generateNewYearDeadlines(
  supabase: SupabaseClient
): Promise<{ usersProcessed: number; totalCreated: number }> {
  const newYear = new Date().getFullYear()

  // Fetch all companies with company settings
  const { data: allSettings, error } = await supabase
    .from('company_settings')
    .select('company_id, entity_type, moms_period, f_skatt, vat_registered, pays_salaries, fiscal_year_start_month')

  if (error) {
    log.error('Error fetching company settings:', error)
    throw error
  }

  let usersProcessed = 0
  let totalCreated = 0

  for (const settings of allSettings || []) {
    try {
      const result = await generateTaxDeadlinesForUser(
        supabase,
        settings.company_id,
        {
          entity_type: settings.entity_type,
          moms_period: settings.moms_period,
          f_skatt: settings.f_skatt,
          vat_registered: settings.vat_registered,
          pays_salaries: settings.pays_salaries ?? false,
          fiscal_year_start_month: settings.fiscal_year_start_month,
        },
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
