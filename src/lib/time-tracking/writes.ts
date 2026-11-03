/**
 * Time-entry writes shared by the time-tracking extension's session routes
 * and the time-entries operations (v1 REST + staged MCP tools). One set of
 * rules for every door: references resolve (never guessed, never created),
 * an invoiced row is frozen, and a dry run checks everything the write will.
 */
import type { OperationOutcome } from '@/lib/operations/types'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { resolveRef } from './resolve'
import type { RefCandidate } from './resolve'
import { loadTimeTrackingSettings, withCustomerName } from './service'
import type { TimeEntryRow, TimeTrackingContext } from './service'
import { resolveHourlyRate } from './summary'
import { isInvoiced } from './types'
import type { TimeEntry, TimeTrackingSettings } from './types'

export interface TimeWriteContext extends TimeTrackingContext {
  userId: string
}

export interface TimeWriteOptions {
  dryRun: boolean
  /**
   * The dashboard door, where no one approves a preview: references match by
   * exact code or id only (no fuzzy step), and a consultant or activity code
   * not in the registers is taken as a new code, as the entry dialog has
   * always allowed. The machine doors keep both off: a misheard name must
   * not become a code or land on a near-miss.
   */
  dashboard?: boolean
}

/** One entry as a door hands it over: references by id, code or name. */
export interface TimeEntryInput {
  entry_date: string
  hours: number
  customer_id?: string
  customer?: string
  project?: string | null
  activity?: string | null
  consultant?: string
  comment?: string | null
  is_billable?: boolean
}

export type TimeEntryPatch = Partial<TimeEntryInput>

type Failure = Extract<OperationOutcome<never>, { ok: false }>

/** What an entry becomes once its references are resolved, as the approver sees it. */
export interface ResolvedTimeEntry {
  entry_date: string
  weekday: string
  hours: number
  consultant: string
  consultant_name: string | null
  customer_id: string
  customer_name: string
  project_code: string | null
  project_name: string | null
  activity_code: string | null
  activity_name: string | null
  comment: string | null
  is_billable: boolean
  hourly_rate: number | null
  amount: number | null
  /** Inputs matched by name or fuzzily rather than by exact code. */
  matched: Array<{ field: string; input: string; resolved: string; confidence: number }>
}

const weekday = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('sv-SE', { weekday: 'long', timeZone: 'UTC' })

const round2 = (x: number) => Math.round(x * 100) / 100

interface Registers {
  settings: TimeTrackingSettings
  customers: RefCandidate[] | null
  projects: RefCandidate[] | null
}

/** Load only the registers the inputs reference: a code-only entry costs no customer scan. */
async function loadRegisters(ctx: TimeWriteContext, inputs: TimeEntryPatch[]): Promise<Registers> {
  const needCustomers = inputs.some((i) => i.customer !== undefined || i.customer_id !== undefined)
  const needProjects = inputs.some((i) => typeof i.project === 'string')
  const settings = await loadTimeTrackingSettings(ctx)
  const [customers, projects] = await Promise.all([
    needCustomers ? loadCustomerCandidates(ctx, settings) : Promise.resolve(null),
    needProjects ? loadProjectCandidates(ctx) : Promise.resolve(null),
  ])
  return { settings, customers, projects }
}

async function loadCustomerCandidates(ctx: TimeWriteContext, settings: TimeTrackingSettings): Promise<RefCandidate[]> {
  const rows = await fetchAllRows<{ id: string; name: string; customer_number: string | null }>(({ from, to }) =>
    ctx.supabase
      .from('customers')
      .select('id, name, customer_number')
      .eq('company_id', ctx.companyId)
      .order('id', { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: Array<{ id: string; name: string; customer_number: string | null }> | null; error: { message: string } | null }>,
  )
  const linkCodes = new Map<string, string[]>()
  for (const link of settings.customer_links) {
    linkCodes.set(link.customer_id, [...(linkCodes.get(link.customer_id) ?? []), link.code])
  }
  return rows.map((c) => ({
    value: c.id,
    name: c.name,
    aliases: [...(c.customer_number ? [c.customer_number] : []), ...(linkCodes.get(c.id) ?? [])],
  }))
}

async function loadProjectCandidates(ctx: TimeWriteContext): Promise<RefCandidate[]> {
  const rows = await fetchAllRows<{ code: string; name: string }>(({ from, to }) =>
    ctx.supabase
      .from('dimension_values')
      .select('code, name, dimensions!inner(sie_dim_no)')
      .eq('company_id', ctx.companyId)
      .eq('is_active', true)
      .eq('dimensions.sie_dim_no', 6)
      .order('code', { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: Array<{ code: string; name: string }> | null; error: { message: string } | null }>,
  )
  return rows.map((p) => ({ value: p.code, name: p.name }))
}

const FIELD_LABEL_SV: Record<string, string> = {
  customer: 'kund',
  project: 'projekt',
  activity: 'aktivitetskod',
  consultant: 'medarbetare',
}

function unresolved(
  field: string,
  input: string,
  candidates: Array<{ value: string; name: string; confidence: number }>,
  entryIndex: number | null,
): Failure {
  const label = FIELD_LABEL_SV[field] ?? field
  const listed = candidates.map((c) => (c.value === c.name ? c.value : `${c.name} (${c.value})`)).join(', ')
  return {
    ok: false,
    code: 'TIME_ENTRY_REFERENCE_UNRESOLVED',
    messageSv:
      candidates.length > 0
        ? `Kunde inte avgöra vilken ${label} "${input}" avser. Kandidater: ${listed}. Ange koden.`
        : `Hittade ingen ${label} som matchar "${input}".`,
    details: { field, input, candidates, ...(entryIndex === null ? {} : { entry_index: entryIndex }) },
  }
}

type Resolved<T> = { ok: true; value: T } | Failure

function resolveCode(
  field: 'activity' | 'consultant',
  input: string,
  register: Array<{ code: string; name: string }>,
  options: TimeWriteOptions,
  entryIndex: number | null,
  matched: ResolvedTimeEntry['matched'],
): Resolved<{ code: string; name: string | null }> {
  const result = resolveRef(input, register.map((r) => ({ value: r.code, name: r.name })), { exactOnly: options.dashboard })
  if (result.ok) {
    if (!result.exact) matched.push({ field, input, resolved: result.candidate.value, confidence: result.confidence })
    return { ok: true, value: { code: result.candidate.value, name: result.candidate.name } }
  }
  if (options.dashboard && /^[\p{L}\p{N}_+-]{1,20}$/u.test(input.trim())) {
    return { ok: true, value: { code: field === 'consultant' ? input.trim().toUpperCase() : input.trim(), name: null } }
  }
  return unresolved(field, input, result.candidates, entryIndex)
}

function resolveCustomer(
  input: TimeEntryPatch,
  customers: RefCandidate[],
  options: TimeWriteOptions,
  entryIndex: number | null,
  matched: ResolvedTimeEntry['matched'],
): Resolved<{ id: string; name: string }> {
  if (input.customer_id) {
    const found = customers.find((c) => c.value === input.customer_id)
    if (!found) return { ok: false, code: 'TIME_ENTRY_CUSTOMER_NOT_FOUND', details: { customer_id: input.customer_id } }
    return { ok: true, value: { id: found.value, name: found.name } }
  }
  const said = input.customer ?? ''
  const result = resolveRef(said, customers, { exactOnly: options.dashboard })
  if (!result.ok) return unresolved('customer', said, result.candidates, entryIndex)
  if (!result.exact) matched.push({ field: 'customer', input: said, resolved: result.candidate.name, confidence: result.confidence })
  return { ok: true, value: { id: result.candidate.value, name: result.candidate.name } }
}

function resolveProject(
  said: string,
  projects: RefCandidate[],
  options: TimeWriteOptions,
  entryIndex: number | null,
  matched: ResolvedTimeEntry['matched'],
): Resolved<{ code: string; name: string }> {
  const result = resolveRef(said, projects, { exactOnly: options.dashboard })
  if (!result.ok) return unresolved('project', said, result.candidates, entryIndex)
  if (!result.exact) matched.push({ field: 'project', input: said, resolved: result.candidate.value, confidence: result.confidence })
  return { ok: true, value: { code: result.candidate.value, name: result.candidate.name } }
}

/** The consultant linked to the acting user, for entries that do not name one. */
function ownConsultant(settings: TimeTrackingSettings, userId: string) {
  return settings.consultants.find((c) => c.user_id === userId) ?? null
}

/** Resolve a full new entry. */
function resolveNewEntry(
  ctx: TimeWriteContext,
  input: TimeEntryInput,
  registers: Registers,
  options: TimeWriteOptions,
  entryIndex: number | null,
): Resolved<ResolvedTimeEntry> {
  const matched: ResolvedTimeEntry['matched'] = []
  const { settings } = registers

  let consultant: { code: string; name: string | null }
  if (input.consultant) {
    const r = resolveCode('consultant', input.consultant, settings.consultants, options, entryIndex, matched)
    if (!r.ok) return r
    consultant = r.value
  } else {
    const own = ownConsultant(settings, ctx.userId)
    if (!own) {
      return {
        ok: false,
        code: 'TIME_ENTRY_CONSULTANT_REQUIRED',
        details: {
          consultants: settings.consultants.map((c) => ({ code: c.code, name: c.name })),
          ...(entryIndex === null ? {} : { entry_index: entryIndex }),
        },
      }
    }
    consultant = { code: own.code, name: own.name }
  }

  const customer = resolveCustomer(input, registers.customers ?? [], options, entryIndex, matched)
  if (!customer.ok) return customer

  let project: { code: string; name: string } | null = null
  if (input.project) {
    const r = resolveProject(input.project, registers.projects ?? [], options, entryIndex, matched)
    if (!r.ok) return r
    project = r.value
  }

  let activity: { code: string; name: string | null } | null = null
  if (input.activity) {
    const r = resolveCode('activity', input.activity, settings.activity_codes, options, entryIndex, matched)
    if (!r.ok) return r
    activity = r.value
  }

  const isBillable = input.is_billable ?? true
  const rate = resolveHourlyRate(activity?.code ?? null, settings)
  return {
    ok: true,
    value: {
      entry_date: input.entry_date,
      weekday: weekday(input.entry_date),
      hours: input.hours,
      consultant: consultant.code,
      consultant_name: consultant.name,
      customer_id: customer.value.id,
      customer_name: customer.value.name,
      project_code: project?.code ?? null,
      project_name: project?.name ?? null,
      activity_code: activity?.code ?? null,
      activity_name: activity?.name ?? null,
      comment: input.comment?.trim() || null,
      is_billable: isBillable,
      hourly_rate: isBillable ? rate : null,
      amount: isBillable && rate !== null ? round2(input.hours * rate) : null,
      matched,
    },
  }
}

/** The input that commits exactly what the approver saw: every reference by its code or id. */
export function pinnedEntryInput(e: ResolvedTimeEntry): TimeEntryInput {
  return {
    entry_date: e.entry_date,
    hours: e.hours,
    customer_id: e.customer_id,
    project: e.project_code,
    activity: e.activity_code,
    consultant: e.consultant,
    comment: e.comment,
    is_billable: e.is_billable,
  }
}

export interface CreateTimeEntriesPreview {
  entries: ResolvedTimeEntry[]
  total_hours: number
  /** Null when some billable hours have no known rate. */
  total_amount: number | null
  will: string
  [key: string]: unknown
}

/** Register one or more entries. All or nothing: one unresolved reference refuses the batch. */
export async function createTimeEntries(
  ctx: TimeWriteContext,
  inputs: TimeEntryInput[],
  options: TimeWriteOptions,
): Promise<OperationOutcome<{ entries: TimeEntry[] }>> {
  let registers: Registers
  try {
    registers = await loadRegisters(ctx, inputs)
  } catch (error) {
    ctx.log.error('time entry registers failed', error)
    return { ok: false, code: 'UNKNOWN_ERROR', error }
  }

  const resolved: ResolvedTimeEntry[] = []
  for (const [index, input] of inputs.entries()) {
    const r = resolveNewEntry(ctx, input, registers, options, inputs.length > 1 ? index : null)
    if (!r.ok) return r
    resolved.push(r.value)
  }

  if (options.dryRun) {
    const billable = resolved.filter((e) => e.is_billable)
    const preview: CreateTimeEntriesPreview = {
      entries: resolved,
      total_hours: round2(resolved.reduce((s, e) => s + e.hours, 0)),
      total_amount: billable.every((e) => e.amount !== null)
        ? round2(billable.reduce((s, e) => s + (e.amount ?? 0), 0))
        : null,
      will: 'register the hours as time entries; nothing is booked or invoiced',
    }
    return { ok: true, dryRun: true, preview }
  }

  const { data, error } = await ctx.supabase
    .from('time_entries')
    .insert(
      resolved.map((e) => ({
        company_id: ctx.companyId,
        user_id: ctx.userId,
        entry_date: e.entry_date,
        consultant: e.consultant,
        customer_id: e.customer_id,
        project_code: e.project_code,
        activity_code: e.activity_code,
        hours: e.hours,
        comment: e.comment,
        is_billable: e.is_billable,
        source: 'manual' as const,
      })),
    )
    .select('id, company_id, user_id, entry_date, consultant, customer_id, customer_code, customer_name, project_code, activity_code, hours, comment, is_billable, invoice_id, invoiced_externally, source, import_key, created_at, updated_at, customers(name)')
  if (error || !data) {
    ctx.log.error('time_entries insert failed', error)
    return { ok: false, code: 'UNKNOWN_ERROR', error }
  }
  return { ok: true, data: { entries: (data as unknown as TimeEntryRow[]).map(withCustomerName) }, created: true }
}

/** An entry of this company that may still change: not found, or frozen once invoiced. */
async function loadEditable(ctx: TimeWriteContext, id: string): Promise<{ ok: true; entry: TimeEntry } | Failure> {
  const { data, error } = await ctx.supabase
    .from('time_entries')
    .select('id, company_id, user_id, entry_date, consultant, customer_id, customer_code, customer_name, project_code, activity_code, hours, comment, is_billable, invoice_id, invoiced_externally, source, import_key, created_at, updated_at, customers(name)')
    .eq('id', id)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  if (error) {
    ctx.log.error('time_entries read failed', error)
    return { ok: false, code: 'UNKNOWN_ERROR', error }
  }
  if (!data) return { ok: false, code: 'TIME_ENTRY_NOT_FOUND', details: { time_entry_id: id } }
  const entry = withCustomerName(data as unknown as TimeEntryRow)
  if (isInvoiced(entry)) {
    return {
      ok: false,
      code: 'TIME_ENTRY_INVOICED',
      details: { time_entry_id: id, invoice_id: entry.invoice_id, invoiced_externally: entry.invoiced_externally },
    }
  }
  return { ok: true, entry }
}

/** The entry as the approver sees it, before or after a change. */
function display(e: TimeEntry, names: { project_name?: string | null; activity_name?: string | null; consultant_name?: string | null } = {}) {
  return {
    entry_date: e.entry_date,
    weekday: weekday(e.entry_date),
    hours: Number(e.hours),
    consultant: e.consultant,
    customer_id: e.customer_id,
    customer_name: e.customer_name,
    project_code: e.project_code,
    activity_code: e.activity_code,
    comment: e.comment,
    is_billable: e.is_billable,
    ...names,
  }
}

export interface UpdateTimeEntryPreview {
  time_entry_id: string
  before: ReturnType<typeof display>
  after: ReturnType<typeof display>
  /** The changed fields by code or id, the input the commit runs with. */
  changes: TimeEntryPatch
  matched: ResolvedTimeEntry['matched']
  will: string
  [key: string]: unknown
}

/** Sparse update: only the fields present change. project, activity and comment take null to clear. */
export async function updateTimeEntry(
  ctx: TimeWriteContext,
  id: string,
  patch: TimeEntryPatch,
  options: TimeWriteOptions,
): Promise<OperationOutcome<{ entry: TimeEntry }>> {
  const current = await loadEditable(ctx, id)
  if (!current.ok) return current
  const before = current.entry

  let registers: Registers
  try {
    registers = await loadRegisters(ctx, [patch])
  } catch (error) {
    ctx.log.error('time entry registers failed', error)
    return { ok: false, code: 'UNKNOWN_ERROR', error }
  }

  const matched: ResolvedTimeEntry['matched'] = []
  const changes: TimeEntryPatch = {}
  const row: Record<string, unknown> = {}
  const names: { project_name?: string | null; activity_name?: string | null; consultant_name?: string | null } = {}
  let customerName = before.customer_name

  if (patch.entry_date !== undefined) {
    changes.entry_date = patch.entry_date
    row.entry_date = patch.entry_date
  }
  if (patch.hours !== undefined) {
    changes.hours = patch.hours
    row.hours = patch.hours
  }
  if (patch.consultant !== undefined) {
    const r = resolveCode('consultant', patch.consultant, registers.settings.consultants, options, null, matched)
    if (!r.ok) return r
    changes.consultant = r.value.code
    row.consultant = r.value.code
    names.consultant_name = r.value.name
  }
  if (patch.customer_id !== undefined || patch.customer !== undefined) {
    const r = resolveCustomer(patch, registers.customers ?? [], options, null, matched)
    if (!r.ok) return r
    changes.customer_id = r.value.id
    row.customer_id = r.value.id
    customerName = r.value.name
  }
  if (patch.project !== undefined) {
    if (patch.project === null) {
      changes.project = null
      row.project_code = null
    } else {
      const r = resolveProject(patch.project, registers.projects ?? [], options, null, matched)
      if (!r.ok) return r
      changes.project = r.value.code
      row.project_code = r.value.code
      names.project_name = r.value.name
    }
  }
  if (patch.activity !== undefined) {
    if (patch.activity === null) {
      changes.activity = null
      row.activity_code = null
    } else {
      const r = resolveCode('activity', patch.activity, registers.settings.activity_codes, options, null, matched)
      if (!r.ok) return r
      changes.activity = r.value.code
      row.activity_code = r.value.code
      names.activity_name = r.value.name
    }
  }
  if (patch.comment !== undefined) {
    changes.comment = patch.comment?.trim() || null
    row.comment = changes.comment
  }
  if (patch.is_billable !== undefined) {
    changes.is_billable = patch.is_billable
    row.is_billable = patch.is_billable
  }

  const after: TimeEntry = {
    ...before,
    ...(row as Partial<TimeEntry>),
    customer_name: customerName,
  }

  if (options.dryRun) {
    const preview: UpdateTimeEntryPreview = {
      time_entry_id: id,
      before: display(before),
      after: display(after, names),
      changes,
      matched,
      will: 'change the time entry; nothing is booked or invoiced',
    }
    return { ok: true, dryRun: true, preview }
  }

  // The invoiced guards are in the write itself, so a row invoiced since the read stays frozen.
  const { data, error } = await ctx.supabase
    .from('time_entries')
    .update({
      entry_date: after.entry_date,
      hours: after.hours,
      consultant: after.consultant,
      customer_id: after.customer_id,
      project_code: after.project_code,
      activity_code: after.activity_code,
      comment: after.comment,
      is_billable: after.is_billable,
    })
    .eq('id', id)
    .eq('company_id', ctx.companyId)
    .is('invoice_id', null)
    .eq('invoiced_externally', false)
    .select('id, company_id, user_id, entry_date, consultant, customer_id, customer_code, customer_name, project_code, activity_code, hours, comment, is_billable, invoice_id, invoiced_externally, source, import_key, created_at, updated_at, customers(name)')
    .maybeSingle()
  if (error) {
    ctx.log.error('time_entries update failed', error)
    return { ok: false, code: 'UNKNOWN_ERROR', error }
  }
  if (!data) return { ok: false, code: 'TIME_ENTRY_INVOICED', details: { time_entry_id: id } }
  return { ok: true, data: { entry: withCustomerName(data as unknown as TimeEntryRow) } }
}

/** Delete an entry that is not invoiced. */
export async function deleteTimeEntry(
  ctx: TimeWriteContext,
  id: string,
  options: Pick<TimeWriteOptions, 'dryRun'>,
): Promise<OperationOutcome<{ deleted: true; time_entry_id: string }>> {
  const current = await loadEditable(ctx, id)
  if (!current.ok) return current
  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: { time_entry_id: id, entry: display(current.entry), will: 'delete the time entry' },
    }
  }
  const { data, error } = await ctx.supabase
    .from('time_entries')
    .delete()
    .eq('id', id)
    .eq('company_id', ctx.companyId)
    .is('invoice_id', null)
    .eq('invoiced_externally', false)
    .select('id')
  if (error) {
    ctx.log.error('time_entries delete failed', error)
    return { ok: false, code: 'UNKNOWN_ERROR', error }
  }
  if (!data || data.length === 0) return { ok: false, code: 'TIME_ENTRY_INVOICED', details: { time_entry_id: id } }
  return { ok: true, data: { deleted: true, time_entry_id: id } }
}
