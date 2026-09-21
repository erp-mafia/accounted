/**
 * Repair the fabricated payment date on migrated customer invoices (#2798 C).
 *
 * Until #2769 the sales-invoice mapper wrote `paid_at = lastPaymentDate ||
 * issueDate`. The Fortnox, Bokio, Briox and Bjorn Lunden mappers have never
 * set `lastPaymentDate`, so every paid invoice they migrated says it was paid
 * on the day it was issued. #2769 stopped the write; this pass repairs the
 * rows already written. It writes ONLY `paid_at` (the updated_at trigger
 * bumps that column as on any update), never inserts, never deletes.
 *
 * WHICH ROWS. `invoices` has no migration-source column, so "migrated" cannot
 * be read off the row. What can be read is the mapper's write signature: it
 * put a bare date into a timestamptz, which Postgres stores as that day at
 * exactly 00:00:00 UTC. Every settlement path inside Accounted writes either
 * the wall clock (before 2026-08-02, #1332) or UTC noon (paidAtFromDate and
 * the link/allocate RPCs since migration 20260801204551), so `paid_at` equal
 * to the invoice date at UTC midnight to the microsecond is something only
 * the mapper produces. An invoice created and paid in Accounted on its own
 * invoice date carries noon or a wall-clock time and is never a candidate.
 *
 * THE BOUNDARY. A candidate is fabricated only if the mapper that wrote it
 * could not have known a date. Two things can put a REAL settlement date
 * equal to the invoice date (card, Swish, cash register) behind the same
 * signature, and nulling those would be new damage, not a repair:
 *  - a row created after #2769: the fallback is gone, so a date on it came
 *    from the provider. Excluded by `created_at`, on the read and again on
 *    the write. Part B (Fortnox /invoicepayments) will make this the common
 *    case for Fortnox too, which is why the cutoff is on time, not provider.
 *  - a row from a provider whose mapper reads a settlement date (Visma and
 *    WINT). Before #2769 such a row is either the provider's date or the
 *    fallback, and the row cannot say which. It is left alone unless a
 *    source names its date.
 *
 * WHAT IS WRITTEN. Sources, highest priority first:
 *  1. the provider's own settlement date, when the caller supplies it
 *     (`providerPaymentDates`). Nothing supplies it today: this is the slot
 *     part B fills, and the reason the resolver takes evidence, not queries.
 *  2. the `entry_date` of the one posted journal entry the invoice's
 *     `invoice_payments` rows point at.
 * No source, and a provider proven to have had no date: `null`. The value
 * was a copy of `invoice_date`, so nothing is lost, and the invoice page
 * already renders a paid invoice without a date as "betald före migreringen"
 * (classifyPaymentHistoryGap). Payment rows that do not name exactly one
 * posted entry mean the invoice was settled here in a way this pass cannot
 * date: left alone, never nulled.
 *
 * Idempotent: a nulled row has no `paid_at`, a dated row carries UTC noon,
 * and neither matches the signature again. Rows left alone are reported the
 * same way on every run.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { ISO_DATE_RE } from '@/lib/invariants'
import { paidAtFromDate } from '@/lib/invoices/paid-at'
import { INVOICE_ROWS_COMPLETED_EVENT } from '@/lib/invoices/complete-invoice-rows'

const log = createLogger('extensions/arcim-migration/repair-invoice-paid-at')

/**
 * Merge time of #2769 (02509a05d): the earliest instant the fixed mapper can
 * have been live. A row created at or after it is never touched. Rows written
 * by the old code between the merge and the deploy going live stay as they
 * are: under-repair, which is the safe side of this line. On prod there are
 * none (checked 2026-09-20).
 */
export const FABRICATED_PAID_AT_CREATED_BEFORE = '2026-09-20T14:09:27Z'

/**
 * Providers whose sales-invoice mapper never set `lastPaymentDate` in any
 * commit before the cutoff (git log -S over lib/providers). An allowlist on
 * purpose: a provider that is not listed is treated as one that may have
 * supplied a real date, so a new provider can never be nulled by default.
 * Part B does not change this list: it only affects rows created after the
 * cutoff, which the pass does not read.
 */
export const PROVIDERS_WITHOUT_SETTLEMENT_DATE: readonly string[] = [
  'fortnox',
  'bokio',
  'briox',
  'bjornlunden',
]

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[T ]\d{2}:\d{2}:\d{2}(?:\.(\d+))?(?:Z|[+-]\d{2}(?::?\d{2})?)$/

/** Ids per `.in()` filter: keeps the request line well under proxy limits. */
const ID_CHUNK = 100
/** Compare-and-set updates in flight at once. */
const WRITE_CONCURRENCY = 5

export type PaidAtSource = 'provider' | 'journal_entry'

export interface PaidAtEvidence {
  /** Settlement date the provider names for this invoice; absent when the provider was not asked. */
  providerPaymentDate?: string | null
  /** `invoice_payments` rows on the invoice. */
  paymentRows: number
  /** The journal entries those rows point at, one element per row; null when a row names none. */
  journalEntries: ReadonlyArray<{ id: string; entry_date: string; status: string } | null>
}

export type PaidAtResolution =
  | { kind: 'date'; date: string; source: PaidAtSource }
  /** Payment rows exist but do not name exactly one posted journal entry. */
  | { kind: 'ambiguous' }
  /** Nothing names a date. */
  | { kind: 'unknown' }

function isoDay(value: string | null | undefined): string | null {
  const day = typeof value === 'string' ? value.slice(0, 10) : ''
  if (!ISO_DATE_RE.test(day)) return null
  const parsed = new Date(`${day}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day ? day : null
}

/**
 * The settlement date the evidence supports, by source priority. Pure, so
 * the precedence part B relies on is locked by a unit test rather than by
 * the order of two queries.
 */
export function resolvePaidAt(evidence: PaidAtEvidence): PaidAtResolution {
  const providerDay = isoDay(evidence.providerPaymentDate)
  if (providerDay) return { kind: 'date', date: providerDay, source: 'provider' }

  if (evidence.paymentRows === 0) return { kind: 'unknown' }

  const entries = evidence.journalEntries
  if (entries.length !== evidence.paymentRows || entries.some((entry) => entry === null)) {
    return { kind: 'ambiguous' }
  }
  const distinct = new Map(entries.map((entry) => [entry!.id, entry!]))
  if (distinct.size !== 1) return { kind: 'ambiguous' }
  const [entry] = distinct.values()
  const entryDay = isoDay(entry.entry_date)
  if (entry.status !== 'posted' || !entryDay) return { kind: 'ambiguous' }
  return { kind: 'date', date: entryDay, source: 'journal_entry' }
}

/**
 * True when `paid_at` is the invoice date at exactly 00:00:00 UTC: the
 * mapper's signature. A fractional second that is not zero is a wall-clock
 * value that happened to land inside the first millisecond, so the string is
 * checked as well as the instant.
 */
export function hasFabricatedSignature(row: { invoice_date: string; paid_at: string | null }): boolean {
  if (!row.paid_at) return false
  const invoiceDay = isoDay(row.invoice_date)
  if (!invoiceDay || invoiceDay !== row.invoice_date) return false
  const match = TIMESTAMP.exec(row.paid_at)
  if (!match) return false
  if (match[2] && /[1-9]/.test(match[2])) return false
  return Date.parse(row.paid_at) === Date.parse(`${invoiceDay}T00:00:00Z`)
}

export interface RepairMigratedInvoicePaidAtOptions {
  supabase: SupabaseClient
  companyId: string
  dryRun?: boolean
  /**
   * Settlement dates the provider names, by invoice id. Part B (#2798) builds
   * this from Fortnox /invoicepayments; a Visma or WINT caller can build it
   * from `lastPaymentDate`. It outranks the journal-entry date and lifts the
   * "provider may supply a date" hold for the invoices it covers.
   */
  providerPaymentDates?: ReadonlyMap<string, string>
}

export interface RepairMigratedInvoicePaidAtResult {
  /** Paid invoices carrying the fabricated signature, created before the fix. */
  candidates: number
  /** Written (dry run: would be written) with a real settlement date. */
  setToDate: number
  setToDateBySource: Record<PaidAtSource, number>
  /** Written (dry run: would be written) to null: no source, provider proven dateless. */
  setToNull: number
  leftAlone: {
    /** A source names the invoice date itself: the stored day is right. */
    confirmedBySource: number
    /** Payment rows exist but do not name exactly one posted journal entry. */
    ambiguousPaymentRows: number
    /** No source, and a provider of this company reads real settlement dates. */
    providerMaySupplyDate: number
    /** No source, and nothing says which provider the rows came from. */
    providerUnknown: number
    /** The row no longer held the value that was read: someone else wrote it. */
    changedSinceRead: number
    /** Planned, but a refused write stopped the run first. */
    notWritten: number
  }
  /** Providers named by the company's consents, the evidence the null branch rests on. */
  providers: string[]
  /** The first write the database refused; the run stops there and is safe to repeat. */
  writeError: { code: string | null; message: string } | null
  dryRun: boolean
}

interface CandidateRow {
  id: string
  invoice_date: string
  paid_at: string | null
  created_at: string
}

interface PaymentRow {
  invoice_id: string
  journal_entry_id: string | null
}

interface JournalEntryRow {
  id: string
  entry_date: string
  status: string
}

type ProviderEvidence = 'dateless' | 'may_supply_date' | 'unknown'

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * Could the mapper that wrote this company's invoices have known a date?
 * Consents name the provider; the behandlingshistorik trail of the migration
 * (InvoiceRowsCompleted, since 2026-09-06) names it too and survives a
 * deleted consent. Any provider outside the allowlist, in either, holds the
 * null branch for the whole company. On prod the two never disagree.
 */
async function readProviderEvidence(
  supabase: SupabaseClient,
  companyId: string,
): Promise<{ evidence: ProviderEvidence; providers: string[] }> {
  const { data: consents, error: consentError } = await supabase
    .from('provider_consents')
    .select('provider')
    .eq('company_id', companyId)
  if (consentError) throw new Error(`provider_consents read failed: ${consentError.message}`)

  const providers = [...new Set(
    ((consents ?? []) as { provider: string | null }[])
      .map((row) => (row.provider ?? '').trim().toLowerCase())
      .filter((provider) => provider.length > 0),
  )].sort()

  const allowlist = `(${PROVIDERS_WITHOUT_SETTLEMENT_DATE.map((p) => `"${p}"`).join(',')})`
  const trail = () => supabase
    .from('processing_history')
    .select('event_id')
    .eq('company_id', companyId)
    .eq('event_type', INVOICE_ROWS_COMPLETED_EVENT)

  const { data: foreign, error: foreignError } = await trail()
    .not('payload->>provider', 'in', allowlist)
    .limit(1)
  if (foreignError) throw new Error(`processing_history read failed: ${foreignError.message}`)

  if ((foreign ?? []).length > 0 || providers.some((p) => !PROVIDERS_WITHOUT_SETTLEMENT_DATE.includes(p))) {
    return { evidence: 'may_supply_date', providers }
  }
  if (providers.length > 0) return { evidence: 'dateless', providers }

  const { data: known, error: knownError } = await trail()
    .in('payload->>provider', [...PROVIDERS_WITHOUT_SETTLEMENT_DATE])
    .limit(1)
  if (knownError) throw new Error(`processing_history read failed: ${knownError.message}`)
  return { evidence: (known ?? []).length > 0 ? 'dateless' : 'unknown', providers }
}

export async function repairMigratedInvoicePaidAt(
  options: RepairMigratedInvoicePaidAtOptions,
): Promise<RepairMigratedInvoicePaidAtResult> {
  const { supabase, companyId, dryRun = false, providerPaymentDates } = options

  const paidRows = await fetchAllRows<CandidateRow>(({ from, to }) =>
    supabase
      .from('invoices')
      .select('id, invoice_date, paid_at, created_at')
      .eq('company_id', companyId)
      .eq('status', 'paid')
      .not('paid_at', 'is', null)
      .lt('created_at', FABRICATED_PAID_AT_CREATED_BEFORE)
      .order('id', { ascending: true })
      .range(from, to),
  )

  // The cutoff is checked again here: the boundary must not rest on a query
  // filter alone.
  const cutoff = Date.parse(FABRICATED_PAID_AT_CREATED_BEFORE)
  const candidates = paidRows.filter((row) => {
    const created = Date.parse(row.created_at)
    return Number.isFinite(created) && created < cutoff && hasFabricatedSignature(row)
  })

  const result: RepairMigratedInvoicePaidAtResult = {
    candidates: candidates.length,
    setToDate: 0,
    setToDateBySource: { provider: 0, journal_entry: 0 },
    setToNull: 0,
    leftAlone: {
      confirmedBySource: 0,
      ambiguousPaymentRows: 0,
      providerMaySupplyDate: 0,
      providerUnknown: 0,
      changedSinceRead: 0,
      notWritten: 0,
    },
    providers: [],
    writeError: null,
    dryRun,
  }
  if (candidates.length === 0) return result

  const { evidence: providerEvidence, providers } = await readProviderEvidence(supabase, companyId)
  result.providers = providers

  // Payment rows of the company, then the entries the candidates' rows name.
  const candidateIds = new Set(candidates.map((row) => row.id))
  const paymentRows = await fetchAllRows<PaymentRow & { id: string }>(({ from, to }) =>
    supabase
      .from('invoice_payments')
      .select('id, invoice_id, journal_entry_id')
      .eq('company_id', companyId)
      .order('id', { ascending: true })
      .range(from, to),
  )
  const paymentsByInvoice = new Map<string, PaymentRow[]>()
  for (const row of paymentRows) {
    if (!candidateIds.has(row.invoice_id)) continue
    const list = paymentsByInvoice.get(row.invoice_id) ?? []
    list.push(row)
    paymentsByInvoice.set(row.invoice_id, list)
  }

  const entryIds = [...new Set(
    [...paymentsByInvoice.values()].flat().map((row) => row.journal_entry_id).filter((id): id is string => !!id),
  )]
  const entriesById = new Map<string, JournalEntryRow>()
  for (const ids of chunk(entryIds, ID_CHUNK)) {
    const { data, error } = await supabase
      .from('journal_entries')
      .select('id, entry_date, status')
      .eq('company_id', companyId)
      .in('id', ids)
    if (error) throw new Error(`journal_entries read failed: ${error.message}`)
    for (const entry of (data ?? []) as JournalEntryRow[]) entriesById.set(entry.id, entry)
  }

  // Plan: one compare-and-set group per (stored value, new value).
  const groups = new Map<string, { stored: string; next: string | null; source: PaidAtSource | null; ids: string[] }>()
  for (const row of candidates) {
    const payments = paymentsByInvoice.get(row.id) ?? []
    const resolution = resolvePaidAt({
      providerPaymentDate: providerPaymentDates?.get(row.id) ?? null,
      paymentRows: payments.length,
      journalEntries: payments.map((p) => (p.journal_entry_id ? entriesById.get(p.journal_entry_id) ?? null : null)),
    })

    let next: string | null
    let source: PaidAtSource | null = null
    if (resolution.kind === 'date') {
      if (resolution.date === row.invoice_date) {
        result.leftAlone.confirmedBySource++
        continue
      }
      next = paidAtFromDate(resolution.date)
      source = resolution.source
    } else if (resolution.kind === 'ambiguous') {
      result.leftAlone.ambiguousPaymentRows++
      continue
    } else if (providerEvidence === 'dateless') {
      next = null
    } else {
      if (providerEvidence === 'may_supply_date') result.leftAlone.providerMaySupplyDate++
      else result.leftAlone.providerUnknown++
      continue
    }

    const stored = row.paid_at as string
    const key = `${stored}|${next ?? 'null'}|${source ?? ''}`
    const group = groups.get(key) ?? { stored, next, source, ids: [] }
    group.ids.push(row.id)
    groups.set(key, group)
  }

  const writes = [...groups.values()].flatMap((group) =>
    chunk(group.ids, ID_CHUNK).map((ids) => ({ ...group, ids })),
  )
  const count = (write: { next: string | null; source: PaidAtSource | null }, n: number) => {
    if (write.next === null) result.setToNull += n
    else {
      result.setToDate += n
      if (write.source) result.setToDateBySource[write.source] += n
    }
  }

  if (dryRun) {
    for (const write of writes) count(write, write.ids.length)
  } else {
    let done = 0
    for (const slice of chunk(writes, WRITE_CONCURRENCY)) {
      if (result.writeError) break
      const outcomes = await Promise.all(slice.map(async (write) => {
        // Compare-and-set: only a row that still holds the fabricated value,
        // is still paid and still predates the fix is written.
        const { data, error } = await supabase
          .from('invoices')
          .update({ paid_at: write.next })
          .eq('company_id', companyId)
          .eq('status', 'paid')
          .eq('paid_at', write.stored)
          .lt('created_at', FABRICATED_PAID_AT_CREATED_BEFORE)
          .in('id', write.ids)
          .select('id')
        return { write, written: error ? 0 : (data ?? []).length, error }
      }))
      for (const { write, written, error } of outcomes) {
        done++
        if (error) {
          // A trigger said no (archived migration-reset source, or a member
          // without write access). Not worked around: the run stops.
          result.writeError ??= { code: error.code ?? null, message: error.message }
          result.leftAlone.notWritten += write.ids.length
          continue
        }
        count(write, written)
        result.leftAlone.changedSinceRead += write.ids.length - written
      }
    }
    for (const write of writes.slice(done)) result.leftAlone.notWritten += write.ids.length
  }

  if (result.writeError) {
    log.error('migrated invoice paid_at repair stopped on a refused write', new Error(result.writeError.message), {
      companyId,
      code: result.writeError.code,
    })
  }
  log.info('repaired fabricated paid_at on migrated invoices', {
    companyId,
    providerEvidence,
    ...result,
    writeError: result.writeError?.code ?? null,
  })

  return result
}
