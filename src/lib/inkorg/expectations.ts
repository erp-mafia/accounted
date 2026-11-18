/**
 * Expectations: what the company's regular suppliers will send next, and
 * which purchases under Saknar underlag are on their way rather than missing.
 *
 * Everything here is read from the company's own books and bank: the bank
 * rows it paid and the supplier invoices it registered. Never from Arkiv's
 * extracted agreements: the operator rule of 2026-09-27 keeps model-extracted
 * facts out of this for every company outside the brain
 * (ARKIV_BRAIN_COMPANY_IDS), so a cadence is computed from dates that
 * happened and a door from where the documents actually came in, which also
 * makes the answer the same for every company.
 *
 * Three steps, so the evidence read stays small:
 *   1. findPatterns: the history grouped by counterparty, keeping the ones
 *      that bill on a regular cadence (monthly, quarterly, yearly) and have
 *      not stopped. Dates and amounts only.
 *   2. evidenceDocumentIds: the documents behind each pattern's latest
 *      occurrences, for the caller to read (their door and their arrival).
 *   3. expectationsFrom: each pattern with how its documents usually arrive.
 * Then upcomingExpectations (Väntas senare) and purchasesOnTheWay (På väg).
 *
 * Pure: no client, no I/O, no React.
 */
import { resolveSekAmountOrNull } from '@/lib/bookkeeping/currency-utils'
import { addDaysIso, addMonthsIso, daysBetweenIso, todayIsoStockholm } from '@/lib/dates/iso'
import { normalizeForMatch } from '@/lib/documents/core-receipt-matcher'
import { intakeSourceForInboxItem, intakeSourceFromUploadSource, type IntakeSourceId } from '@/lib/intake/sources'
import { roundOre } from '@/lib/money'
import { resolvePortal, type CompanyPortal } from '@/lib/receipt-hunt/company-portals'
import { canHaveEmailReceipt } from '@/lib/receipt-hunt/select'

// ---------------------------------------------------------------------------
// The history, as the reader hands it over
// ---------------------------------------------------------------------------

/** A bank outflow in the lookback: not ignored, not private. */
export interface HistoryTransaction {
  id: string
  date: string
  amount: number
  currency: string | null
  amount_sek: number | null
  exchange_rate: number | null
  merchant_name: string | null
  description: string | null
  document_id: string | null
}

/** A registered supplier invoice in the lookback (no credit notes, nothing reversed). */
export interface HistorySupplierInvoice {
  id: string
  supplier_id: string
  invoice_date: string
  total: number
  total_sek: number | null
  currency: string | null
  exchange_rate: number | null
  document_id: string | null
}

export interface HistorySupplier {
  id: string
  name: string
}

/** A supplier invoice payment that names its bank row. */
export interface HistoryPayment {
  supplier_invoice_id: string
  transaction_id: string | null
}

export interface ExpectationHistory {
  transactions: HistoryTransaction[]
  supplierInvoices: HistorySupplierInvoice[]
  suppliers: HistorySupplier[]
  payments: HistoryPayment[]
}

/** A document behind an occurrence, as far as its door and arrival go. */
export interface EvidenceDocument {
  id: string
  upload_source: string | null
  file_name: string | null
  created_at: string
}

/** The inbox item a document arrived as, when it came through the inbox. */
export interface EvidenceInboxItem {
  document_id: string | null
  source: string | null
  channel_context: unknown
  created_at: string
}

/** A purchase under Saknar underlag, as far as På väg reads it. */
export interface OpenPurchase {
  id: string
  date: string
  merchant_name: string | null
  description: string | null
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** How far back the history is read: two yearly bills and a month to spare. */
export const HISTORY_MONTHS = 25
/** Väntas senare looks this far ahead. */
export const HORIZON_DAYS = 45
/** Only the latest gaps decide the cadence: a supplier read by what it does now. */
const MAX_GAPS = 12
/** Share of those gaps that must fall on the cadence. */
const MIN_FIT_SHARE = 0.75
/** Share of the cadence's slots that may have been skipped (a month with no bill). */
const MAX_SKIP_SHARE = 1 / 3
/** Each skipped slot widens the tolerance this much: month lengths add up. */
const SKIP_SLACK_DAYS = 2
const MIN_WINDOW_DAYS = 3
/** The latest events that set the day, the jitter, the amount range and the door. */
const RECENT_EVENTS = 6
/** The latest events the usual amount is the median of, so a price change shows soon. */
const USUAL_EVENTS = 3
/** With only the fewest events a cadence accepts, the amounts must agree this closely too. */
const WEAK_AMOUNT_SPREAD = 0.3
/** Occurrences per pattern whose documents are read for the door. */
export const EVIDENCE_OCCURRENCES = 8
/** A door is "usual" when at least this many documents came through it ... */
const DOOR_MIN_DOCUMENTS = 2
/** ... and at least this share of the latest ones did. */
const DOOR_MIN_SHARE = 0.6
/** Days of grace after the document's usual arrival. */
const ARRIVAL_GRACE_DAYS = 2
/** A door that delivers by itself, with no arrival ever measured: this long after the bank row. */
const DEFAULT_WAIT_DAYS = 5
/** Documents that usually arrive later than this after the bank row were sent on by a person, not delivered. */
const MAX_TIMELY_LAG_DAYS = 14

// ---------------------------------------------------------------------------
// Cadence
// ---------------------------------------------------------------------------

export type Cadence = 'monthly' | 'quarterly' | 'yearly'

interface CadenceSpec {
  cadence: Cadence
  months: number
  /** The mean length of one period, in days. */
  days: number
  /** How far one gap may sit from the period and still be on the cadence. */
  tolerance: number
  /** The widest window shown around an expected date. */
  maxWindow: number
  /** The fewest events (distinct dates) the cadence is read from. */
  minEvents: number
}

/**
 * Tried in this order, and the first that fits wins. A quarterly series never
 * fits as monthly (two of every three monthly slots would be skipped), and a
 * monthly one never as quarterly (its gaps are a period too short).
 */
const CADENCES: readonly CadenceSpec[] = [
  { cadence: 'monthly', months: 1, days: 30.44, tolerance: 6, maxWindow: 7, minEvents: 3 },
  { cadence: 'quarterly', months: 3, days: 91.31, tolerance: 12, maxWindow: 14, minEvents: 3 },
  { cadence: 'yearly', months: 12, days: 365.25, tolerance: 21, maxWindow: 21, minEvents: 2 },
]

export interface CadenceFit {
  cadence: Cadence
  months: number
  days: number
  /** Days either side of the expected date, from how far the latest events strayed. */
  windowDays: number
  /** Read from the fewest events the cadence accepts: the amounts must agree before it counts. */
  weak: boolean
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function distinctSorted(dates: readonly string[]): string[] {
  return [...new Set(dates)].sort()
}

/**
 * The cadence a series of billing dates keeps, or null when it keeps none.
 *
 * Each gap between two dates is read as k periods (k at least 1), and it is on
 * the cadence when it sits within the tolerance of k periods: a monthly
 * supplier that skipped August has one 61-day gap that counts as two months.
 * Three in four gaps must be on the cadence and at most a third of the slots
 * skipped, so a supplier billing every other month is not monthly and an
 * extra purchase mid-month does not break a year of monthly bills.
 */
export function detectCadence(dates: readonly string[]): CadenceFit | null {
  const sorted = distinctSorted(dates)
  const gaps: number[] = []
  for (let i = 1; i < sorted.length; i += 1) gaps.push(daysBetweenIso(sorted[i - 1], sorted[i]))
  const recent = gaps.slice(-MAX_GAPS)

  for (const spec of CADENCES) {
    if (sorted.length < spec.minEvents) continue
    let fits = 0
    let slots = 0
    const residuals: number[] = []
    for (const gap of recent) {
      const k = Math.max(1, Math.round(gap / spec.days))
      const residual = Math.abs(gap - k * spec.days)
      if (residual <= spec.tolerance + SKIP_SLACK_DAYS * (k - 1)) {
        fits += 1
        slots += k
        residuals.push(residual)
      } else {
        slots += 1
      }
    }
    if (fits / recent.length < MIN_FIT_SHARE) continue
    if ((slots - recent.length) / slots > MAX_SKIP_SHARE) continue
    const jitter = Math.ceil(Math.max(0, ...residuals.slice(-RECENT_EVENTS)))
    return {
      cadence: spec.cadence,
      months: spec.months,
      days: spec.days,
      windowDays: Math.min(spec.maxWindow, Math.max(MIN_WINDOW_DAYS, jitter)),
      weak: sorted.length === spec.minEvents,
    }
  }
  return null
}

/** Day-of-month offset from `fromDay`, folded into -15..15 so the 30th and the 2nd are four days apart. */
function dayOffset(day: number, fromDay: number): number {
  let offset = day - fromDay
  if (offset > 15) offset -= 30
  if (offset < -15) offset += 30
  return offset
}

/**
 * The next date in the series: one period after the latest, on the day of the
 * month the latest events usually fall on (a bill moved to Monday by a
 * weekend does not move the next one). The usual day is read as an offset
 * from the latest event, so a supplier billing around the turn of the month
 * (the 30th, the 1st, the 2nd) is not averaged into the middle of it. A date
 * less than half a period after the latest is the one that already came
 * early, so the period after it is next.
 */
export function nextOccurrence(dates: readonly string[], fit: Pick<CadenceFit, 'months' | 'days'>): string {
  const sorted = distinctSorted(dates)
  const last = sorted[sorted.length - 1]
  const lastDay = Number(last.slice(8, 10))
  const offsets = sorted.slice(-RECENT_EVENTS).map((d) => dayOffset(Number(d.slice(8, 10)), lastDay))
  const shift = Math.round(median(offsets))
  let periods = 1
  let candidate = addDaysIso(addMonthsIso(last, fit.months), shift)
  while (daysBetweenIso(last, candidate) < fit.days / 2 && periods < 4) {
    periods += 1
    candidate = addDaysIso(addMonthsIso(last, fit.months * periods), shift)
  }
  return candidate
}

// ---------------------------------------------------------------------------
// Step 1: patterns
// ---------------------------------------------------------------------------

/** One billing event: a registered supplier invoice, or a bank row paid to the counterparty. */
interface Occurrence {
  date: string
  /** Kronor, positive; null when the amount is not known in SEK. */
  amountSek: number | null
  documentId: string | null
  /** The bank day the money left: a bank row's own date, a supplier invoice's linked payment. */
  paidOn: string | null
}

export interface AmountRange {
  /** Median of the latest few, so a price change shows within a few bills. */
  usual: number
  min: number
  max: number
}

/** A counterparty that bills on a regular cadence and has not stopped. */
export interface Pattern {
  /** `supplier:<id>` or `bank:<folded bank text>`. */
  key: string
  kind: 'supplier' | 'bank'
  /** The supplier's name, or the bank's text on the latest row. */
  name: string
  supplierId: string | null
  /** The folded bank texts its payments carry, for finding its rows under Saknar underlag. */
  bankKeys: string[]
  fit: CadenceFit
  /** In date order. */
  occurrences: Occurrence[]
  /** Distinct billing dates. */
  events: number
  lastSeen: string
  next: { expected: string; from: string; to: string }
  amount: AmountRange | null
}

/** The bank text a row is grouped by: its merchant, else its text, folded the way the matcher folds names. */
export function bankKeyOf(row: Pick<HistoryTransaction, 'merchant_name' | 'description'>): string | null {
  const descriptor = row.merchant_name?.trim() || row.description?.trim()
  if (!descriptor) return null
  return normalizeForMatch(descriptor) || null
}

/** Kronor, positive, by the shared conversion rule: a foreign amount with no kronor value and no rate has none. */
function kronor(amount: number, amountSek: number | null, currency: string | null, rate: number | null): number | null {
  const sek = resolveSekAmountOrNull(Number(amount), amountSek === null ? null : Number(amountSek), currency, rate)
  return sek === null ? null : roundOre(Math.abs(sek))
}

function bankAmountSek(tx: HistoryTransaction): number | null {
  return kronor(tx.amount, tx.amount_sek, tx.currency, tx.exchange_rate)
}

function invoiceAmountSek(invoice: HistorySupplierInvoice): number | null {
  return kronor(invoice.total, invoice.total_sek, invoice.currency, invoice.exchange_rate)
}

/** The occurrences per date, amounts on the same day added up (two bills on one day are one billing). */
function eventsOf(occurrences: readonly Occurrence[]): { date: string; amountSek: number | null }[] {
  const byDate = new Map<string, number | null>()
  for (const o of occurrences) {
    const before = byDate.get(o.date)
    if (before === undefined) byDate.set(o.date, o.amountSek)
    else if (o.amountSek !== null) byDate.set(o.date, roundOre((before ?? 0) + o.amountSek))
  }
  return [...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([date, amountSek]) => ({ date, amountSek }))
}

/** The usual amount and its range, or 'disagree' when weak evidence has amounts that do not agree. */
function amountSummary(
  events: readonly { amountSek: number | null }[],
  fit: CadenceFit,
): AmountRange | null | 'disagree' {
  const known = events.map((e) => e.amountSek).filter((a): a is number => a !== null)
  if (known.length === 0) return fit.weak ? 'disagree' : null
  const recent = known.slice(-RECENT_EVENTS)
  if (fit.weak) {
    const middle = median(recent)
    if (recent.some((a) => Math.abs(a - middle) > middle * WEAK_AMOUNT_SPREAD)) return 'disagree'
  }
  return {
    usual: roundOre(median(known.slice(-USUAL_EVENTS))),
    min: Math.min(...recent),
    max: Math.max(...recent),
  }
}

interface Series {
  key: string
  kind: 'supplier' | 'bank'
  name: string
  supplierId: string | null
  bankKeys: string[]
  occurrences: Occurrence[]
}

function toPattern(series: Series, today: string): Pattern | null {
  const occurrences = series.occurrences.filter((o) => o.date <= today).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const events = eventsOf(occurrences)
  const fit = detectCadence(events.map((e) => e.date))
  if (!fit) return null
  const lastSeen = events[events.length - 1].date
  // Two in a row did not come: the supplier stopped (a cancelled subscription, a moved contract).
  if (daysBetweenIso(lastSeen, today) > 2 * fit.days + fit.windowDays) return null
  const amount = amountSummary(events, fit)
  if (amount === 'disagree') return null
  const expected = nextOccurrence(
    events.map((e) => e.date),
    fit,
  )
  return {
    key: series.key,
    kind: series.kind,
    name: series.name,
    supplierId: series.supplierId,
    bankKeys: series.bankKeys,
    fit,
    occurrences,
    events: events.length,
    lastSeen,
    next: { expected, from: addDaysIso(expected, -fit.windowDays), to: addDaysIso(expected, fit.windowDays) },
    amount,
  }
}

/**
 * The counterparties that bill regularly, from two sources:
 *   - each supplier's registered invoices, dated by their invoice date; the
 *     bank rows that paid them name the supplier's bank text;
 *   - the bank rows no supplier invoice settled, grouped by bank text. Only
 *     counterparties that have had an underlag before, or whose portal is
 *     known (the company's own, else the directory's): a monthly transfer,
 *     loan or bank fee has no document to expect. Salary and tax are left
 *     out the same way the receipt hunt leaves them.
 */
export function findPatterns(
  history: ExpectationHistory,
  today: string,
  companyPortals: readonly CompanyPortal[] = [],
): Pattern[] {
  const transactions = new Map(history.transactions.map((t) => [t.id, t]))
  const supplierNames = new Map(history.suppliers.map((s) => [s.id, s.name]))

  // The bank rows that paid each supplier invoice; those rows belong to the supplier, not to the bank's own series.
  const paidBy = new Map<string, HistoryTransaction[]>()
  const settledRows = new Set<string>()
  for (const payment of history.payments) {
    if (!payment.transaction_id) continue
    settledRows.add(payment.transaction_id)
    const tx = transactions.get(payment.transaction_id)
    if (!tx) continue
    paidBy.set(payment.supplier_invoice_id, [...(paidBy.get(payment.supplier_invoice_id) ?? []), tx])
  }

  const series = new Map<string, Series>()
  const nameDates = new Map<string, string>()

  for (const invoice of history.supplierInvoices) {
    const name = supplierNames.get(invoice.supplier_id)?.trim()
    if (!name) continue
    const key = `supplier:${invoice.supplier_id}`
    const entry = series.get(key) ?? {
      key,
      kind: 'supplier' as const,
      name,
      supplierId: invoice.supplier_id,
      bankKeys: [],
      occurrences: [],
    }
    const payments = paidBy.get(invoice.id) ?? []
    for (const tx of payments) {
      const bankKey = bankKeyOf(tx)
      if (bankKey && !entry.bankKeys.includes(bankKey)) entry.bankKeys.push(bankKey)
    }
    const paidOn = payments.map((tx) => tx.date).sort()[0] ?? null
    entry.occurrences.push({
      date: invoice.invoice_date,
      amountSek: invoiceAmountSek(invoice),
      documentId: invoice.document_id,
      paidOn,
    })
    series.set(key, entry)
  }

  for (const tx of history.transactions) {
    if (settledRows.has(tx.id)) continue
    if (!canHaveEmailReceipt(tx.description) || !canHaveEmailReceipt(tx.merchant_name)) continue
    const bankKey = bankKeyOf(tx)
    if (!bankKey) continue
    const key = `bank:${bankKey}`
    const entry = series.get(key) ?? { key, kind: 'bank' as const, name: '', supplierId: null, bankKeys: [bankKey], occurrences: [] }
    entry.occurrences.push({ date: tx.date, amountSek: bankAmountSek(tx), documentId: tx.document_id, paidOn: tx.date })
    // The name the latest row gives: rows come in any order.
    if ((nameDates.get(key) ?? '') <= tx.date) {
      nameDates.set(key, tx.date)
      entry.name = tx.merchant_name?.trim() || tx.description?.trim() || entry.name
    }
    series.set(key, entry)
  }

  const patterns: Pattern[] = []
  for (const entry of series.values()) {
    if (entry.kind === 'bank' && !entry.occurrences.some((o) => o.documentId) && !resolvePortal(companyPortals, entry.name)) continue
    const pattern = toPattern(entry, today)
    if (pattern) patterns.push(pattern)
  }
  return patterns
}

// ---------------------------------------------------------------------------
// Step 2: the documents to read
// ---------------------------------------------------------------------------

/** The documents behind each pattern's latest occurrences: where they came from decides the door. */
export function evidenceDocumentIds(patterns: readonly Pattern[]): string[] {
  const ids = new Set<string>()
  for (const pattern of patterns) {
    for (const o of pattern.occurrences.slice(-EVIDENCE_OCCURRENCES)) if (o.documentId) ids.add(o.documentId)
  }
  return [...ids]
}

export interface DocumentEvidence {
  door: IntakeSourceId | null
  /** The Swedish calendar day it reached Accounted. */
  arrivedOn: string
}

/**
 * Each document's door, by the one vocabulary (lib/intake/sources.ts): the
 * inbox item it arrived as decides when there is one (Peppol, the intake
 * address, WhatsApp, the mailbox hunt), else the document's own upload source.
 */
export function documentEvidence(
  documents: readonly EvidenceDocument[],
  items: readonly EvidenceInboxItem[],
): Map<string, DocumentEvidence> {
  const firstItem = new Map<string, EvidenceInboxItem>()
  for (const item of items) {
    if (!item.document_id) continue
    const before = firstItem.get(item.document_id)
    if (!before || item.created_at < before.created_at) firstItem.set(item.document_id, item)
  }
  const out = new Map<string, DocumentEvidence>()
  for (const doc of documents) {
    const item = firstItem.get(doc.id)
    const door = item
      ? intakeSourceForInboxItem({
          source: item.source,
          channel_context: (item.channel_context ?? null) as { intake_source?: unknown; channel?: unknown } | null,
          document_upload_source: doc.upload_source,
          document_file_name: doc.file_name,
        })
      : intakeSourceFromUploadSource(doc.upload_source, { fileName: doc.file_name })
    const arrived = item && item.created_at < doc.created_at ? item.created_at : doc.created_at
    out.set(doc.id, { door, arrivedOn: todayIsoStockholm(new Date(arrived)) })
  }
  return out
}

// ---------------------------------------------------------------------------
// Step 3: how it usually comes
// ---------------------------------------------------------------------------

/** A door, or the supplier's portal (a page someone fetches the invoice from). */
export type ExpectedDoor = IntakeSourceId | 'portal'

/** The doors that deliver by themselves: nobody has to fetch, forward or upload anything. */
export const ON_THE_WAY_DOORS = ['peppol', 'intake_email'] as const
export type OnTheWayDoor = (typeof ON_THE_WAY_DOORS)[number]

export function isOnTheWayDoor(door: ExpectedDoor | null): door is OnTheWayDoor {
  return door !== null && (ON_THE_WAY_DOORS as readonly string[]).includes(door)
}

export interface PatternExpectation extends Pattern {
  door: ExpectedDoor | null
  portal: { vendor: string; url: string } | null
  /**
   * How many days after its bank row the document is still on its way: its
   * usual arrival plus a little grace. Null when its door does not deliver by
   * itself, or when its documents usually come weeks later.
   */
  waitDays: number | null
}

/**
 * The door the latest documents came through, when one carries most of them
 * (at least two, and three in five); the supplier's portal when the company
 * or the portal directory knows it and the documents were uploaded by hand
 * or not seen. For a door that delivers by itself, how long after the bank
 * row they arrive: the median of the measured delays plus two days.
 */
export function expectationsFrom(
  patterns: readonly Pattern[],
  evidence: ReadonlyMap<string, DocumentEvidence>,
  companyPortals: readonly CompanyPortal[] = [],
): PatternExpectation[] {
  return patterns.map((pattern) => {
    const known: { door: IntakeSourceId; lag: number | null }[] = []
    for (const o of pattern.occurrences.slice(-EVIDENCE_OCCURRENCES)) {
      const e = o.documentId ? evidence.get(o.documentId) : undefined
      if (e?.door) known.push({ door: e.door, lag: o.paidOn ? daysBetweenIso(o.paidOn, e.arrivedOn) : null })
    }
    const latest = known.slice(-RECENT_EVENTS)

    const counts = new Map<IntakeSourceId, number>()
    for (const k of latest) counts.set(k.door, (counts.get(k.door) ?? 0) + 1)
    let usual: IntakeSourceId | null = null
    let usualCount = 0
    // Latest first, so a tie goes to the door used most recently.
    for (const k of [...latest].reverse()) {
      const count = counts.get(k.door) ?? 0
      if (count > usualCount) {
        usual = k.door
        usualCount = count
      }
    }
    const door: IntakeSourceId | null =
      usual && usualCount >= DOOR_MIN_DOCUMENTS && usualCount / latest.length >= DOOR_MIN_SHARE ? usual : null

    const portalEntry = resolvePortal(companyPortals, pattern.name)
    const portal = portalEntry ? { vendor: portalEntry.vendor, url: portalEntry.url } : null
    const expectedDoor: ExpectedDoor | null = portal && (door === null || door === 'upload') ? 'portal' : door

    let waitDays: number | null = null
    if (isOnTheWayDoor(expectedDoor)) {
      const lags = latest.filter((k) => k.door === expectedDoor && k.lag !== null).map((k) => k.lag as number)
      if (lags.length === 0) waitDays = DEFAULT_WAIT_DAYS
      else {
        const typical = median(lags)
        waitDays = typical > MAX_TIMELY_LAG_DAYS ? null : Math.max(0, Math.round(typical)) + ARRIVAL_GRACE_DAYS
      }
    }

    return { ...pattern, door: expectedDoor, portal, waitDays }
  })
}

// ---------------------------------------------------------------------------
// What the page shows
// ---------------------------------------------------------------------------

/** One expected document, as GET /api/inkorg/expectations answers it. */
export interface Expectation {
  key: string
  counterparty: string
  supplier_id: string | null
  cadence: Cadence
  /** YYYY-MM-DD, and the window either side of it. */
  expected_on: string
  window_from: string
  window_to: string
  /** Kronor. Null when no amount in SEK is known. */
  amount: AmountRange | null
  door: ExpectedDoor | null
  portal: { vendor: string; url: string } | null
  last_seen: string
  /** Distinct billing dates the cadence was read from. */
  occurrences: number
  /** The vendor's own icon from our logos bucket (lib/vendor-logos), when one is stored. */
  logo_url?: string | null
}

/** A purchase under Saknar underlag whose document is on its way. */
export interface PurchaseOnTheWay {
  transaction_id: string
  expectation_key: string
  counterparty: string
  door: OnTheWayDoor
  /** The last day it is still on its way; after it the purchase needs a person again. */
  expected_by: string
}

export interface ExpectationsResponse {
  horizon_days: number
  expectations: Expectation[]
  on_the_way: PurchaseOnTheWay[]
}

function toWire(e: PatternExpectation): Expectation {
  return {
    key: e.key,
    counterparty: e.name,
    supplier_id: e.supplierId,
    cadence: e.fit.cadence,
    expected_on: e.next.expected,
    window_from: e.next.from,
    window_to: e.next.to,
    amount: e.amount,
    door: e.door,
    portal: e.portal,
    last_seen: e.lastSeen,
    occurrences: e.events,
  }
}

/**
 * Väntas senare: the next document from each regular counterparty, when it
 * is due within the horizon and its window has not passed (a late one is
 * not "later", and this change says nothing about lateness). A bank series
 * whose rows also paid a supplier's invoices gives way to that supplier, so
 * one counterparty is listed once, under its own name. Soonest first.
 */
export function upcomingExpectations(
  expectations: readonly PatternExpectation[],
  today: string,
  horizonDays: number = HORIZON_DAYS,
): Expectation[] {
  const until = addDaysIso(today, horizonDays)
  const supplierBankKeys = new Set(expectations.filter((e) => e.kind === 'supplier').flatMap((e) => e.bankKeys))
  return expectations
    .filter((e) => e.next.to >= today && e.next.expected <= until)
    .filter((e) => !(e.kind === 'bank' && e.bankKeys.some((k) => supplierBankKeys.has(k))))
    .sort((a, b) =>
      a.next.expected !== b.next.expected ? (a.next.expected < b.next.expected ? -1 : 1) : a.name.localeCompare(b.name, 'sv'),
    )
    .map(toWire)
}

/** Every word of the supplier's name stands in the bank's text ("Vattenfall AB" in "VATTENFALL KUNDSERVICE"). */
function nameInBankText(name: string, bankKey: string): boolean {
  const folded = normalizeForMatch(name)
  if (folded.length < 4) return false
  const words = new Set(bankKey.split(' '))
  return folded.split(' ').every((w) => words.has(w))
}

/**
 * På väg: the purchases whose document will come by itself. A purchase is on
 * its way when it belongs to a counterparty that bills regularly, whose
 * documents usually come through Peppol or the intake address, and it is
 * still within the days its document usually takes after the bank row (plus
 * grace). After that it needs a person again, and the view puts it back.
 *
 * The counterparty is found by its bank text: a bank series by the same
 * folded text, a supplier by the texts its earlier payments carried, and a
 * supplier no payment was ever linked to by every word of its name.
 */
export function purchasesOnTheWay(
  open: readonly OpenPurchase[],
  expectations: readonly PatternExpectation[],
  today: string,
): PurchaseOnTheWay[] {
  const out: PurchaseOnTheWay[] = []
  for (const purchase of open) {
    const key = bankKeyOf(purchase)
    if (!key) continue
    const match =
      expectations.find((e) => e.kind === 'bank' && e.bankKeys.includes(key)) ??
      expectations.find((e) => e.kind === 'supplier' && e.bankKeys.includes(key)) ??
      expectations.find((e) => e.kind === 'supplier' && e.bankKeys.length === 0 && nameInBankText(e.name, key))
    if (!match || match.waitDays === null || !isOnTheWayDoor(match.door)) continue
    const expectedBy = addDaysIso(purchase.date, match.waitDays)
    if (purchase.date > today || expectedBy < today) continue
    out.push({
      transaction_id: purchase.id,
      expectation_key: match.key,
      counterparty: match.name,
      door: match.door,
      expected_by: expectedBy,
    })
  }
  return out
}
