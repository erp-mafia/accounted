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
  type TaxAssessmentNoticeForDeadline,
} from './deadline-config'
import { adjustDeadlineToNextBankingDay } from './swedish-holidays'
import { formatDateISO } from '@/lib/calendar/utils'

/**
 * Rolling generation horizons. Recurring skattekonto obligations (monthly
 * and quarterly filings) only generate ~6 months ahead: nobody acts on a
 * moms deadline 14 months out, and the rows just bury the near-term list.
 * Annual obligations keep 12 months so year-end planning still gets
 * warning. The daily backfill cron rolls the window forward: a row is
 * created once its due date enters the horizon.
 *
 * The same cutoff MUST apply in generateTaxDeadlinesForUser and
 * getExpectedUpcomingDeadlineKeys: if detection expected a row the
 * generator refuses to create, the nightly cron would regenerate (and
 * status-reset) the company every day forever.
 */
export const RECURRING_HORIZON_DAYS = 183
export const ANNUAL_HORIZON_DAYS = 365

/** Types on the recurring horizon; anything not listed defaults to annual. */
const RECURRING_HORIZON_TYPES = new Set<TaxDeadlineType>([
  'moms_monthly',
  'moms_quarterly',
  'f_skatt',
  'arbetsgivardeklaration',
  'skatteinbetalning',
  'periodisk_sammanstallning',
  'oss_quarterly',
  'ioss_monthly',
  'intrastat_monthly',
  'punktskatt_monthly',
])

function horizonEndFor(type: TaxDeadlineType, today: Date): Date {
  const days = RECURRING_HORIZON_TYPES.has(type)
    ? RECURRING_HORIZON_DAYS
    : ANNUAL_HORIZON_DAYS
  const end = new Date(today)
  end.setDate(end.getDate() + days)
  return end
}

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
  'kontrolluppgifter_enabled',
  'rot_rut_enabled',
  'oss_enabled',
  'ioss_enabled',
  'intrastat_enabled',
  'punktskatt_enabled',
  'fyllnadsinbetalning_enabled',
] as const

export const DEADLINE_SETTINGS_SELECT =
  'company_id, entity_type, moms_period, f_skatt, preliminary_tax_monthly, vat_registered, pays_salaries, employer_registered, employer_seasonal, fiscal_year_start_month, vat_taxable_base_over_40m, vat_has_eu_trade, vat_filing_method, periodisk_sammanstallning_enabled, periodisk_sammanstallning_period, periodisk_sammanstallning_filing_method, kontrolluppgifter_enabled, rot_rut_enabled, oss_enabled, ioss_enabled, intrastat_enabled, punktskatt_enabled, fyllnadsinbetalning_enabled' as const

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
    kontrolluppgifter_enabled: settings.kontrolluppgifter_enabled ?? false,
    rot_rut_enabled: settings.rot_rut_enabled ?? false,
    rot_rut_payment_years: settings.rot_rut_payment_years,
    oss_enabled: settings.oss_enabled ?? false,
    ioss_enabled: settings.ioss_enabled ?? false,
    intrastat_enabled: settings.intrastat_enabled ?? false,
    punktskatt_enabled: settings.punktskatt_enabled ?? false,
    fyllnadsinbetalning_enabled: settings.fyllnadsinbetalning_enabled ?? false,
    tax_assessment_notices: settings.tax_assessment_notices,
  }
}

interface TaxAssessmentNoticeRow {
  id: string
  company_id: string
  decision_type: 'final' | 'reassessment'
  payment_due_date: string
  fiscal_periods: { name: string } | Array<{ name: string }> | null
}

async function fetchActiveTaxAssessmentNotices(
  supabase: SupabaseClient,
  companyId?: string,
): Promise<TaxAssessmentNoticeRow[]> {
  return fetchAllRows<TaxAssessmentNoticeRow>(({ from, to }) => {
    let query = supabase
      .from('tax_assessment_notices')
      .select('id, company_id, decision_type, payment_due_date, fiscal_periods(name)')
      .is('archived_at', null)
      .order('id', { ascending: true })
      .range(from, to)

    if (companyId) query = query.eq('company_id', companyId)
    return query
  })
}

function toDeadlineNotice(row: TaxAssessmentNoticeRow): TaxAssessmentNoticeForDeadline {
  const fiscalPeriod = Array.isArray(row.fiscal_periods)
    ? row.fiscal_periods[0]
    : row.fiscal_periods
  return {
    id: row.id,
    fiscalPeriodName: fiscalPeriod?.name ?? '',
    decisionType: row.decision_type,
    paymentDueDate: row.payment_due_date,
  }
}

async function hydrateTaxAssessmentNotices(
  supabase: SupabaseClient,
  settingsRows: DeadlineSettingsRow[],
): Promise<DeadlineSettingsRow[]> {
  const notices = await fetchActiveTaxAssessmentNotices(supabase)
  const byCompany = new Map<string, TaxAssessmentNoticeForDeadline[]>()
  for (const notice of notices) {
    const current = byCompany.get(notice.company_id) ?? []
    current.push(toDeadlineNotice(notice))
    byCompany.set(notice.company_id, current)
  }
  return settingsRows.map((settings) => ({
    ...settings,
    tax_assessment_notices: byCompany.get(settings.company_id) ?? [],
  }))
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
 * What a regenerated system deadline inherits from the row it replaces.
 *
 * Regeneration deletes and reinserts, so anything not carried across here is
 * silently discarded. ONE rule decides the split, not a list of special
 * cases: **the generator owns what the statute decides, the row owns every
 * mark a person put on it.** The template decides which obligation this is,
 * what it is called, when it falls due and which report it opens; the notes,
 * the clock time, the priority flag and the manually advanced status are the
 * user's, and they survive.
 *
 * Inherited (user-owned or system state):
 * - `notes`, `due_time`, `customer_id`: the generator never writes these, so
 *   a non-null value can only have come from the deadline editor.
 * - `priority`: the editor's only other non-statutory field.
 * - `status` + `status_changed_at`: only when the stored status is one a
 *   human set (see MANUAL_STATUSES); the date-derived ones are recomputed.
 *
 * Deliberately NOT inherited, so a corrected template still reaches rows
 * nobody touched:
 * - `title`, `due_date`: statutory. A law change, a schedule fix or a
 *   banking-day correction must propagate. `due_date` additionally forms the
 *   backfill identity (`type:period:due_date`), so a preserved divergent date
 *   would make findSettingsMissingUpcomingDeadlines flag the company on every
 *   cron run without ever converging.
 * - `deadline_type`: the backfill query filters on `deadline_type = 'tax'`.
 * - `linked_report_type`, `linked_report_period`, `tax_assessment_notice_id`:
 *   derived from the obligation, no user surface writes them.
 * - `reminder_offsets`: template data today, because no surface lets a user
 *   change it. Move it into the inherited set the day one does.
 * - `user_id`: system deadlines are company-owned; migration
 *   20260704100000 made the column nullable precisely so the generator can
 *   leave it unset.
 *
 * The schema cannot distinguish "the user edited this field" from "the
 * template changed under an untouched row" for the statutory columns: nothing
 * records the template's value at creation time, and the `deadlines_updated_at`
 * trigger bumps `updated_at` on every automatic status sweep too. Rather than
 * guess, the statutory columns always take the template value, which is the
 * conservative choice for a compliance surface: a stale filing date is a
 * missed filing, a lost title edit is cosmetic.
 */
const SUPERSEDED_ROW_SELECT =
  'tax_deadline_type, tax_period, status, status_changed_at, notes, due_time, priority, customer_id' as const

interface SupersededDeadlineRow {
  tax_deadline_type: string | null
  tax_period: string | null
  status: DeadlineStatus | null
  status_changed_at: string | null
  notes: string | null
  due_time: string | null
  priority: 'critical' | 'important' | 'normal' | null
  customer_id: string | null
}

/**
 * Statuses only a human sets. `upcoming`, `action_needed` and `overdue` are
 * derived from the due date by the nightly status engine, so a replacement
 * row recomputes them; these three represent work the user reported and are
 * carried across. (`confirmed` also sets `is_completed`, so such a row is
 * never replaced in the first place; it is listed for completeness.)
 */
const MANUAL_STATUSES = new Set<DeadlineStatus>(['in_progress', 'submitted', 'confirmed'])

/**
 * Generate all tax deadlines for a user based on their company settings
 */
export async function generateTaxDeadlinesForUser(
  supabase: SupabaseClient,
  companyId: string,
  settings: CompanySettingsForDeadlines,
  years: number[] = []
): Promise<{ created: number; deleted: number }> {
  if (settings.tax_assessment_notices === undefined) {
    const notices = await fetchActiveTaxAssessmentNotices(supabase, companyId)
    settings = {
      ...settings,
      tax_assessment_notices: notices.map(toDeadlineNotice),
    }
  }

  // Recurring deadlines use the current rolling window. Explicit tax notices
  // also include their own due-date years so a newly entered overdue notice is
  // represented instead of disappearing only because its exact date has passed.
  if (years.length === 0) {
    const currentYear = new Date().getFullYear()
    const noticeYears = (settings.tax_assessment_notices ?? [])
      .map((notice) => Number(notice.paymentDueDate.slice(0, 4)))
      .filter(Number.isInteger)
    years = Array.from(new Set([currentYear, currentYear + 1, ...noticeYears]))
  }

  // The ROT/RUT begäran deadline is data-dependent: a row for year Y only
  // exists when Y has paid ROT/RUT invoices (Lag 2009:194 8 §, payment
  // dates). Resolve the payment years here, in the one place that inserts
  // and deletes rows, so every generation path agrees. Callers that pass
  // pure settings (backfill detection) leave the field undefined and simply
  // never expect rot_rut_begaran rows.
  if (settings.rot_rut_enabled && settings.rot_rut_payment_years === undefined) {
    const rotRutRows = await fetchAllRows<{ paid_at: string | null }>(({ from, to }) =>
      supabase
        .from('invoices')
        .select('paid_at')
        .eq('company_id', companyId)
        .gt('deduction_total', 0)
        .not('paid_at', 'is', null)
        .order('id', { ascending: true })
        .range(from, to),
    )
    settings = {
      ...settings,
      rot_rut_payment_years: Array.from(
        new Set(
          rotRutRows
            .filter((row) => row.paid_at)
            .map((row) => Number(String(row.paid_at).slice(0, 4))),
        ),
      ),
    }
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

  // Everything the user (or the status flow) put on the rows about to be
  // replaced, keyed by the same tax_deadline_type:tax_period identity the
  // completed/dismissed check uses. See SUPERSEDED_ROW_SELECT for the rule.
  const { data: supersededRows, error: supersededError } = await supabase
    .from('deadlines')
    .select(SUPERSEDED_ROW_SELECT)
    .eq('company_id', companyId)
    .eq('source', 'system')
    .eq('is_completed', false)
    .is('dismissed_at', null)

  if (supersededError) {
    log.error('Error fetching superseded deadlines:', supersededError)
    throw supersededError
  }

  const supersededByKey = new Map<string, SupersededDeadlineRow>()
  for (const row of (supersededRows ?? []) as SupersededDeadlineRow[]) {
    supersededByKey.set(`${row.tax_deadline_type}:${row.tax_period}`, row)
  }

  // Generate new deadlines. Every row carries the identical key set: a
  // PostgREST bulk insert rejects objects whose keys differ (PGRST102), so
  // inherited columns are always present, null when there is nothing to
  // inherit.
  const nowIso = new Date().toISOString()
  const deadlines: Array<{
    company_id: string
    title: string
    due_date: string
    due_time: string | null
    deadline_type: 'tax'
    priority: 'critical' | 'important' | 'normal'
    is_completed: boolean
    source: 'system'
    status: DeadlineStatus
    status_changed_at: string
    notes: string | null
    customer_id: string | null
    tax_deadline_type: TaxDeadlineType
    tax_period: string
    linked_report_type: string | null
    linked_report_period: Record<string, unknown> | null
    reminder_offsets: number[]
    is_auto_generated: boolean
    tax_assessment_notice_id: string | null
  }> = []

  for (const config of applicableConfigs) {
    const horizonEnd = horizonEndFor(config.type, today)
    for (const year of years) {
      const instances = config.generateDates(year, settings)

      for (const instance of instances) {
        // Create the raw deadline date
        const rawDate = new Date(instance.year, instance.month, instance.day)

        // Adjust for banking days (skip weekends and holidays). EU-law
        // deadlines (OSS/IOSS) opt out: their dates stand on weekends.
        const adjustedDate = config.skipBankingDayAdjustment
          ? rawDate
          : adjustDeadlineToNextBankingDay(rawDate)
        const dueDate = formatDateISO(adjustedDate)

        // Skip if the deadline is in the past
        if (adjustedDate < today && !instance.taxAssessmentNoticeId) {
          continue
        }

        // Skip rows beyond the rolling horizon; the daily backfill creates
        // them once they come into view.
        if (adjustedDate > horizonEnd) {
          continue
        }

        const deadlineKey = `${config.type}:${instance.period}`
        if (completedKeys.has(deadlineKey)) {
          continue
        }

        // The row this one replaces, if any: its user-owned columns and its
        // manually reported progress carry across (see SUPERSEDED_ROW_SELECT).
        const superseded = supersededByKey.get(deadlineKey)

        // Determine initial status based on days until deadline, keeping a
        // manually reported status from the row being replaced.
        const daysUntil = Math.ceil((adjustedDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
        const keepsManualStatus =
          superseded?.status != null && MANUAL_STATUSES.has(superseded.status)
        const status: DeadlineStatus = keepsManualStatus
          ? superseded!.status!
          : daysUntil <= 14 ? 'action_needed' : 'upcoming'

        // Generate title from template
        const title = config.titleTemplate.replace('{periodLabel}', instance.periodLabel)

        // Create linked report period data
        const linkedReportPeriod = createLinkedReportPeriod(instance, config.type)

        deadlines.push({
          company_id: companyId,
          title,
          due_date: dueDate,
          due_time: superseded?.due_time ?? null,
          deadline_type: 'tax',
          priority: superseded?.priority ?? config.priority,
          is_completed: false,
          source: 'system',
          status,
          // Only meaningful alongside a carried status; a recomputed status
          // changed just now.
          status_changed_at: (keepsManualStatus ? superseded!.status_changed_at : null) ?? nowIso,
          notes: superseded?.notes ?? null,
          customer_id: superseded?.customer_id ?? null,
          tax_deadline_type: config.type,
          tax_period: instance.period,
          linked_report_type: config.linkedReportType,
          linked_report_period: linkedReportPeriod,
          reminder_offsets: [14, 7, 1, 0],
          is_auto_generated: true,
          tax_assessment_notice_id: instance.taxAssessmentNoticeId ?? null,
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
  //
  // An obligation the settings no longer produce is deleted even when the
  // user had edited it. Its notes go with it, and that is the right trade:
  // the settings change is the user's own explicit statement that the
  // obligation does not apply, and a deadlines page that keeps showing a
  // momsdeklaration to a company that deregistered from moms is worse than a
  // lost note. Notes on obligations that still apply survive, which is the
  // case this preservation is about; anything worth keeping past a settings
  // change belongs in a manual (source='user') deadline, which the generator
  // never touches.
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
    const horizonEnd = horizonEndFor(config.type, today)
    for (const year of years) {
      for (const instance of config.generateDates(year, settings)) {
        const rawDate = new Date(instance.year, instance.month, instance.day)
        const adjustedDate = config.skipBankingDayAdjustment
          ? rawDate
          : adjustDeadlineToNextBankingDay(rawDate)
        // Same window as the generator: past rows and rows beyond the
        // rolling horizon are never expected.
        if (adjustedDate >= today && adjustedDate <= horizonEnd) {
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
  const allSettings = await hydrateTaxAssessmentNotices(
    supabase,
    await fetchAllDeadlineSettings(supabase),
  )

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
  const [rawSettings, upcomingDeadlineRows] = await Promise.all([
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
  const allSettings = await hydrateTaxAssessmentNotices(supabase, rawSettings)

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
