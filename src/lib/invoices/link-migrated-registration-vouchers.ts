/**
 * Corroborate provider-named vouchers against the imported journal. Registration
 * links require the matching AP/AR amount. A dated Bokio cash-purchase reference
 * on a paid SEK supplier invoice delegates settlement to the existing guarded
 * attachment RPC and keeps registration_journal_entry_id empty.
 *
 * An exact source entry date selects its fiscal year, including cross-year
 * booking. Providers without one retain the conservative invoice-date corridor.
 * A series-less ref (Visma names the voucher number only) that several series
 * carry is narrowed by that corridor and then by the AP/AR amount; anything
 * short of one survivor stays ambiguous.
 * Duplicate, reversed, open-source cash and amount-mismatched evidence is
 * reported for review. No journal entry or line is written here.
 *
 * A reversed verifikat is never a registration voucher, so refs resolve from
 * live (posted) entries only. That matters after an SIE re-sync: replacing a
 * fiscal year reverses every verifikat the previous import brought in and
 * imports the year again, so each source ref is carried twice in that year,
 * by the reversed first copy and by the live second one. Counting the copy
 * made every re-synced ref ambiguous. An invoice an earlier run linked to the
 * first copy moves to the live one (`replacesJournalEntryId`): from that
 * reversed copy only, and only while no other invoice holds the copy.
 *
 * A foreign-currency invoice is the one exception to an exact AP/AR match
 * (crm#1039, founder decision 2026-10-06). Its SEK total came from our rate
 * index, while the source booked the verifikat at its own rate. When the
 * verifikat its ref singles out books within LEDGER_RATE_BAND of that total,
 * it is this invoice at the source's rate: the invoice links and takes the
 * SEK amount the verifikat books (`sourceRate`), so the reskontra agrees with
 * 151x/244x and a later payment clears them exactly. Further apart it is a
 * different receivable or skuld and stays amountMismatch. The band never
 * picks between several candidates for a series-less ref: that stays exact.
 */

import { chunk } from '@/lib/utils'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { ORE_TOLERANCE, roundOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { fetchLinesByEntryIds } from '@/lib/bookkeeping/entry-lines'
import { LEDGER_RATE_BAND } from '@/lib/bookkeeping/supplier-payment-amounts'
import {
  buildVoucherIndex,
  fetchFiscalPeriods,
  fetchSourceRefVouchers,
  fetchVouchersForNumbers,
  periodIdForDate,
  resolveDatedRef,
  sourceRefKey,
  voucherKey,
  type FiscalPeriodRow,
  type VoucherIndex,
  type VoucherRow,
} from '@/lib/documents/voucher-ref-resolver'
import type { SourceVoucherRefDto } from '@/lib/providers/dto'
import { attachSupplierInvoiceSettlementVoucher } from './attach-settlement-voucher'

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
  /** Only supplied for a corroborated source cash-purchase voucher. */
  settlement?: { sourcePaid: boolean; userId: string }
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
  linkType?: 'registration' | 'settlement'
  /**
   * Set for `amountMismatch` when both sides are known: what the verifikat
   * books on 151x/244x (or the bank, for a cash purchase) and the invoice's
   * SEK total. Lets a reviewer see the difference without parsing `reason`.
   */
  bookedSek?: number
  expectedSek?: number
  /** Machine-readable one-liner for logs and the migration report. */
  reason: string
  /**
   * Set for `linked` when a foreign-currency invoice takes the SEK amount its
   * verifikat books at the source's rate (see the module header). A dry run
   * reports it for the caller to write; a real run writes it with the link.
   */
  sourceRate?: SourceRateValues
  /**
   * Set for `linked` when the invoice still points at a reversed copy of the
   * verifikat that an SIE re-sync replaced (see the module header): the link
   * moves from this entry to `journalEntryId`. A dry run reports it for the
   * caller to write; commit_provider_migration_followup accepts it only for
   * the reversed copy of the same source voucher in the same fiscal year.
   */
  replacesJournalEntryId?: string
}

/**
 * What a foreign-currency invoice takes from the verifikat that booked it.
 * Its own currency amounts, status and payments are never touched.
 */
export interface SourceRateValues {
  /** The invoice total in its own currency that the rate is derived from. */
  total: number
  /** The amount the verifikat books on 151x/244x (a supplier credit note's magnitude). */
  totalSek: number
  subtotalSek: number
  vatAmountSek: number
  /** totalSek / total, the source's own rate where four or six decimals give totalSek back. */
  exchangeRate: number
  /** The verifikat's date: the day the source booked it at that rate. */
  exchangeRateDate: string
  /** What the invoice carried before, at the rate the import found. */
  previousTotalSek: number | null
  previousExchangeRate: number | null
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
  /**
   * The invoice, or the verifikat, already carried a registration link, or
   * another invoice holds a reversed copy of the verifikat.
   */
  alreadyLinked: number
}

export interface RegistrationLinkResult extends RegistrationLinkCounts {
  reports: RegistrationLinkReport[]
}

export interface LinkMigratedRegistrationVouchersOptions {
  supabase: SupabaseClient
  companyId: string
  invoices: MigratedInvoiceLinkInput[]
  /** Read only source voucher numbers in a durable worker's current batch. */
  bounded?: boolean
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

/** The row a source-rate link derives its values from. */
interface ForeignInvoiceRow {
  id: string
  currency: string | null
  total: number | null
  subtotal: number | null
  vat_amount: number | null
  total_sek: number | null
  exchange_rate: number | null
  is_credit_note?: boolean | null
}

/** invoices_exchange_rate_check and supplier_invoices_exchange_rate_check. */
const MAX_EXCHANGE_RATE = 100000

function isForeignCurrency(code: string | null | undefined): boolean {
  return !!code && code.toUpperCase() !== 'SEK'
}

/**
 * Whether the verifikat books the invoice's SEK total at another rate: within
 * LEDGER_RATE_BAND of it, the band match_batch_allocate,
 * link_supplier_invoice_to_voucher and the manual supplier payment read a rate
 * difference by. Further apart it is a different receivable or skuld.
 */
function withinRateBand(booked: number, expected: number): boolean {
  return Math.abs(booked - expected) <= Math.abs(expected) * LEDGER_RATE_BAND
}

/**
 * The SEK values a foreign-currency invoice takes from its verifikat, or null
 * when its row cannot carry them (not foreign-currency now, a zero total, a
 * rate the column refuses). `booked` is the verifikat's net debit on 151x or
 * net credit on 244x; a supplier credit note debits 2440 but is stored in
 * magnitudes.
 */
function sourceRateValues(row: ForeignInvoiceRow | undefined, kind: MigratedInvoiceKind, booked: number,
  entryDate: string | undefined): SourceRateValues | null {
  if (!row || !isForeignCurrency(row.currency) || !entryDate) return null
  const total = Number(row.total)
  const totalSek = roundOre(kind === 'supplier' && row.is_credit_note ? -booked : booked)
  const quotient = totalSek / total
  if (!Number.isFinite(quotient) || quotient <= 0 || quotient >= MAX_EXCHANGE_RATE) return null
  // The source's own rate usually has four decimals. Take the shortest rate
  // whose product lies within 0.004 kr of the booked amount: every öre
  // rounding then gives that amount back, roundOre as well as the plain one
  // the reskontra and the payment lines use.
  const exchangeRate = [4, 6]
    .map((places) => Math.round(quotient * 10 ** places) / 10 ** places)
    .find((rate) => Math.abs(total * rate - totalSek) <= 0.004) ?? quotient
  return {
    total,
    totalSek,
    subtotalSek: roundOre(Number(row.subtotal ?? 0) * exchangeRate),
    vatAmountSek: roundOre(Number(row.vat_amount ?? 0) * exchangeRate),
    exchangeRate,
    exchangeRateDate: entryDate,
    previousTotalSek: row.total_sek == null ? null : Number(row.total_sek),
    previousExchangeRate: row.exchange_rate == null ? null : Number(row.exchange_rate),
  }
}

/** The rows of the invoices that may link at the source's rate, company-scoped. */
async function fetchForeignInvoiceRows(
  supabase: SupabaseClient,
  companyId: string,
  kind: MigratedInvoiceKind,
  ids: string[],
): Promise<ForeignInvoiceRow[]> {
  const rows: ForeignInvoiceRow[] = []
  for (const part of chunk(ids, ID_CHUNK)) {
    rows.push(...await fetchAllRows<ForeignInvoiceRow>(({ from, to }) => kind === 'supplier'
      ? supabase
          .from('supplier_invoices')
          .select('id, currency, total, subtotal, vat_amount, total_sek, exchange_rate, is_credit_note')
          .eq('company_id', companyId)
          .in('id', part)
          .order('id', { ascending: true })
          .range(from, to)
      : supabase
          .from('invoices')
          .select('id, currency, total, subtotal, vat_amount, total_sek, exchange_rate')
          .eq('company_id', companyId)
          .in('id', part)
          .order('id', { ascending: true })
          .range(from, to)))
  }
  return rows
}

/**
 * The link and the SEK values in one write: from NULL (or from the reversed
 * copy the invoice still points at), and only while the invoice still has the
 * total the rate was derived from.
 */
async function writeSourceRateLink(
  supabase: SupabaseClient,
  companyId: string,
  input: MigratedInvoiceLinkInput,
  entryId: string,
  values: SourceRateValues,
  replaces: string | undefined,
) {
  // Every chain is spelled out from `.from()`: tests/schema/no-phantom-columns
  // checks the columns of literal chains only.
  if (input.kind === 'supplier') {
    if (replaces) {
      return supabase
        .from('supplier_invoices')
        .update({
          registration_journal_entry_id: entryId,
          exchange_rate: values.exchangeRate,
          exchange_rate_date: values.exchangeRateDate,
          total_sek: values.totalSek,
          subtotal_sek: values.subtotalSek,
          vat_amount_sek: values.vatAmountSek,
        })
        .eq('id', input.invoiceId)
        .eq('company_id', companyId)
        .eq('registration_journal_entry_id', replaces)
        .eq('total', values.total)
        .select('id')
    }
    return supabase
      .from('supplier_invoices')
      .update({
        registration_journal_entry_id: entryId,
        exchange_rate: values.exchangeRate,
        exchange_rate_date: values.exchangeRateDate,
        total_sek: values.totalSek,
        subtotal_sek: values.subtotalSek,
        vat_amount_sek: values.vatAmountSek,
      })
      .eq('id', input.invoiceId)
      .eq('company_id', companyId)
      .is('registration_journal_entry_id', null)
      .eq('total', values.total)
      .select('id')
  }
  if (replaces) {
    return supabase
      .from('invoices')
      .update({
        journal_entry_id: entryId,
        exchange_rate: values.exchangeRate,
        exchange_rate_date: values.exchangeRateDate,
        total_sek: values.totalSek,
        subtotal_sek: values.subtotalSek,
        vat_amount_sek: values.vatAmountSek,
      })
      .eq('id', input.invoiceId)
      .eq('company_id', companyId)
      .eq('journal_entry_id', replaces)
      .eq('total', values.total)
      .select('id')
  }
  return supabase
    .from('invoices')
    .update({
      journal_entry_id: entryId,
      exchange_rate: values.exchangeRate,
      exchange_rate_date: values.exchangeRateDate,
      total_sek: values.totalSek,
      subtotal_sek: values.subtotalSek,
      vat_amount_sek: values.vatAmountSek,
    })
    .eq('id', input.invoiceId)
    .eq('company_id', companyId)
    .is('journal_entry_id', null)
    .eq('total', values.total)
    .select('id')
}

/**
 * Whether an entry is a live copy. The fetchers read posted and reversed
 * entries only; a row without a status (none in practice) stays a candidate,
 * as before, and the status read in the corroboration step still refuses
 * anything that is not posted.
 */
function isLiveCopy(row: VoucherRow): boolean {
  return row.status !== 'reversed'
}

type Resolution =
  | { outcome: 'resolved'; entryId: string }
  /** Several dated verifikat; the AP/AR amount decides once the lines are read. */
  | { outcome: 'candidates'; entryIds: string[]; reason: string }
  | { outcome: 'noRef' | 'refNotFetched' | 'unresolved' | 'ambiguous'; reason: string }

/**
 * The verifikat must be dated near the invoice. See the module header: a
 * same-numbered voucher a year away is the previous year's, and the amount
 * check alone does not reliably tell them apart.
 */
function checkEntryDate(row: VoucherRow, input: MigratedInvoiceLinkInput): Resolution {
  if (input.sourceVoucher?.date) {
    return row.entry_date === input.sourceVoucher.date
      ? { outcome: 'resolved', entryId: row.id }
      : { outcome: 'unresolved', reason: 'source and imported voucher dates differ' }
  }
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
 * Series-less refs (a bare "329") search every series in that year: one hit
 * is checked against the date corridor, several are narrowed by it and hand
 * the survivors to the amount check.
 *
 * `index` holds the live entries only; `reversedCopies` the reversed ones,
 * which never resolve a ref and only explain why one is unresolved.
 */
function resolveInput(
  index: VoucherIndex,
  reversedCopies: VoucherIndex,
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

  const referenceDate = ref.date ?? input.invoiceDate
  const periodId = referenceDate ? periodIdForDate(periods, referenceDate) : null
  if (!periodId) {
    return { outcome: 'unresolved', reason: `no fiscal period covers invoice date ${input.invoiceDate || '(none)'}` }
  }

  if (ref.series === null) {
    const hits = (index.byNumber.get(ref.number) ?? []).filter((v) => v.fiscal_period_id === periodId)
    if (hits.length === 1) return checkEntryDate(hits[0], input)
    if (hits.length === 0) {
      const onlyReversed = (reversedCopies.byNumber.get(ref.number) ?? []).some((v) => v.fiscal_period_id === periodId)
      return { outcome: 'unresolved', reason: onlyReversed
        ? `source number ${ref.number} is carried only by reversed (storno) verifikat in that fiscal year`
        : `no migrated verifikat carries source number ${ref.number} in that fiscal year` }
    }
    // A ledger with several series (kundfakturor in K, their payments in I)
    // carries the same number more than once a year. The payment voucher
    // sits weeks later and books the receivable on the other side, so the
    // date corridor and then the AP/AR amount single out the registration.
    const dated = hits.filter((v) => checkEntryDate(v, input).outcome === 'resolved')
    if (dated.length === 1) return { outcome: 'resolved', entryId: dated[0].id }
    if (dated.length === 0) {
      return { outcome: 'unresolved', reason: `source number ${ref.number} matches ${hits.length} series in that fiscal year, none dated with the invoice` }
    }
    return { outcome: 'candidates', entryIds: dated.map((v) => v.id),
      reason: `source number ${ref.number} matches ${dated.length} series dated with the invoice` }
  }

  const entryId = resolveDatedRef(index, periods, { series: ref.series, number: ref.number, date: referenceDate })
  if (entryId) {
    // resolveDatedRef hands back the id; the row (with its entry_date) sits
    // in the period-agnostic index under the same source ref.
    const row = (index.bySourceRef.get(sourceRefKey(ref.series, ref.number)) ?? []).find((v) => v.id === entryId)
    if (!row) {
      return { outcome: 'unresolved', reason: `source ref ${ref.series}${ref.number} resolved to an entry the index does not carry` }
    }
    return checkEntryDate(row, input)
  }

  const key = voucherKey(periodId, ref.series, ref.number)
  if (index.ambiguousPeriodKeys.has(key)) {
    return { outcome: 'ambiguous', reason: `source ref ${ref.series}${ref.number} is carried by more than one verifikat in that fiscal year` }
  }
  if (reversedCopies.byPeriodKey.has(key) || reversedCopies.ambiguousPeriodKeys.has(key)) {
    return { outcome: 'unresolved', reason: `source ref ${ref.series}${ref.number} is carried only by reversed (storno) verifikat in that fiscal year` }
  }
  return { outcome: 'unresolved', reason: `no migrated verifikat carries source ref ${ref.series}${ref.number} in that fiscal year` }
}

interface EntryRow {
  id: string
  status: string
  reversed_by_id?: string | null
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

  const report = (input: MigratedInvoiceLinkInput, outcome: RegistrationLinkOutcome, reason: string, journalEntryId?: string,
    amounts?: { bookedSek: number; expectedSek: number }) => {
    counts[outcome]++
    reports.push({
      invoiceId: input.invoiceId,
      kind: input.kind,
      invoiceNumber: input.invoiceNumber ?? null,
      outcome,
      reason,
      ...(journalEntryId ? { journalEntryId } : {}),
      ...(amounts ?? {}),
    })
  }

  counts.scanned = invoices.length
  if (invoices.length === 0) return { ...counts, reports }

  // 1. The company's migrated verifikat and fiscal years, indexed once.
  const [vouchers, periods] = await Promise.all([
    // A bounded worker batch should not reload a company's entire ledger.
    options.bounded
      ? fetchVouchersForNumbers(supabase, companyId,
          invoices.flatMap(input => input.sourceVoucher ? [input.sourceVoucher.number] : []))
      : fetchSourceRefVouchers(supabase, companyId),
    fetchFiscalPeriods(supabase, companyId),
  ])
  // A reversed copy never resolves a ref (see the module header). It is kept
  // apart to explain an unresolved ref, and to recognise an invoice that still
  // points at the copy an SIE re-sync replaced.
  const index = buildVoucherIndex(vouchers.filter(isLiveCopy))
  const reversedCopies = buildVoucherIndex(vouchers.filter((v) => !isLiveCopy(v)))

  // 2. Resolve refs in memory. Two inputs landing on one verifikat is a
  //    contest neither side can win without guessing: both stay NULL.
  const resolved: { input: MigratedInvoiceLinkInput; entryId: string }[] = []
  const contested: { input: MigratedInvoiceLinkInput; entryIds: string[]; reason: string }[] = []
  const claimants = new Map<string, MigratedInvoiceLinkInput[]>()
  const claim = (input: MigratedInvoiceLinkInput, entryId: string) => {
    resolved.push({ input, entryId })
    const list = claimants.get(entryId)
    if (list) list.push(input)
    else claimants.set(entryId, [input])
  }
  for (const input of invoices) {
    const resolution = resolveInput(index, reversedCopies, periods, input)
    if (resolution.outcome === 'candidates') {
      contested.push({ input, entryIds: resolution.entryIds, reason: resolution.reason })
      continue
    }
    if (resolution.outcome !== 'resolved') {
      report(input, resolution.outcome, resolution.reason)
      continue
    }
    claim(input, resolution.entryId)
  }

  if (resolved.length === 0 && contested.length === 0) return { ...counts, reports }

  const entryIds = [...new Set([...claimants.keys(), ...contested.flatMap((c) => c.entryIds)])]

  // 3. Corroboration reads: entry status, the AP/AR lines, and the invoices
  //    that already point at these entries. All company-scoped.
  const entriesById = new Map<string, EntryRow>()
  for (const ids of chunk(entryIds, ID_CHUNK)) {
    const rows = await fetchAllRows<EntryRow>(({ from, to }) =>
      supabase
        .from('journal_entries')
        .select('id, status, reversed_by_id')
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
  const bankNetCreditByEntry = new Map<string, number>()
  for (const line of lines) {
    const account = String(line.account_number ?? '')
    const debit = Number(line.debit_amount ?? 0)
    const credit = Number(line.credit_amount ?? 0)
    if (account.startsWith('19')) {
      bankNetCreditByEntry.set(line.journal_entry_id, roundOre((bankNetCreditByEntry.get(line.journal_entry_id) ?? 0) + credit - debit))
    }
    if (account.startsWith(AP_ACCOUNT_PREFIX)) {
      apNetCreditByEntry.set(line.journal_entry_id, roundOre((apNetCreditByEntry.get(line.journal_entry_id) ?? 0) + credit - debit))
    }
    if (account.startsWith(AR_ACCOUNT_PREFIX)) {
      arNetDebitByEntry.set(line.journal_entry_id, roundOre((arNetDebitByEntry.get(line.journal_entry_id) ?? 0) + debit - credit))
    }
  }

  // 3b. Several dated candidates for one series-less ref: the verifikat that
  //     books the invoice total on the AP/AR side is the registration voucher.
  //     A payment voucher with the same number nets the other way, so it drops
  //     out here; two registrations with the total stay ambiguous.
  for (const { input, entryIds: ids, reason } of contested) {
    const expected = typeof input.totalSek === 'number' && Number.isFinite(input.totalSek) ? roundOre(input.totalSek) : null
    const booked = input.kind === 'supplier' ? apNetCreditByEntry : arNetDebitByEntry
    const corroborated = expected === null ? [] : ids.filter((id) => {
      const net = booked.get(id)
      return net !== undefined && Math.abs(net - expected) <= ORE_TOLERANCE
    })
    if (corroborated.length !== 1) {
      report(input, 'ambiguous', `${reason}; ${corroborated.length} of them carry the invoice total`)
      continue
    }
    claim(input, corroborated[0])
  }
  if (resolved.length === 0) return { ...counts, reports }

  // The reversed copies of a candidate: the same source ref in the same fiscal
  // year. Their holders are read with the candidates' own, so an invoice an
  // earlier run linked to a copy can move to the live verifikat.
  const vouchersById = new Map(vouchers.map((v) => [v.id, v]))
  const reversedCopiesOf = (entryId: string): string[] => {
    const live = vouchersById.get(entryId)
    if (!live || live.source_voucher_series == null || live.source_voucher_number == null) return []
    return (reversedCopies.bySourceRef.get(sourceRefKey(live.source_voucher_series, live.source_voucher_number)) ?? [])
      .filter((copy) => copy.fiscal_period_id === live.fiscal_period_id)
      .map((copy) => copy.id)
  }
  const referenceIds = [...new Set([...entryIds, ...entryIds.flatMap(reversedCopiesOf)])]

  // Invoice ids already referencing each entry, on either register.
  const referencedBy = new Map<string, string[]>()
  const noteReference = (entryId: string | null, invoiceId: string) => {
    if (!entryId) return
    const list = referencedBy.get(entryId)
    if (list) list.push(invoiceId)
    else referencedBy.set(entryId, [invoiceId])
  }
  for (const ids of chunk(referenceIds, ID_CHUNK)) {
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

  // 3c. A foreign-currency invoice whose verifikat books its SEK total at the
  //     source's rate takes that amount (see the module header). Its row is
  //     what the rate is derived from, so it is read for those invoices only.
  const bookedOn = (input: MigratedInvoiceLinkInput, entryId: string) =>
    (input.kind === 'supplier' ? apNetCreditByEntry : arNetDebitByEntry).get(entryId)
  const atSourceRate = (input: MigratedInvoiceLinkInput, booked: number, expected: number) =>
    isForeignCurrency(input.currencyCode) && Math.abs(booked - expected) > ORE_TOLERANCE && withinRateBand(booked, expected)
  const entryDates = new Map(vouchers.map((v) => [v.id, v.entry_date]))
  const foreignRows = new Map<string, ForeignInvoiceRow>()
  for (const kind of ['customer', 'supplier'] as const) {
    const ids = [...new Set(resolved.flatMap(({ input, entryId }) => {
      const booked = bookedOn(input, entryId)
      return input.kind === kind && booked !== undefined && typeof input.totalSek === 'number'
        && Number.isFinite(input.totalSek) && atSourceRate(input, booked, roundOre(input.totalSek)) ? [input.invoiceId] : []
    }))]
    if (ids.length === 0) continue
    for (const row of await fetchForeignInvoiceRows(supabase, companyId, kind, ids)) foreignRows.set(row.id, row)
  }
  let sourceRated = 0
  let movedFromCopy = 0

  // 4. Decide and write, one invoice at a time: from NULL, or from the
  //    reversed copy of the same verifikat that the invoice still points at.
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
    if (entry.status !== 'posted' || entry.reversed_by_id) {
      report(input, 'unresolved', entry.reversed_by_id
        ? 'verifikat has been reversed (storno)'
        : `verifikat is ${entry.status}, not posted`)
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
    // A re-synced year: the invoice may still point at the reversed copy an
    // earlier run linked, and then moves to the live one. A copy another
    // invoice points at makes two invoices claim one source voucher.
    const copyHolders = reversedCopiesOf(entryId).flatMap((copy) =>
      (referencedBy.get(copy) ?? []).map((holder) => ({ copy, holder })))
    if (copyHolders.some(({ holder }) => holder !== input.invoiceId)) {
      report(input, 'alreadyLinked', 'a reversed copy of the verifikat is the registration voucher of another invoice', entryId)
      continue
    }
    const replaces = copyHolders.find(({ holder }) => holder === input.invoiceId)?.copy

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
      if (input.kind === 'supplier' && input.settlement && input.sourceVoucher?.date) {
        const cash = bankNetCreditByEntry.get(entryId)
        if (!input.settlement.sourcePaid) {
          report(input, 'unresolved', 'source invoice is open but names a cash-purchase voucher')
          continue
        }
        if (input.currencyCode !== 'SEK' || expected <= 0 || cash === undefined || Math.abs(cash - expected) > ORE_TOLERANCE) {
          report(input, 'amountMismatch', 'cash-purchase voucher does not corroborate the SEK invoice total', undefined,
            cash === undefined ? undefined : { bookedSek: cash, expectedSek: expected })
          continue
        }
        const attached = await attachSupplierInvoiceSettlementVoucher(supabase, {
          companyId, userId: input.settlement.userId, supplierInvoiceId: input.invoiceId,
          journalEntryId: entryId, dryRun, notes: 'Bokio source invoice reference',
        })
        if (!attached.ok) {
          report(input, attached.code === 'ATTACH_SI_SETTLEMENT_ALREADY_LINKED' ? 'alreadyLinked' : 'unresolved', attached.code, entryId)
        } else {
          report(input, 'linked', dryRun ? 'would attach settlement evidence (dry run)' : 'settlement evidence attached', entryId)
          reports[reports.length - 1].linkType = 'settlement'
        }
        continue
      }
      // No AP/AR line at all: the provider named a voucher, but it is not a
      // registration voucher for this kind of invoice. A kontantmetod company
      // books on payment (Dr cost / Cr bank) and may still name that voucher.
      report(input, 'unresolved', `verifikat has no ${input.kind === 'supplier' ? '244x' : '151x'} line: not a registration voucher (kontantmetod or payment voucher)`)
      continue
    }
    const sourceRate = atSourceRate(input, booked, expected)
      ? sourceRateValues(foreignRows.get(input.invoiceId), input.kind, booked, entryDates.get(entryId))
      : null
    if (!sourceRate && Math.abs(booked - expected) > ORE_TOLERANCE) {
      const currency = (input.currencyCode ?? 'SEK').toUpperCase()
      report(
        input,
        'amountMismatch',
        currency !== 'SEK'
          ? `${side} is ${booked} but the invoice total is ${expected} SEK; the invoice is in ${currency} and ${withinRateBand(booked, expected) ? 'its row cannot take the source rate' : `the two are more than ${LEDGER_RATE_BAND * 100}% apart, so the verifikat is not this invoice at another rate`}`
          : `${side} is ${booked} but the invoice total is ${expected} SEK`,
        undefined,
        { bookedSek: booked, expectedSek: expected },
      )
      continue
    }

    const atRate = sourceRate ? ' at the source rate' : ''
    const noteLink = () => {
      const linked = reports[reports.length - 1]
      if (sourceRate) {
        linked.sourceRate = sourceRate
        sourceRated++
      }
      if (replaces) {
        linked.replacesJournalEntryId = replaces
        movedFromCopy++
      }
    }

    if (dryRun) {
      report(input, 'linked', `${replaces ? 'would move the link from its reversed copy' : 'would link'}${atRate} (dry run)`, entryId)
      noteLink()
      continue
    }

    // `.is(null)`, or `.eq()` on the reversed copy the link moves from, makes
    // the write a no-op when the row's link changed since it was read;
    // `.select('id')` is how that no-op becomes visible.
    const { data, error } = sourceRate
      ? await writeSourceRateLink(supabase, companyId, input, entryId, sourceRate, replaces)
      : input.kind === 'supplier'
      ? replaces
        ? await supabase
            .from('supplier_invoices')
            .update({ registration_journal_entry_id: entryId })
            .eq('id', input.invoiceId)
            .eq('company_id', companyId)
            .eq('registration_journal_entry_id', replaces)
            .select('id')
        : await supabase
            .from('supplier_invoices')
            .update({ registration_journal_entry_id: entryId })
            .eq('id', input.invoiceId)
            .eq('company_id', companyId)
            .is('registration_journal_entry_id', null)
            .select('id')
      : replaces
      ? await supabase
          .from('invoices')
          .update({ journal_entry_id: entryId })
          .eq('id', input.invoiceId)
          .eq('company_id', companyId)
          .eq('journal_entry_id', replaces)
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
      const changed = replaces ? 'invoice no longer points at the reversed copy' : 'invoice already carried a registration link'
      report(input, 'alreadyLinked', sourceRate ? `${changed}, or its total changed since it was read` : changed, entryId)
      continue
    }
    report(input, 'linked', `${replaces ? 'registration voucher linked in place of its reversed copy' : 'registration voucher linked'}${atRate}`, entryId)
    noteLink()
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
    linkedAtSourceRate: sourceRated,
    movedFromReversedCopy: movedFromCopy,
  })

  return { ...counts, reports }
}
