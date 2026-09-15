import type { SupabaseClient } from '@supabase/supabase-js'

export class SIELegacyReviewRequiredError extends Error {
  readonly code = 'SIE_IMPORT_LEGACY_REVIEW_REQUIRED'
  constructor() {
    super('Äldre SIE-importer behöver granskas. Öppna importhistoriken och välj Granska för importen.')
  }
}

export type SIELegacyPeriodResolution = 'linked' | 'exact_dates' | 'missing' | 'ambiguous' | 'conflicting'

interface RecoveryPeriod {
  id: string
  period_start: string
  period_end: string
  is_closed: boolean
  locked_at: string | null
  import_hold: string | null
}

export interface SIELegacyRecoveryAssessment {
  importId: string
  status: string
  /** A stored pointer is not proof that the original file is readable or unchanged. */
  hasArchiveReference: boolean
  periodResolution: SIELegacyPeriodResolution
  period: RecoveryPeriod | null
  companyLock: { known: boolean; through: string | null }
  /** Period-wide observations, never ownership or reset/undo eligibility. Includes drafts. */
  entries: { all: number; posted: number; importOrOpening: number } | null
  assessedAt: string
}

const PERIOD_FIELDS = 'id,period_start,period_end,is_closed,locked_at,import_hold'

/**
 * Legacy status does not prove whether the old import transaction committed.
 * These separate reads are an advisory overview, not an atomic repair preview.
 * Even an empty period does not authorize clearing metadata or retrying.
 */
export async function assessLegacySIEImport(
  supabase: SupabaseClient,
  companyId: string,
  importId: string,
): Promise<SIELegacyRecoveryAssessment | null> {
  const { data: row, error } = await supabase.from('sie_imports')
    .select('id,status,job_state,fiscal_period_id,fiscal_year_start,fiscal_year_end,file_storage_path')
    .eq('company_id', companyId).eq('id', importId).maybeSingle()
  if (error) throw error
  if (!row) return null
  if (row.job_state) {
    throw Object.assign(new Error('Use the tracked SIE job to review this import.'), { code: 'CONFLICT' })
  }

  let period: RecoveryPeriod | null = null
  let periodResolution: SIELegacyPeriodResolution = 'missing'
  if (row.fiscal_period_id) {
    const result = await supabase.from('fiscal_periods').select(PERIOD_FIELDS)
      .eq('company_id', companyId).eq('id', row.fiscal_period_id).maybeSingle()
    if (result.error) throw result.error
    if (result.data) {
      // Contradictory metadata must not silently select one of two years.
      const conflict = row.fiscal_year_start && row.fiscal_year_start !== result.data.period_start ||
        row.fiscal_year_end && row.fiscal_year_end !== result.data.period_end
      periodResolution = conflict ? 'conflicting' : 'linked'
      if (!conflict) period = result.data as RecoveryPeriod
    }
  } else if (row.fiscal_year_start && row.fiscal_year_end) {
    const result = await supabase.from('fiscal_periods').select(PERIOD_FIELDS)
      .eq('company_id', companyId).eq('period_start', row.fiscal_year_start)
      .eq('period_end', row.fiscal_year_end).limit(2)
    if (result.error) throw result.error
    if (result.data?.length === 1) {
      period = result.data[0] as RecoveryPeriod
      periodResolution = 'exact_dates'
    } else if (result.data && result.data.length > 1) {
      periodResolution = 'ambiguous'
    }
  }

  const settings = await supabase.from('company_settings').select('bookkeeping_locked_through')
    .eq('company_id', companyId).maybeSingle()
  if (settings.error) throw settings.error

  let entries: SIELegacyRecoveryAssessment['entries'] = null
  if (period) {
    const periodId = period.id
    // Exact HEAD counts avoid the PostgREST row cap and loading financial data.
    const countEntries = () => supabase.from('journal_entries').select('id', { count: 'exact', head: true })
      .eq('company_id', companyId).eq('fiscal_period_id', periodId)
    const counts = await Promise.all([
      countEntries(),
      countEntries().eq('status', 'posted'),
      countEntries().in('source_type', ['import', 'opening_balance']),
    ])
    for (const result of counts) {
      if (result.error) throw result.error
      if (result.count == null) throw new Error('SIE recovery entry count is unavailable.')
    }
    entries = { all: counts[0].count!, posted: counts[1].count!, importOrOpening: counts[2].count! }
  }

  return {
    importId: row.id,
    status: row.status,
    hasArchiveReference: Boolean(row.file_storage_path),
    periodResolution,
    period,
    companyLock: { known: settings.data !== null, through: settings.data?.bookkeeping_locked_through ?? null },
    entries,
    assessedAt: new Date().toISOString(),
  }
}
