/**
 * Reads and writes of the momsdeklaration filing record (issue #2746). See
 * filing-record.ts for why the record is the period's completed moms deadline.
 *
 * Server-only: takes a Supabase client (cookie session for the dashboard
 * routes, service role for the v1 surface) and filters every query by
 * company_id, RLS or not.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getVatDeadlineForPeriod } from '@/lib/tax/deadline-config'
import { adjustDeadlineToNextBankingDay } from '@/lib/tax/swedish-holidays'
import { formatDateISO } from '@/lib/calendar/utils'
import { todayIsoStockholm } from '@/lib/dates/iso'
import {
  VAT_FILING_DEADLINE_TYPES,
  parseVatFilingReference,
  vatFilingDateProblem,
  vatFilingDeadlineType,
  vatFilingPeriodFromTaxPeriod,
  vatFilingTaxPeriod,
  withVatFilingReference,
  type VatFilingPeriodType,
  type VatFilingRecord,
} from './filing-record'

export type VatFilingErrorCode =
  | 'VAT_FILING_PERIOD_NOT_ENDED'
  | 'VAT_FILING_DATE_BEFORE_PERIOD_END'
  | 'VAT_FILING_DATE_IN_FUTURE'
  | 'VAT_FILING_NOT_FOUND'
  | 'VAT_FILING_CONFIRMED_BY_SKATTEVERKET'

export interface VatFilingPeriodInput {
  periodType: VatFilingPeriodType
  year: number
  period: number
}

export interface MarkVatPeriodFiledInput extends VatFilingPeriodInput {
  /** Swedish calendar date the declaration was filed, `YYYY-MM-DD`. */
  filedOn: string
  /** Skatteverket's reference: undefined keeps the stored one, null clears it. */
  reference?: string | null
  /** Attribution on a row this call creates; never overwrites an existing one. */
  userId?: string | null
}

export type MarkVatPeriodFiledResult =
  | {
      ok: true
      record: VatFilingRecord
      /** True when no deadline row existed for the period and one was created. */
      created: boolean
      /** False when the period was already confirmed at Skatteverket and left as is. */
      changed: boolean
    }
  | { ok: false; code: VatFilingErrorCode }

export type UnmarkVatPeriodFiledResult =
  | { ok: true; deadline_id: string }
  | { ok: false; code: 'VAT_FILING_NOT_FOUND' | 'VAT_FILING_CONFIRMED_BY_SKATTEVERKET' }

/**
 * The row shape every query here selects. The select strings are repeated as
 * literals at each call site on purpose: tests/schema/no-phantom-columns
 * checks selected columns against the schema and cannot see through a
 * shared constant.
 */
interface DeadlineRow {
  id: string
  tax_deadline_type: string | null
  tax_period: string | null
  is_completed: boolean | null
  completed_at: string | null
  status: string | null
  notes: string | null
  due_date: string | null
}

/**
 * A manual filing is stored at noon UTC on the filed date so the Stockholm
 * calendar day read back is the day the user entered, whatever the server's
 * clock offset. Rows completed by the kvittens cron carry the real instant.
 */
function filedOnToCompletedAt(filedOn: string): string {
  return `${filedOn}T12:00:00.000Z`
}

function toRecord(row: DeadlineRow): VatFilingRecord | null {
  const parsed = vatFilingPeriodFromTaxPeriod(row.tax_period)
  if (!parsed || !row.completed_at) return null
  return {
    deadline_id: row.id,
    ...parsed,
    tax_period: row.tax_period as string,
    filed_on: todayIsoStockholm(new Date(row.completed_at)),
    source: row.status === 'confirmed' ? 'skatteverket' : 'manual',
    reference: parseVatFilingReference(row.notes),
  }
}

/** Every calendar VAT period the company has on record as filed, newest first. */
export async function listVatFilings(
  supabase: SupabaseClient,
  companyId: string,
): Promise<VatFilingRecord[]> {
  const { data, error } = await supabase
    .from('deadlines')
    .select('id, tax_deadline_type, tax_period, is_completed, completed_at, status, notes, due_date')
    .eq('company_id', companyId)
    .in('tax_deadline_type', [...VAT_FILING_DEADLINE_TYPES])
    .eq('is_completed', true)
    .is('dismissed_at', null)
    .order('completed_at', { ascending: false })
  if (error) throw error
  const records: VatFilingRecord[] = []
  for (const row of (data ?? []) as DeadlineRow[]) {
    const record = toRecord(row)
    if (record) records.push(record)
  }
  return records
}

/**
 * The deadline row that represents the period, completed or not. Both moms
 * cadences are searched on purpose: tax_period formats differ per cadence,
 * so the period key alone is unambiguous, and a row left behind by a cadence
 * change is still the period's record.
 */
async function findPeriodRow(
  supabase: SupabaseClient,
  companyId: string,
  input: VatFilingPeriodInput,
): Promise<DeadlineRow | null> {
  const { data, error } = await supabase
    .from('deadlines')
    .select('id, tax_deadline_type, tax_period, is_completed, completed_at, status, notes, due_date')
    .eq('company_id', companyId)
    .in('tax_deadline_type', [...VAT_FILING_DEADLINE_TYPES])
    .eq('tax_period', vatFilingTaxPeriod(input.periodType, input.year, input.period))
    .is('dismissed_at', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return (data as DeadlineRow | null) ?? null
}

/**
 * Record that the period's momsdeklaration has been filed, outside the
 * Skatteverket connection (skatteverket.se by hand, another system, an
 * ombud). Completes the period's moms deadline with status 'submitted'; when
 * the company has no deadline row for the period (deadlines never generated,
 * or the period predates the generator's window) one is created so the
 * record exists either way. The generator keeps completed rows, so the
 * record survives regeneration.
 *
 * A period already confirmed at Skatteverket (kvittens observed by the cron)
 * is returned unchanged: the receipt is the stronger fact.
 */
export async function markVatPeriodFiled(
  supabase: SupabaseClient,
  companyId: string,
  input: MarkVatPeriodFiledInput,
  opts: { today?: string } = {},
): Promise<MarkVatPeriodFiledResult> {
  const today = opts.today ?? todayIsoStockholm()
  const problem = vatFilingDateProblem(input, today)
  if (problem) return { ok: false, code: problem }

  const existing = await findPeriodRow(supabase, companyId, input)
  const now = new Date().toISOString()

  if (existing) {
    if (existing.is_completed && existing.status === 'confirmed') {
      const record = toRecord(existing)
      if (record) return { ok: true, record, created: false, changed: false }
    }
    const { data, error } = await supabase
      .from('deadlines')
      .update({
        is_completed: true,
        completed_at: filedOnToCompletedAt(input.filedOn),
        status: 'submitted',
        status_changed_at: now,
        notes: withVatFilingReference(existing.notes, input.reference),
      })
      .eq('id', existing.id)
      .eq('company_id', companyId)
      .select('id, tax_deadline_type, tax_period, is_completed, completed_at, status, notes, due_date')
      .single()
    if (error) throw error
    const record = toRecord(data as DeadlineRow)
    if (!record) throw new Error('vat filing: updated deadline row did not read back as a filing')
    return { ok: true, record, created: false, changed: true }
  }

  // No row: build one the way the generator would (same title, due date and
  // linked period), already completed.
  const { data: settings, error: settingsError } = await supabase
    .from('company_settings')
    .select('vat_taxable_base_over_40m')
    .eq('company_id', companyId)
    .maybeSingle()
  if (settingsError) throw settingsError
  const instance = getVatDeadlineForPeriod(input.periodType, input.year, input.period, {
    vat_taxable_base_over_40m:
      (settings as { vat_taxable_base_over_40m?: boolean | null } | null)
        ?.vat_taxable_base_over_40m === true,
  })
  if (!instance) throw new Error('vat filing: no deadline instance for a calendar VAT period')
  const dueDate = formatDateISO(
    adjustDeadlineToNextBankingDay(new Date(instance.year, instance.month, instance.day)),
  )
  const { data, error } = await supabase
    .from('deadlines')
    .insert({
      company_id: companyId,
      user_id: input.userId ?? null,
      title: `Momsdeklaration ${instance.periodLabel}`,
      due_date: dueDate,
      deadline_type: 'tax',
      priority: 'important',
      is_completed: true,
      completed_at: filedOnToCompletedAt(input.filedOn),
      source: 'system',
      status: 'submitted',
      status_changed_at: now,
      notes: withVatFilingReference(null, input.reference),
      tax_deadline_type: vatFilingDeadlineType(input.periodType),
      tax_period: instance.period,
      linked_report_type: 'vat',
      linked_report_period:
        input.periodType === 'monthly'
          ? { year: input.year, month: input.period }
          : { year: input.year, quarter: input.period },
      reminder_offsets: [14, 7, 1, 0],
      is_auto_generated: true,
    })
    .select('id, tax_deadline_type, tax_period, is_completed, completed_at, status, notes, due_date')
    .single()
  if (error) throw error
  const record = toRecord(data as DeadlineRow)
  if (!record) throw new Error('vat filing: inserted deadline row did not read back as a filing')
  return { ok: true, record, created: true, changed: true }
}

/**
 * Undo a manual filing mark: the deadline goes back to pending and the
 * reference line leaves its notes. A filing confirmed at Skatteverket is
 * refused: the kvittens is a fact this action has no standing to erase.
 */
export async function unmarkVatPeriodFiled(
  supabase: SupabaseClient,
  companyId: string,
  input: VatFilingPeriodInput,
  opts: { today?: string } = {},
): Promise<UnmarkVatPeriodFiledResult> {
  const existing = await findPeriodRow(supabase, companyId, input)
  if (!existing || !existing.is_completed) return { ok: false, code: 'VAT_FILING_NOT_FOUND' }
  if (existing.status === 'confirmed') {
    return { ok: false, code: 'VAT_FILING_CONFIRMED_BY_SKATTEVERKET' }
  }
  const today = opts.today ?? todayIsoStockholm()
  const { error } = await supabase
    .from('deadlines')
    .update({
      is_completed: false,
      completed_at: null,
      // The nightly status engine only advances pending statuses, so the
      // row is put straight where that engine would have it.
      status: existing.due_date && existing.due_date < today ? 'overdue' : 'upcoming',
      status_changed_at: new Date().toISOString(),
      notes: withVatFilingReference(existing.notes, null),
    })
    .eq('id', existing.id)
    .eq('company_id', companyId)
  if (error) throw error
  return { ok: true, deadline_id: existing.id }
}
