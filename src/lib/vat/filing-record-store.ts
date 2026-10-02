/**
 * Reads and writes of the momsdeklaration filing record (issues #2746,
 * #2786). See filing-record.ts for why the record is the period's completed
 * moms deadline and how a period is keyed.
 *
 * Server-only: takes a Supabase client (cookie session for the dashboard
 * routes, service role for the v1 and MCP doors) and filters every query by
 * company_id, RLS or not.
 *
 * Every entry point reads the company's VAT settings first: the fiscal-year
 * end month places a yearly period (its tax_period label and its dates), and
 * the rest builds a missing deadline row the way the generator would. The
 * three cadences then take one path; nothing below branches on yearly.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getVatDeadlineForPeriod, type VatDeadlineCalculationSettings } from '@/lib/tax/deadline-config'
import { createLinkedReportPeriod } from '@/lib/tax/deadline-generator'
import { adjustDeadlineToNextBankingDay } from '@/lib/tax/swedish-holidays'
import { formatDateISO } from '@/lib/calendar/utils'
import { todayIsoStockholm } from '@/lib/dates/iso'
import {
  VAT_FILING_DEADLINE_TYPES,
  parseVatFilingReference,
  vatFilingDateProblem,
  vatFilingDeadlineType,
  vatFilingFiscalYearEndMonth,
  vatFilingLabelFiscalYearEndMonth,
  vatFilingPeriodFromTaxPeriod,
  vatFilingPeriodRange,
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
  // The deadline row changed between the read and the guarded write for a
  // reason other than a Skatteverket confirmation: safe to retry as is.
  | 'CONFLICT'

export interface VatFilingPeriodInput {
  periodType: VatFilingPeriodType
  /** Calendar year of the period; for yearly, the year the räkenskapsår ends. */
  year: number
  /** 1-12 monthly, 1-4 quarterly, 1 yearly. */
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

/** The period as a caller named it, placed in time. */
export interface VatFilingPeriodPlacement {
  period_type: VatFilingPeriodType
  year: number
  period: number
  tax_period: string
  period_start: string
  period_end: string
}

/**
 * What marking would do, without doing it: the dry run of the v1 door and
 * the preview an MCP approver sees. `effect` is `create` (no deadline row
 * yet), `update` (the row is completed or re-dated), or `unchanged` (the
 * period is confirmed at Skatteverket, which a manual mark never relabels).
 */
export type MarkVatPeriodFiledPreview =
  | {
      ok: true
      would_mark: VatFilingPeriodPlacement & { filed_on: string; reference: string | null }
      effect: 'create' | 'update' | 'unchanged'
      current: VatFilingRecord | null
    }
  | { ok: false; code: VatFilingErrorCode }

/** What unmarking would do: the record it would put back to pending. */
export type UnmarkVatPeriodFiledPreview =
  | { ok: true; would_unmark: VatFilingPeriodPlacement; current: VatFilingRecord }
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

/** The company_settings columns a filing needs. */
interface FilingSettingsRow {
  entity_type: string | null
  fiscal_year_start_month: number | null
  vat_taxable_base_over_40m: boolean | null
  vat_has_eu_trade: boolean | null
  vat_filing_method: string | null
}

interface FilingSettings {
  row: FilingSettingsRow | null
  /** Month (1-12) the räkenskapsår ends: places yearly periods. */
  fiscalYearEndMonth: number
}

async function loadFilingSettings(
  supabase: SupabaseClient,
  companyId: string,
): Promise<FilingSettings> {
  const { data, error } = await supabase
    .from('company_settings')
    .select('entity_type, fiscal_year_start_month, vat_taxable_base_over_40m, vat_has_eu_trade, vat_filing_method')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  const row = (data as FilingSettingsRow | null) ?? null
  return { row, fiscalYearEndMonth: vatFilingFiscalYearEndMonth(row) }
}

function placement(input: VatFilingPeriodInput, fiscalYearEndMonth: number): VatFilingPeriodPlacement {
  const range = vatFilingPeriodRange(input.periodType, input.year, input.period, fiscalYearEndMonth)
  return {
    period_type: input.periodType,
    year: input.year,
    period: input.period,
    tax_period: vatFilingTaxPeriod(input.periodType, input.year, input.period, fiscalYearEndMonth),
    period_start: range.start,
    period_end: range.end,
  }
}

/**
 * A manual filing is stored at noon UTC on the filed date so the Stockholm
 * calendar day read back is the day the user entered, whatever the server's
 * clock offset. Rows completed by the kvittens cron carry the real instant.
 */
function filedOnToCompletedAt(filedOn: string): string {
  return `${filedOn}T12:00:00.000Z`
}

function toRecord(row: DeadlineRow, fiscalYearEndMonth: number): VatFilingRecord | null {
  const parsed = vatFilingPeriodFromTaxPeriod(row.tax_period)
  if (!parsed || !row.completed_at) return null
  const taxPeriod = row.tax_period as string
  const range = vatFilingPeriodRange(
    parsed.period_type,
    parsed.year,
    parsed.period,
    vatFilingLabelFiscalYearEndMonth(taxPeriod, fiscalYearEndMonth),
  )
  return {
    deadline_id: row.id,
    ...parsed,
    tax_period: taxPeriod,
    period_start: range.start,
    period_end: range.end,
    filed_on: todayIsoStockholm(new Date(row.completed_at)),
    source: row.status === 'confirmed' ? 'skatteverket' : 'manual',
    reference: parseVatFilingReference(row.notes),
  }
}

/**
 * The record of a filing Skatteverket has confirmed (kvittens observed), or
 * null for any other row state. The one state manual actions must not touch;
 * the guarded updates below filter on its exact negation.
 */
function confirmedRecord(row: DeadlineRow, fiscalYearEndMonth: number): VatFilingRecord | null {
  return row.is_completed && row.status === 'confirmed' ? toRecord(row, fiscalYearEndMonth) : null
}

/** Every VAT period the company has on record as filed, newest first. */
export async function listVatFilings(
  supabase: SupabaseClient,
  companyId: string,
): Promise<VatFilingRecord[]> {
  const [settings, { data, error }] = await Promise.all([
    loadFilingSettings(supabase, companyId),
    supabase
      .from('deadlines')
      .select('id, tax_deadline_type, tax_period, is_completed, completed_at, status, notes, due_date')
      .eq('company_id', companyId)
      .in('tax_deadline_type', [...VAT_FILING_DEADLINE_TYPES])
      .eq('is_completed', true)
      .is('dismissed_at', null)
      .order('completed_at', { ascending: false }),
  ])
  if (error) throw error
  const records: VatFilingRecord[] = []
  for (const row of (data ?? []) as DeadlineRow[]) {
    const record = toRecord(row, settings.fiscalYearEndMonth)
    if (record) records.push(record)
  }
  return records
}

/**
 * The deadline row that represents the period, completed or not. Every moms
 * cadence is searched on purpose: tax_period formats differ per cadence, so
 * the period key alone is unambiguous, and a row left behind by a cadence
 * change is still the period's record.
 */
async function findPeriodRow(
  supabase: SupabaseClient,
  companyId: string,
  input: VatFilingPeriodInput,
  fiscalYearEndMonth: number,
): Promise<DeadlineRow | null> {
  const { data, error } = await supabase
    .from('deadlines')
    .select('id, tax_deadline_type, tax_period, is_completed, completed_at, status, notes, due_date')
    .eq('company_id', companyId)
    .in('tax_deadline_type', [...VAT_FILING_DEADLINE_TYPES])
    .eq('tax_period', vatFilingTaxPeriod(input.periodType, input.year, input.period, fiscalYearEndMonth))
    .is('dismissed_at', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return (data as DeadlineRow | null) ?? null
}

/**
 * The shared first half of marking: the date rules, then the period's row.
 * The dry run stops here; the write continues from the same state.
 */
async function resolveMark(
  supabase: SupabaseClient,
  companyId: string,
  input: MarkVatPeriodFiledInput,
  today: string,
): Promise<
  | { ok: false; code: VatFilingErrorCode }
  | { ok: true; settings: FilingSettings; existing: DeadlineRow | null }
> {
  const settings = await loadFilingSettings(supabase, companyId)
  const problem = vatFilingDateProblem(input, today, settings.fiscalYearEndMonth)
  if (problem) return { ok: false, code: problem }
  const existing = await findPeriodRow(supabase, companyId, input, settings.fiscalYearEndMonth)
  return { ok: true, settings, existing }
}

/**
 * What markVatPeriodFiled would do, with the same checks and reads and no
 * write: the refusal the real call would give, or the record it would leave.
 */
export async function previewMarkVatPeriodFiled(
  supabase: SupabaseClient,
  companyId: string,
  input: MarkVatPeriodFiledInput,
  opts: { today?: string } = {},
): Promise<MarkVatPeriodFiledPreview> {
  const resolved = await resolveMark(supabase, companyId, input, opts.today ?? todayIsoStockholm())
  if (!resolved.ok) return resolved
  const { settings, existing } = resolved
  const endMonth = settings.fiscalYearEndMonth
  const current = existing?.is_completed ? toRecord(existing, endMonth) : null
  const confirmed = existing ? confirmedRecord(existing, endMonth) : null
  const reference =
    input.reference === undefined
      ? parseVatFilingReference(existing?.notes)
      : input.reference?.trim() || null
  return {
    ok: true,
    would_mark: { ...placement(input, endMonth), filed_on: input.filedOn, reference },
    effect: confirmed ? 'unchanged' : existing ? 'update' : 'create',
    current,
  }
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
  const resolved = await resolveMark(supabase, companyId, input, opts.today ?? todayIsoStockholm())
  if (!resolved.ok) return resolved
  const { settings, existing } = resolved
  const endMonth = settings.fiscalYearEndMonth
  const now = new Date().toISOString()

  if (existing) {
    const confirmed = confirmedRecord(existing, endMonth)
    if (confirmed) return { ok: true, record: confirmed, created: false, changed: false }

    // The "never overwrite a Skatteverket confirmation" rule lives in the
    // UPDATE's own filter, not only in the read above: the kvittens cron can
    // confirm this very row between our read and our write, and an update
    // keyed on id alone would then relabel a receipted filing as a manual
    // one (and make it unmarkable). The filter is the negation of
    // confirmedRecord(): completed AND confirmed is the one state we refuse.
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
      .or('is_completed.eq.false,status.is.null,status.neq.confirmed')
      .select('id, tax_deadline_type, tax_period, is_completed, completed_at, status, notes, due_date')
      .maybeSingle()
    if (error) throw error
    if (!data) {
      // Zero rows: the row changed under us. If Skatteverket confirmed it,
      // that is the answer; anything else (the generator replaced a pending
      // row mid-flight) is a conflict the caller retries.
      const current = await findPeriodRow(supabase, companyId, input, endMonth)
      const nowConfirmed = current ? confirmedRecord(current, endMonth) : null
      if (nowConfirmed) return { ok: true, record: nowConfirmed, created: false, changed: false }
      return { ok: false, code: 'CONFLICT' }
    }
    const record = toRecord(data as DeadlineRow, endMonth)
    if (!record) throw new Error('vat filing: updated deadline row did not read back as a filing')
    return { ok: true, record, created: false, changed: true }
  }

  // No row: build one the way the generator would, already completed.
  const created = await insertCompletedPeriodRow(supabase, companyId, input, settings, {
    status: 'submitted',
    completedAt: filedOnToCompletedAt(input.filedOn),
    notes: withVatFilingReference(null, input.reference),
    userId: input.userId ?? null,
  })
  const record = toRecord(created, endMonth)
  if (!record) throw new Error('vat filing: inserted deadline row did not read back as a filing')
  return { ok: true, record, created: true, changed: true }
}

/**
 * Insert the period's moms deadline row, already completed, the way the
 * generator would build it (same title, due date, tax_period and linked
 * period: lib/tax/deadline-config.ts and deadline-generator.ts). Used when
 * the company has no row for the period: deadlines never generated, or the
 * period predates the generator's window (a company created after the
 * period's due date gets no row for it, yet may still file it).
 */
async function insertCompletedPeriodRow(
  supabase: SupabaseClient,
  companyId: string,
  input: VatFilingPeriodInput,
  settings: FilingSettings,
  fields: {
    status: 'submitted' | 'confirmed'
    completedAt: string
    notes: string | null
    userId: string | null
  },
): Promise<DeadlineRow> {
  const row = settings.row
  const instance = getVatDeadlineForPeriod(input.periodType, input.year, input.period, {
    vat_taxable_base_over_40m: row?.vat_taxable_base_over_40m === true,
    entity_type: (row?.entity_type ?? null) as VatDeadlineCalculationSettings['entity_type'],
    fiscal_year_start_month: row?.fiscal_year_start_month ?? null,
    vat_has_eu_trade: row?.vat_has_eu_trade ?? null,
    vat_filing_method: (row?.vat_filing_method ?? null) as VatDeadlineCalculationSettings['vat_filing_method'],
  })
  // Only a yearly period can land here: its due date needs the company's
  // legal form and filing profile, and a company without a settings row has
  // neither (none in production on 2026-09-27).
  if (!instance) throw new Error('vat filing: no deadline instance for the VAT period')
  const dueDate = formatDateISO(
    adjustDeadlineToNextBankingDay(new Date(instance.year, instance.month, instance.day)),
  )
  const deadlineType = vatFilingDeadlineType(input.periodType)
  const { data, error } = await supabase
    .from('deadlines')
    .insert({
      company_id: companyId,
      user_id: fields.userId,
      title: `Momsdeklaration ${instance.periodLabel}`,
      due_date: dueDate,
      deadline_type: 'tax',
      priority: 'important',
      is_completed: true,
      completed_at: fields.completedAt,
      source: 'system',
      status: fields.status,
      status_changed_at: new Date().toISOString(),
      notes: fields.notes,
      tax_deadline_type: deadlineType,
      tax_period: instance.period,
      linked_report_type: 'vat',
      linked_report_period: createLinkedReportPeriod(instance, deadlineType),
      reminder_offsets: [14, 7, 1, 0],
      is_auto_generated: true,
    })
    .select('id, tax_deadline_type, tax_period, is_completed, completed_at, status, notes, due_date')
    .single()
  if (error) throw error
  return data as DeadlineRow
}

/**
 * Record a filing Skatteverket has confirmed (a declaration observed at
 * /inlamnat after the user signed it): the period's moms deadline becomes
 * completed with status 'confirmed', or is created that way when the company
 * has no row for the period. A manual 'submitted' mark is upgraded, since
 * the kvittens is the stronger fact; its stored reference is kept.
 *
 * Without the insert, a period filed through the connection but missing from
 * the deadline calendar left no record at all, and the momsdeklaration page
 * kept opening the filed period (PostHog ticket 47).
 */
export async function recordVatFilingConfirmed(
  supabase: SupabaseClient,
  companyId: string,
  input: VatFilingPeriodInput,
  opts: { now?: Date; userId?: string | null } = {},
): Promise<{ record: VatFilingRecord; created: boolean; changed: boolean }> {
  const nowIso = (opts.now ?? new Date()).toISOString()
  const settings = await loadFilingSettings(supabase, companyId)
  const endMonth = settings.fiscalYearEndMonth
  const existing = await findPeriodRow(supabase, companyId, input, endMonth)

  if (existing) {
    const confirmed = confirmedRecord(existing, endMonth)
    if (confirmed) return { record: confirmed, created: false, changed: false }
    // Upgrading a manual 'submitted' mark keeps the user's filed-on date: the
    // kvittens confirms that filing, it does not move when it happened.
    const completedAt = existing.is_completed && existing.completed_at ? existing.completed_at : nowIso
    const { data, error } = await supabase
      .from('deadlines')
      .update({
        is_completed: true,
        completed_at: completedAt,
        status: 'confirmed',
        status_changed_at: nowIso,
      })
      .eq('id', existing.id)
      .eq('company_id', companyId)
      .select('id, tax_deadline_type, tax_period, is_completed, completed_at, status, notes, due_date')
      .single()
    if (error) throw error
    const record = toRecord(data as DeadlineRow, endMonth)
    if (!record) throw new Error('vat filing: confirmed deadline row did not read back as a filing')
    return { record, created: false, changed: true }
  }

  const created = await insertCompletedPeriodRow(supabase, companyId, input, settings, {
    status: 'confirmed',
    completedAt: nowIso,
    notes: null,
    userId: opts.userId ?? null,
  })
  const record = toRecord(created, endMonth)
  if (!record) throw new Error('vat filing: inserted deadline row did not read back as a filing')
  return { record, created: true, changed: true }
}

/**
 * The shared first half of unmarking: the period's row and whether a manual
 * action may put it back to pending. The dry run stops here.
 */
async function resolveUnmark(
  supabase: SupabaseClient,
  companyId: string,
  input: VatFilingPeriodInput,
): Promise<
  | { ok: false; code: 'VAT_FILING_NOT_FOUND' | 'VAT_FILING_CONFIRMED_BY_SKATTEVERKET' }
  | { ok: true; endMonth: number; existing: DeadlineRow; record: VatFilingRecord }
> {
  const { fiscalYearEndMonth: endMonth } = await loadFilingSettings(supabase, companyId)
  const existing = await findPeriodRow(supabase, companyId, input, endMonth)
  const record = existing?.is_completed ? toRecord(existing, endMonth) : null
  if (!existing || !record) return { ok: false, code: 'VAT_FILING_NOT_FOUND' }
  if (existing.status === 'confirmed') {
    return { ok: false, code: 'VAT_FILING_CONFIRMED_BY_SKATTEVERKET' }
  }
  return { ok: true, endMonth, existing, record }
}

/** What unmarkVatPeriodFiled would do, with the same refusals and no write. */
export async function previewUnmarkVatPeriodFiled(
  supabase: SupabaseClient,
  companyId: string,
  input: VatFilingPeriodInput,
): Promise<UnmarkVatPeriodFiledPreview> {
  const resolved = await resolveUnmark(supabase, companyId, input)
  if (!resolved.ok) return resolved
  return { ok: true, would_unmark: placement(input, resolved.endMonth), current: resolved.record }
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
  const resolved = await resolveUnmark(supabase, companyId, input)
  if (!resolved.ok) return resolved
  const { endMonth, existing } = resolved
  const today = opts.today ?? todayIsoStockholm()
  // Same atomic guard as marking: only a row that is STILL a completed,
  // unconfirmed filing at write time is put back to pending. Today every
  // writer of 'confirmed' only touches pending rows, so this cannot lose a
  // race yet; the filter keeps that true by construction rather than by the
  // good behaviour of other modules.
  const { data, error } = await supabase
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
    .eq('is_completed', true)
    .or('status.is.null,status.neq.confirmed')
    .select('id')
    .maybeSingle()
  if (error) throw error
  if (!data) {
    // Nothing was unmarked, so never report success. Say why instead.
    const current = await findPeriodRow(supabase, companyId, input, endMonth)
    return current && confirmedRecord(current, endMonth)
      ? { ok: false, code: 'VAT_FILING_CONFIRMED_BY_SKATTEVERKET' }
      : { ok: false, code: 'VAT_FILING_NOT_FOUND' }
  }
  return { ok: true, deadline_id: existing.id }
}
