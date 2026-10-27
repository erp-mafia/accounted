import type { SupabaseClient } from '@supabase/supabase-js'
import type { SupplierInvoiceDto } from '@/lib/providers/dto'
import { mapFortnoxToSupplierInvoice } from '@/lib/providers/fortnox/mapper'
import { openMigrationPayload } from '@/lib/providers/migration-payload'
import { fetchMigrationPage } from '@/lib/providers/provider-data-fetcher'
import { resolveConsent } from '@/lib/providers/resolve-consent'
import { classifyProviderError } from '@/lib/providers/with-provider-call'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { mapSupplierInvoice } from './entity-mapper'

/**
 * crm#1157, step 3a: collects a company's Fortnox supplier invoice records and
 * drives repair_fortnox_supplier_invoice_numbers (migration 20261013133930),
 * which corrects a supplier number that still holds the Fortnox löpnummer.
 *
 * The records come from two places, in this order:
 *   1. the background import's stored payloads (migration_job_chunks): every
 *      Fortnox supplier invoice that import listed, sealed with its raw
 *      Fortnox fields. Needs no Fortnox call, so it also covers a company
 *      whose Fortnox connection has expired.
 *   2. Fortnox itself, when invoices remain that no stored payload covers
 *      (imports from the older /migrate path). An expired connection is
 *      reported, not raised: that company is repaired when it reconnects.
 *
 * The supplier's number is read from the raw Fortnox field (InvoiceNumber),
 * never from the mapper's invoiceNumber, and a company whose records carry
 * none is never repaired: that is the field-name guard. The header is the one
 * the import stores (mapSupplierInvoice), so the RPC can match an import from
 * before fortnox_number by it.
 *
 * A company's records go to the RPC in ONE call: it decides crm#1039's
 * reused-number rule and every number one invoice frees for another on the
 * whole set, in invoice-date order, and writes all of it or nothing.
 */

const NIL_UUID = '00000000-0000-0000-0000-000000000000'
const MAX_FORTNOX_PAGES = 1000

export interface FortnoxNumberRecord {
  given_number: string
  invoice_number: string | null
  invoice_date: string | null
  total: number | null
  currency: string | null
  is_credit_note: boolean
  source: 'stored_payload' | 'fortnox'
}

/**
 * not_needed: every invoice is covered by a stored payload. skipped: the
 * caller asked for stored payloads only. no_consent / consent_expired: the
 * company is repaired when it reconnects. failed: anything else, with the
 * message.
 */
export type FortnoxFetchState = 'not_needed' | 'skipped' | 'fetched' | 'no_consent' | 'consent_expired' | 'failed'

export interface FortnoxRecordCollection {
  companyId: string
  records: FortnoxNumberRecord[]
  stored: number
  fetched: number
  /** Stored payloads that could not be opened or carried no löpnummer. */
  unreadable: number
  /** Invoices with no fortnox_number, or a fortnox_number no record covers. */
  uncovered: number
  fortnox: FortnoxFetchState
  fortnoxError?: string
  /** False when records exist but none carries an InvoiceNumber. */
  invoiceNumberSeen: boolean
}

export type RepairOutcome =
  | 'corrected'
  | 'reused_number'
  | 'already_correct'
  | 'no_supplier_number'
  | 'changed_by_user'
  | 'number_taken'
  | 'header_mismatch'
  | 'ambiguous'
  | 'not_found'
  | 'invalid_row'

export interface RepairRowResult {
  given_number: string | null
  invoice_id: string | null
  outcome: RepairOutcome
  old_number: string | null
  new_number: string | null
  /** reused_number: the supplier's number, kept as the payment reference. */
  payment_reference: string | null
  stamped: boolean
  old_reference_used: { source: 'payment_file' | 'payment_order'; status: string; date: string | null }[]
}

export interface RepairActor {
  type: 'user' | 'system'
  id: string
  label?: string
}

export interface RepairApplication {
  counts: Partial<Record<RepairOutcome, number>>
  rows: RepairRowResult[]
  correlationId: string | null
}

export type CompanyRepairStatus = 'dry_run' | 'repaired' | 'frozen' | 'no_records' | 'field_missing'

export interface CompanyRepairResult extends RepairApplication {
  companyId: string
  status: CompanyRepairStatus
  collection: FortnoxRecordCollection | null
}

export interface RepairDeps {
  resolveConsent?: typeof resolveConsent
  fetchMigrationPage?: typeof fetchMigrationPage
  openPayload?: <T>(payload: string) => T
}

/** One Fortnox record as the repair reads it, or null without a löpnummer. */
export function fortnoxNumberRecord(
  dto: SupplierInvoiceDto,
  companyId: string,
  source: FortnoxNumberRecord['source'],
): FortnoxNumberRecord | null {
  const raw = dto._raw ?? {}
  const given = String(raw['GivenNumber'] ?? '').trim()
  if (!given) return null
  // Trimmed, blank as none: the same value the import stores for it.
  const supplierNumber = raw['InvoiceNumber']
  const trimmed = supplierNumber === undefined || supplierNumber === null ? '' : String(supplierNumber).trim()
  const record: FortnoxNumberRecord = {
    given_number: given,
    invoice_number: trimmed || null,
    invoice_date: null,
    total: null,
    currency: null,
    is_credit_note: false,
    source,
  }
  try {
    // The header exactly as the import stores it: a credit note as
    // magnitudes beside its flag, a missing currency as SEK. Mapped again
    // from the raw Fortnox fields: a stored payload keeps the DTO of its
    // import day, and one sealed before the list's string Total was parsed
    // carries no numeric total (crm#1157).
    const current = Object.keys(raw).length > 0 ? mapFortnoxToSupplierInvoice(raw) : dto
    const { invoice } = mapSupplierInvoice(current, NIL_UUID, companyId, NIL_UUID)
    record.invoice_date = typeof invoice.invoice_date === 'string' && invoice.invoice_date ? invoice.invoice_date : null
    record.total = typeof invoice.total === 'number' ? invoice.total : null
    record.currency = typeof invoice.currency === 'string' ? invoice.currency : null
    record.is_credit_note = invoice.is_credit_note === true
  } catch {
    // No header: the RPC then matches nothing on it and reports the record.
  }
  return record
}

/** Does this error mean the Fortnox connection itself cannot be used (as opposed to one failed call)? */
export function consentUnusable(error: unknown): boolean {
  if (error && typeof error === 'object' && !(error instanceof Error) && 'status' in error) {
    return [401, 403, 404].includes(Number((error as { status: unknown }).status))
  }
  const code = classifyProviderError(error)
  return code === 'PROVIDER_AUTH_EXPIRED' || code === 'PROVIDER_LICENSE_MISSING'
    || code === 'PROVIDER_RESOURCE_FORBIDDEN' || code === 'PROVIDER_API_MODULE_INACTIVE'
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message)
  return String(error)
}

async function storedRecords(
  supabase: SupabaseClient,
  companyId: string,
  open: <T>(payload: string) => T,
): Promise<{ records: FortnoxNumberRecord[]; unreadable: number }> {
  const { data: jobs, error } = await supabase
    .from('migration_jobs').select('id').eq('company_id', companyId).eq('provider', 'fortnox')
  if (error) throw new Error(`migration_jobs: ${error.message}`)
  const jobIds = ((jobs ?? []) as { id: string }[]).map((j) => j.id)
  if (jobIds.length === 0) return { records: [], unreadable: 0 }
  const chunks = await fetchAllRows<{ id: string; payload: string }>(({ from, to }) =>
    supabase.from('migration_job_chunks').select('id, payload')
      .eq('company_id', companyId).eq('resource', 'supplierInvoices').in('job_id', jobIds)
      .order('id').range(from, to))
  const records: FortnoxNumberRecord[] = []
  let unreadable = 0
  for (const chunk of chunks) {
    let dto: SupplierInvoiceDto & { migrationError?: string }
    try {
      dto = open<SupplierInvoiceDto & { migrationError?: string }>(chunk.payload)
    } catch {
      unreadable++
      continue
    }
    if (dto.migrationError) continue
    const record = fortnoxNumberRecord(dto, companyId, 'stored_payload')
    if (record) records.push(record)
    else unreadable++
  }
  return { records, unreadable }
}

/** Invoices no record covers: imports from before fortnox_number, or rows the stored payloads miss. */
async function uncoveredInvoices(
  supabase: SupabaseClient,
  companyId: string,
  covered: Set<string>,
): Promise<number> {
  const { count, error } = await supabase.from('supplier_invoices')
    .select('id', { count: 'exact', head: true }).eq('company_id', companyId).is('fortnox_number', null)
  if (error) throw new Error(`supplier_invoices: ${error.message}`)
  const stamped = await fetchAllRows<{ id: string; fortnox_number: string }>(({ from, to }) =>
    supabase.from('supplier_invoices').select('id, fortnox_number')
      .eq('company_id', companyId).not('fortnox_number', 'is', null).order('id').range(from, to))
  return (count ?? 0) + stamped.filter((row) => !covered.has(row.fortnox_number)).length
}

async function fortnoxRecords(
  supabase: SupabaseClient,
  companyId: string,
  deps: Required<Pick<RepairDeps, 'resolveConsent' | 'fetchMigrationPage'>>,
): Promise<{ state: FortnoxFetchState; records: FortnoxNumberRecord[]; error?: string }> {
  const { data, error } = await supabase.from('provider_consents').select('id')
    .eq('company_id', companyId).eq('provider', 'fortnox').in('status', [0, 1])
    .order('updated_at', { ascending: false })
  if (error) throw new Error(`provider_consents: ${error.message}`)
  const consents = (data ?? []) as { id: string }[]
  if (consents.length === 0) return { state: 'no_consent', records: [] }
  let lastError: string | undefined
  for (const consent of consents) {
    try {
      // May refresh the access token and store the rotated pair, exactly as
      // a sync does.
      const connection = await deps.resolveConsent(companyId, consent.id)
      const records: FortnoxNumberRecord[] = []
      let page = 1
      for (let pages = 0; pages < MAX_FORTNOX_PAGES; pages++) {
        const result = await deps.fetchMigrationPage('fortnox', connection.accessToken, connection.providerCompanyId,
          'supplierInvoices', page, { allSupplierInvoices: true })
        for (const dto of result.items as SupplierInvoiceDto[]) {
          const record = fortnoxNumberRecord(dto, companyId, 'fortnox')
          if (record) records.push(record)
        }
        if (result.nextPage === null) return { state: 'fetched', records }
        page = result.nextPage
      }
      throw new Error('FORTNOX_PAGE_LIMIT')
    } catch (err) {
      lastError = messageOf(err)
      if (!consentUnusable(err)) return { state: 'failed', records: [], error: lastError }
    }
  }
  return { state: 'consent_expired', records: [], error: lastError }
}

export async function collectFortnoxRecords(
  supabase: SupabaseClient,
  companyId: string,
  options: { fetchFromFortnox: boolean },
  deps: RepairDeps = {},
): Promise<FortnoxRecordCollection> {
  const stored = await storedRecords(supabase, companyId, deps.openPayload ?? openMigrationPayload)
  const byGiven = new Map<string, FortnoxNumberRecord>()
  for (const record of stored.records) if (!byGiven.has(record.given_number)) byGiven.set(record.given_number, record)

  let uncovered = await uncoveredInvoices(supabase, companyId, new Set(byGiven.keys()))
  let fortnox: FortnoxFetchState = uncovered === 0 ? 'not_needed' : 'skipped'
  let fortnoxError: string | undefined
  let fetched = 0
  if (uncovered > 0 && options.fetchFromFortnox) {
    const result = await fortnoxRecords(supabase, companyId, {
      resolveConsent: deps.resolveConsent ?? resolveConsent,
      fetchMigrationPage: deps.fetchMigrationPage ?? fetchMigrationPage,
    })
    fortnox = result.state
    fortnoxError = result.error
    fetched = result.records.length
    // Fortnox today wins over the stored payload: its number is the current one.
    for (const record of result.records) byGiven.set(record.given_number, record)
    if (fetched > 0) uncovered = await uncoveredInvoices(supabase, companyId, new Set(byGiven.keys()))
  }

  const records = [...byGiven.values()]
  return {
    companyId,
    records,
    stored: stored.records.length,
    fetched,
    unreadable: stored.unreadable,
    uncovered,
    fortnox,
    ...(fortnoxError ? { fortnoxError } : {}),
    invoiceNumberSeen: records.some((r) => (r.invoice_number ?? '').trim() !== ''),
  }
}

/** Why a collection must not reach the RPC, or null when it may. */
export function repairBlocker(collection: FortnoxRecordCollection): 'no_records' | 'field_missing' | null {
  if (collection.records.length === 0) return 'no_records'
  if (!collection.invoiceNumberSeen) return 'field_missing'
  return null
}

export async function isMigrationResetSource(supabase: SupabaseClient, companyId: string): Promise<boolean> {
  const { data, error } = await supabase.from('company_migration_resets').select('id')
    .eq('source_company_id', companyId).limit(1)
  if (error) throw new Error(`company_migration_resets: ${error.message}`)
  return (data ?? []).length > 0
}

export async function applyFortnoxNumberRepair(
  supabase: SupabaseClient,
  companyId: string,
  records: FortnoxNumberRecord[],
  options: { dryRun: boolean; actor?: RepairActor; correlationId?: string },
): Promise<RepairApplication> {
  if (!options.dryRun && !options.actor) throw new Error('A write needs an actor')
  const { data, error } = await supabase.rpc('repair_fortnox_supplier_invoice_numbers', {
    p_company_id: companyId,
    p_rows: records,
    p_actor: options.dryRun ? null : options.actor,
    p_dry_run: options.dryRun,
    p_correlation_id: options.correlationId ?? null,
  })
  if (error) throw new Error(`repair_fortnox_supplier_invoice_numbers: ${error.message}`)
  const report = data as {
    counts?: Partial<Record<RepairOutcome, number>>
    rows?: RepairRowResult[]
    correlation_id?: string | null
  }
  return { counts: report.counts ?? {}, rows: report.rows ?? [], correlationId: report.correlation_id ?? null }
}

/**
 * The whole repair for one company: frozen check, collection, field-name
 * guard, then the RPC (a dry run unless `dryRun: false` with an actor).
 */
export async function repairFortnoxSupplierNumbers(
  supabase: SupabaseClient,
  companyId: string,
  options: { dryRun: boolean; fetchFromFortnox: boolean; actor?: RepairActor; correlationId?: string },
  deps: RepairDeps = {},
): Promise<CompanyRepairResult> {
  const empty = { counts: {}, rows: [], correlationId: null }
  if (await isMigrationResetSource(supabase, companyId)) {
    return { companyId, status: 'frozen', collection: null, ...empty }
  }
  const collection = await collectFortnoxRecords(supabase, companyId, { fetchFromFortnox: options.fetchFromFortnox }, deps)
  const blocker = repairBlocker(collection)
  if (blocker) return { companyId, status: blocker, collection, ...empty }
  const applied = await applyFortnoxNumberRepair(supabase, companyId, collection.records, options)
  return { companyId, status: options.dryRun ? 'dry_run' : 'repaired', collection, ...applied }
}

export type RevertOutcome = 'reverted' | 'changed_since' | 'number_taken'

export interface RevertRowResult {
  invoice_id: string
  fortnox_number: string | null
  outcome: RevertOutcome
  /** What the repair wrote, which the invoice must still hold to be reverted. */
  current: { supplier_invoice_number: string | null; payment_reference: string | null }
  /** What the invoice held before the repair. */
  restore: { supplier_invoice_number: string | null; payment_reference: string | null }
}

export interface RevertApplication {
  counts: Partial<Record<RevertOutcome, number>>
  rows: RevertRowResult[]
  correlationId: string | null
}

/** The companies one repair run changed, by its correlation id. */
export async function correctedCompanies(supabase: SupabaseClient, repairCorrelationId: string): Promise<string[]> {
  const rows = await fetchAllRows<{ company_id: string }>(({ from, to }) =>
    supabase.from('processing_history').select('company_id')
      .eq('correlation_id', repairCorrelationId).eq('event_type', 'SupplierInvoiceNumberCorrected')
      .order('seq').range(from, to))
  return [...new Set(rows.map((r) => r.company_id))]
}

/**
 * Undoes one repair run for one company (revert_fortnox_supplier_invoice_numbers):
 * every invoice still holding what the run wrote gets its number and payment
 * reference from before the run back, in reverse write order. A dry run
 * reports the same, writing nothing.
 */
export async function revertFortnoxNumberRepair(
  supabase: SupabaseClient,
  companyId: string,
  repairCorrelationId: string,
  options: { dryRun: boolean; actor?: RepairActor },
): Promise<RevertApplication> {
  if (!options.dryRun && !options.actor) throw new Error('A write needs an actor')
  const { data, error } = await supabase.rpc('revert_fortnox_supplier_invoice_numbers', {
    p_company_id: companyId,
    p_correlation_id: repairCorrelationId,
    p_actor: options.dryRun ? null : options.actor,
    p_dry_run: options.dryRun,
  })
  if (error) throw new Error(`revert_fortnox_supplier_invoice_numbers: ${error.message}`)
  const report = data as {
    counts?: Partial<Record<RevertOutcome, number>>
    rows?: RevertRowResult[]
    correlation_id?: string | null
  }
  return { counts: report.counts ?? {}, rows: report.rows ?? [], correlationId: report.correlation_id ?? null }
}
