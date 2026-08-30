/**
 * Link migrated invoices to the REGISTRATION voucher that booked them in the
 * source system.
 *
 * A provider migration (Visma, Fortnox via the arcim-migration extension)
 * imports the general ledger through SIE and the invoice registers through
 * the provider API. Nothing connected the two: every migrated invoice landed
 * with `registration_journal_entry_id` / `journal_entry_id` NULL although its
 * booking verifikat exists in the GL, so the UI reads "Inget verifikat", the
 * worklists count the invoice as unbooked, and an accrual company risks
 * booking it a second time on payment.
 *
 * The provider names the booking voucher on the invoice ("A329"); the SIE
 * import preserved that source ref on the entry it created. This module joins
 * the two and writes the link, and nothing else:
 *
 *  - it NEVER inserts, updates or deletes a journal entry or a line; the only
 *    writes are the two invoice-side foreign keys, and only from NULL;
 *  - a link is written only when the ref resolves to exactly ONE posted
 *    verifikat in the invoice's fiscal year, that verifikat is dated within a
 *    short corridor of the invoice date, its AP (244x) or AR (151x) net
 *    corroborates the invoice's SEK total to the öre, and no other invoice
 *    already points at it;
 *  - everything else stays NULL and is reported with its reason, so a
 *    kontantmetod invoice (the named voucher has no 244x/151x line), a split
 *    voucher, a credit note sharing its number or a duplicate ref is left for
 *    a human.
 *
 * The date corridor exists because source systems restart voucher numbering
 * every fiscal year and the invoice date picks the year on our side: a
 * December invoice that the source booked in January carries next year's
 * number, which in the invoice-date year belongs to an unrelated voucher from
 * the previous January. Requiring the verifikat to be dated near the invoice
 * rejects that voucher even when a recurring amount happens to match; the
 * cut-off invoice itself is reported `unresolved` rather than linked across
 * the year boundary (a wrong link is räkenskapsinformation, a missing one is
 * a worklist item).
 *
 * Foreign-currency invoices are corroborated on `total_sek`, which the
 * migration derives from OUR rate index, while the source voucher was booked
 * at the source system's rate. The two rarely agree to the öre, so such
 * invoices normally land in `amountMismatch` with a reason that says so; the
 * bucket is honest (the SEK amounts do differ), not a bookkeeping fault.
 *
 * Idempotent: re-running over already-linked invoices reports `alreadyLinked`
 * and writes nothing. Payment vouchers are out of scope here; they are linked
 * by lib/invoices/bulk-reconcile-supplier-vouchers.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { ORE_TOLERANCE, roundOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { fetchLinesByEntryIds } from '@/lib/bookkeeping/entry-lines'
import {
  buildVoucherIndex,
  fetchFiscalPeriods,
  fetchSourceRefVouchers,
  periodIdForDate,
  resolveDatedRef,
  sourceRefKey,
  voucherKey,
  type FiscalPeriodRow,
  type VoucherIndex,
  type VoucherRow,
} from '@/lib/documents/voucher-ref-resolver'
import type { SourceVoucherRefDto } from '@/lib/providers/dto'

const log = createLogger('link-migrated-registration-vouchers')

export type MigratedInvoiceKind = 'supplier' | 'customer'

export interface MigratedInvoiceLinkInput {
  /** `supplier_invoices.id` or `invoices.id`, depending on `kind`. */
  invoiceId: string
  kind: MigratedInvoiceKind
  /** The booking voucher as the provider reported it; absent = nothing to resolve. */
  sourceVoucher: SourceVoucherRefDto | null | undefined
  /**
   * True when the payload that carries the ref (Fortnox's detail form) was
   * never fetched, so an absent `sourceVoucher` means "unknown", not "none".
   * Reported as `refNotFetched` instead of `noRef`.
   */
  refNotFetched?: boolean
  /** Invoice date, ISO. Picks the fiscal year the ref is resolved in. */
  invoiceDate: string
  /** The invoice's SEK total. null = no SEK conversion was established. */
  totalSek: number | null | undefined
  /** Invoice currency; a non-SEK code explains an amount mismatch (see header). */
  currencyCode?: string | null
  /** Display only, carried into the report. */
  invoiceNumber?: string | null
}

export type RegistrationLinkOutcome =
  | 'linked'
  | 'noRef'
  | 'refNotFetched'
  | 'unresolved'
  | 'ambiguous'
  | 'amountMismatch'
  | 'alreadyLinked'

export interface RegistrationLinkReport {
  invoiceId: string
  kind: MigratedInvoiceKind
  invoiceNumber: string | null
  outcome: RegistrationLinkOutcome
  /** Set for `linked` and `alreadyLinked`, when the entry is known. */
  journalEntryId?: string
  /** Machine-readable one-liner for logs and the migration report. */
  reason: string
}

export interface RegistrationLinkCounts {
  /** Inputs considered. */
  scanned: number
  linked: number
  /** The provider reported no booking voucher for the invoice. */
  noRef: number
  /**
   * The provider payload that carries the ref was never fetched (detail
   * hydration ran out of budget or failed), so whether a voucher exists is
   * unknown. A re-run of /reconcile with more budget can still link these.
   */
  refNotFetched: number
  /**
   * The ref matched no posted verifikat in the invoice's fiscal year, the
   * verifikat it matched is dated outside the corridor around the invoice
   * date, or it carries no 244x/151x line (not a registration voucher).
   */
  unresolved: number
  /** More than one verifikat could be meant, or two invoices claim the same one. */
  ambiguous: number
  /** A verifikat resolved but its AP/AR net does not equal the invoice's SEK total. */
  amountMismatch: number
  /** The invoice, or the verifikat, already carried a registration link. */
  alreadyLinked: number
}

export interface RegistrationLinkResult extends RegistrationLinkCounts {
  reports: RegistrationLinkReport[]
}

export interface LinkMigratedRegistrationVouchersOptions {
  supabase: SupabaseClient
  companyId: string
  invoices: MigratedInvoiceLinkInput[]
  /** Resolve and corroborate but write nothing. Default false. */
  dryRun?: boolean
}

/** BAS 2440-2449 Leverantörsskulder: the registration voucher credits it. */
const AP_ACCOUNT_PREFIX = '244'
/** BAS 1510-1519 Kundfordringar: the registration voucher debits it. */
const AR_ACCOUNT_PREFIX = '151'
/** PostgREST puts `.in()` lists in the URL, so id filters are chunked. */
const ID_CHUNK = 200
/**
 * How far a registration voucher may be dated from its invoice. Both Visma
 * and Fortnox default the booking date to the invoice date; a late-booked
 * supplier invoice lands within a few weeks, and a pre-dated one (an invoice
 * dated the 1st, received and booked in late the month before) a few days
 * earlier. A voucher a year away is the previous year's same-numbered one.
 */
const ENTRY_DATE_DAYS_BEFORE = 14
const ENTRY_DATE_DAYS_AFTER = 90
const MS_PER_DAY = 86_400_000

/** Whole days from `from` to `to` (negative when `to` is earlier), or null for unparsable input. */
function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(from.slice(0, 10))
  const b = Date.parse(to.slice(0, 10))
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.round((b - a) / MS_PER_DAY)
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function emptyCounts(): RegistrationLinkCounts {
  return {
    scanned: 0,
    linked: 0,
    noRef: 0,
    refNotFetched: 0,
    unresolved: 0,
    ambiguous: 0,
    amountMismatch: 0,
    alreadyLinked: 0,
  }
}

type Resolution =
  | { outcome: 'resolved'; entryId: string }
  | { outcome: 'noRef' | 'refNotFetched' | 'unresolved' | 'ambiguous'; reason: string }

/**
 * The verifikat must be dated near the invoice. See the module header: a
 * same-numbered voucher a year away is the previous year's, and the amount
 * check alone does not reliably tell them apart.
 */
function checkEntryDate(row: VoucherRow, input: MigratedInvoiceLinkInput): Resolution {
  const days = daysBetween(input.invoiceDate, row.entry_date)
  if (days === null) {
    return { outcome: 'unresolved', reason: `verifikat date ${row.entry_date} or invoice date ${input.invoiceDate} is unreadable` }
  }
  if (days < -ENTRY_DATE_DAYS_BEFORE || days > ENTRY_DATE_DAYS_AFTER) {
    const where = days < 0 ? `${-days} days before` : `${days} days after`
    return {
      outcome: 'unresolved',
      reason: `verifikat is dated ${row.entry_date}, ${where} the invoice date ${input.invoiceDate}: outside the ${ENTRY_DATE_DAYS_BEFORE}/${ENTRY_DATE_DAYS_AFTER}-day corridor, likely another year's voucher`,
    }
  }
  return { outcome: 'resolved', entryId: row.id }
}

/**
 * One invoice's ref against the company's migrated verifikat, scoped to the
 * fiscal year of the invoice date and to the date corridor around it.
 * Series-less refs (a bare "329") search every series in that year and are
 * accepted only on a single hit.
 */
function resolveInput(
  index: VoucherIndex,
  periods: FiscalPeriodRow[],
  input: MigratedInvoiceLinkInput,
): Resolution {
  const ref = input.sourceVoucher
  if (!ref || !Number.isInteger(ref.number) || ref.number <= 0) {
    if (input.refNotFetched) {
      return { outcome: 'refNotFetched', reason: 'provider detail payload not fetched (hydration budget or failure): voucher unknown' }
    }
    return { outcome: 'noRef', reason: 'provider reported no booking voucher' }
  }

  const periodId = input.invoiceDate ? periodIdForDate(periods, input.invoiceDate) : null
  if (!periodId) {
    return { outcome: 'unresolved', reason: `no fiscal period covers invoice date ${input.invoiceDate || '(none)'}` }
  }

  if (ref.series === null) {
    const hits = (index.byNumber.get(ref.number) ?? []).filter((v) => v.fiscal_period_id === periodId)
    if (hits.length === 1) return checkEntryDate(hits[0], input)
    if (hits.length === 0) {
      return { outcome: 'unresolved', reason: `no migrated verifikat carries source number ${ref.number} in that fiscal year` }
    }
    return { outcome: 'ambiguous', reason: `source number ${ref.number} matches ${hits.length} series in that fiscal year` }
  }

  const entryId = resolveDatedRef(index, periods, { series: ref.series, number: ref.number, date: input.invoiceDate })
  if (entryId) {
    // resolveDatedRef hands back the id; the row (with its entry_date) sits
    // in the period-agnostic index under the same source ref.
    const row = (index.bySourceRef.get(sourceRefKey(ref.series, ref.number)) ?? []).find((v) => v.id === entryId)
    if (!row) {
      return { outcome: 'unresolved', reason: `source ref ${ref.series}${ref.number} resolved to an entry the index does not carry` }
    }
    return checkEntryDate(row, input)
  }

  if (index.ambiguousPeriodKeys.has(voucherKey(periodId, ref.series, ref.number))) {
    return { outcome: 'ambiguous', reason: `source ref ${ref.series}${ref.number} is carried by more than one verifikat in that fiscal year` }
  }
  return { outcome: 'unresolved', reason: `no migrated verifikat carries source ref ${ref.series}${ref.number} in that fiscal year` }
}

interface EntryRow {
  id: string
  status: string
}

interface LineRow {
  id: string
  journal_entry_id: string
  account_number: string
  debit_amount: number | null
  credit_amount: number | null
}

/**
 * Link every input whose ref resolves to exactly one posted, unclaimed,
 * amount-corroborated verifikat. See the module docstring for the guarantees.
 */
export async function linkMigratedRegistrationVouchers(
  options: LinkMigratedRegistrationVouchersOptions,
): Promise<RegistrationLinkResult> {
  const { supabase, companyId, invoices, dryRun = false } = options
  const counts = emptyCounts()
  const reports: RegistrationLinkReport[] = []

  const report = (input: MigratedInvoiceLinkInput, outcome: RegistrationLinkOutcome, reason: string, journalEntryId?: string) => {
    counts[outcome]++
    reports.push({
      invoiceId: input.invoiceId,
      kind: input.kind,
      invoiceNumber: input.invoiceNumber ?? null,
      outcome,
      reason,
      ...(journalEntryId ? { journalEntryId } : {}),
    })
  }

  counts.scanned = invoices.length
  if (invoices.length === 0) return { ...counts, reports }

  // 1. The company's migrated verifikat and fiscal years, indexed once.
  const [vouchers, periods] = await Promise.all([
    fetchSourceRefVouchers(supabase, companyId),
    fetchFiscalPeriods(supabase, companyId),
  ])
  const index = buildVoucherIndex(vouchers)

  // 2. Resolve refs in memory. Two inputs landing on one verifikat is a
  //    contest neither side can win without guessing: both stay NULL.
  const resolved: { input: MigratedInvoiceLinkInput; entryId: string }[] = []
  const claimants = new Map<string, MigratedInvoiceLinkInput[]>()
  for (const input of invoices) {
    const resolution = resolveInput(index, periods, input)
    if (resolution.outcome !== 'resolved') {
      report(input, resolution.outcome, resolution.reason)
      continue
    }
    resolved.push({ input, entryId: resolution.entryId })
    const list = claimants.get(resolution.entryId)
    if (list) list.push(input)
    else claimants.set(resolution.entryId, [input])
  }

  if (resolved.length === 0) return { ...counts, reports }

  const entryIds = [...claimants.keys()]

  // 3. Corroboration reads: entry status, the AP/AR lines, and the invoices
  //    that already point at these entries. All company-scoped.
  const entriesById = new Map<string, EntryRow>()
  for (const ids of chunk(entryIds, ID_CHUNK)) {
    const rows = await fetchAllRows<EntryRow>(({ from, to }) =>
      supabase
        .from('journal_entries')
        .select('id, status')
        .eq('company_id', companyId)
        .in('id', ids)
        .order('id', { ascending: true })
        .range(from, to),
    )
    for (const row of rows) entriesById.set(row.id, row)
  }

  const lines = await fetchLinesByEntryIds<LineRow>(
    supabase,
    entryIds,
    'journal_entry_id, account_number, debit_amount, credit_amount',
  )
  const apNetCreditByEntry = new Map<string, number>()
  const arNetDebitByEntry = new Map<string, number>()
  for (const line of lines) {
    const account = String(line.account_number ?? '')
    const debit = Number(line.debit_amount ?? 0)
    const credit = Number(line.credit_amount ?? 0)
    if (account.startsWith(AP_ACCOUNT_PREFIX)) {
      apNetCreditByEntry.set(line.journal_entry_id, roundOre((apNetCreditByEntry.get(line.journal_entry_id) ?? 0) + credit - debit))
    }
    if (account.startsWith(AR_ACCOUNT_PREFIX)) {
      arNetDebitByEntry.set(line.journal_entry_id, roundOre((arNetDebitByEntry.get(line.journal_entry_id) ?? 0) + debit - credit))
    }
  }

  // Invoice ids already referencing each entry, on either register.
  const referencedBy = new Map<string, string[]>()
  const noteReference = (entryId: string | null, invoiceId: string) => {
    if (!entryId) return
    const list = referencedBy.get(entryId)
    if (list) list.push(invoiceId)
    else referencedBy.set(entryId, [invoiceId])
  }
  for (const ids of chunk(entryIds, ID_CHUNK)) {
    const supplierRows = await fetchAllRows<{ id: string; registration_journal_entry_id: string | null }>(({ from, to }) =>
      supabase
        .from('supplier_invoices')
        .select('id, registration_journal_entry_id')
        .eq('company_id', companyId)
        .in('registration_journal_entry_id', ids)
        .order('id', { ascending: true })
        .range(from, to),
    )
    for (const row of supplierRows) noteReference(row.registration_journal_entry_id, row.id)

    const customerRows = await fetchAllRows<{ id: string; journal_entry_id: string | null }>(({ from, to }) =>
      supabase
        .from('invoices')
        .select('id, journal_entry_id')
        .eq('company_id', companyId)
        .in('journal_entry_id', ids)
        .order('id', { ascending: true })
        .range(from, to),
    )
    for (const row of customerRows) noteReference(row.journal_entry_id, row.id)
  }

  // 4. Decide and write, one invoice at a time, from NULL only.
  for (const { input, entryId } of resolved) {
    const contest = claimants.get(entryId) ?? []
    if (contest.length > 1) {
      report(input, 'ambiguous', `${contest.length} migrated invoices resolve to the same verifikat`)
      continue
    }

    const entry = entriesById.get(entryId)
    if (!entry) {
      // Resolved from the company's own index, so this is a vanished row or a
      // scope mismatch. Either way there is nothing safe to link.
      report(input, 'unresolved', 'verifikat not found in this company')
      continue
    }
    if (entry.status !== 'posted') {
      report(input, 'unresolved', `verifikat is ${entry.status}, not posted`)
      continue
    }

    const holders = referencedBy.get(entryId) ?? []
    if (holders.includes(input.invoiceId)) {
      report(input, 'alreadyLinked', 'invoice already links this verifikat', entryId)
      continue
    }
    if (holders.length > 0) {
      report(input, 'alreadyLinked', 'verifikat is already the registration voucher of another invoice', entryId)
      continue
    }

    if (typeof input.totalSek !== 'number' || !Number.isFinite(input.totalSek)) {
      report(input, 'amountMismatch', 'invoice has no SEK total to corroborate against')
      continue
    }
    const expected = roundOre(input.totalSek)
    const booked = input.kind === 'supplier'
      ? apNetCreditByEntry.get(entryId)
      : arNetDebitByEntry.get(entryId)
    const side = input.kind === 'supplier' ? 'net credit on 244x' : 'net debit on 151x'
    if (booked === undefined) {
      // No AP/AR line at all: the provider named a voucher, but it is not a
      // registration voucher for this kind of invoice. A kontantmetod company
      // books on payment (Dr cost / Cr bank) and may still name that voucher.
      report(input, 'unresolved', `verifikat has no ${input.kind === 'supplier' ? '244x' : '151x'} line: not a registration voucher (kontantmetod or payment voucher)`)
      continue
    }
    if (Math.abs(booked - expected) > ORE_TOLERANCE) {
      const currency = (input.currencyCode ?? 'SEK').toUpperCase()
      report(
        input,
        'amountMismatch',
        currency !== 'SEK'
          ? `${side} is ${booked} but the invoice total is ${expected} SEK; the invoice is in ${currency}, its SEK total uses our rate index and the source booked at its own rate, so the amounts are not corroborated`
          : `${side} is ${booked} but the invoice total is ${expected} SEK`,
      )
      continue
    }

    if (dryRun) {
      report(input, 'linked', 'would link (dry run)', entryId)
      continue
    }

    // `.is(null)` makes the write a no-op when the row gained a link since it
    // was read; `.select('id')` is how that no-op becomes visible.
    const { data, error } = input.kind === 'supplier'
      ? await supabase
          .from('supplier_invoices')
          .update({ registration_journal_entry_id: entryId })
          .eq('id', input.invoiceId)
          .eq('company_id', companyId)
          .is('registration_journal_entry_id', null)
          .select('id')
      : await supabase
          .from('invoices')
          .update({ journal_entry_id: entryId })
          .eq('id', input.invoiceId)
          .eq('company_id', companyId)
          .is('journal_entry_id', null)
          .select('id')

    if (error) {
      throw new Error(`Failed to link ${input.kind} invoice ${input.invoiceId} to verifikat ${entryId}: ${error.message}`)
    }
    if (!data || data.length === 0) {
      report(input, 'alreadyLinked', 'invoice already carried a registration link', entryId)
      continue
    }
    report(input, 'linked', 'registration voucher linked', entryId)
  }

  log.info('registration voucher linking complete', {
    companyId,
    dryRun,
    scanned: counts.scanned,
    linked: counts.linked,
    noRef: counts.noRef,
    refNotFetched: counts.refNotFetched,
    unresolved: counts.unresolved,
    ambiguous: counts.ambiguous,
    amountMismatch: counts.amountMismatch,
    alreadyLinked: counts.alreadyLinked,
  })

  return { ...counts, reports }
}
