/**
 * Kontantmetoden year-end cut-off (BFL 5 kap 2 §): årsomföring per invoice.
 *
 * Under kontantmetoden (bokslutsmetoden) affärshändelser are booked when cash
 * moves, so open customer and supplier invoices never reach 1510 / 2440 during
 * the year. BFL still requires that fordringar och skulder ARE booked at
 * räkenskapsårets utgång, and the moms on an invoice still open at the year
 * end belongs to the final VAT period of that year.
 *
 * Shape (founder decision 2026-10-03, the way Fortnox and Visma do it): one
 * year_end verifikat per invoice open at period end, dated on period_end,
 * built by the invoice's own registration line builder (ordinary moms
 * accounts 2611/2621/2631/2641, the full ROT/RUT 1513 leg, currency metadata
 * on 1510 / 2440), and LINKED to the invoice through invoices.journal_entry_id
 * / supplier_invoices.registration_journal_entry_id. There is no vändning.
 *
 * Why the link is the design (#3440):
 *
 *  - every payment door already routes on that link: a linked invoice is
 *    cleared against 1510 / 2440 with no revenue, cost or moms, exactly like
 *    one booked at issue under faktureringsmetoden. So the year-2 payment,
 *    partial payment, credit note, kundförlust, FX difference, batch
 *    allocation and ROT/RUT payout all book correctly with no door change,
 *    and the moms is declared once, in the closed year;
 *  - an aggregate verifikat linked to many invoices breaks every reader that
 *    resolves an invoice's own booking (supplier-payment-amounts refuses a
 *    shared registration voucher, rot-rut-receivable a shared voucher, the
 *    periodisk sammanställning files only postings an invoice points at, and
 *    the provider migration jobs link per invoice), so it is one per invoice;
 *  - it is the faktureringsmetod shape, so a carried invoice is
 *    indistinguishable from one booked at issue for every report.
 *
 * The cut-off this replaced posted two aggregate verifikat with a day-one
 * vändning that the VAT functions excluded while the invoices stayed
 * unlinked: the year-2 payment then booked revenue and moms again, and the
 * same moms was declared in both years. Periods that hold such a legacy
 * cut-off (self-hosted only; production never posted one) keep their posted
 * figures and are judged by the legacy inspector below, unchanged. Its
 * vilande moms lines no longer reach a ruta (crm#1562: no ruta reads a
 * vilande account), so such a year's last momsdeklaration recomputes without
 * them.
 *
 * What a cut-off IS lives in kontantmetod_cutoff_entries (kind
 * receivable_invoice / payable_invoice with the invoice id), written together
 * with the link by record_kontantmetod_cutoff_link (20261018131100). The
 * database guards a carry: no payment row dated on or before it, no
 * kontantmetod cash verifikat for a carried invoice, and a storno only on its
 * own date while nothing has settled the invoice (the storno releases the
 * link, so a re-run carries the invoice again).
 *
 * An invoice open at period end but paid after it, before the cut-off was
 * posted, already has a kontantmetod cash verifikat that booked revenue or
 * cost and moms in the new year. After its carry posts, that verifikat is
 * corrected with correctEntry (storno plus rättelse, BFL 5 kap 5 §) on its own
 * date: the rättelse keeps the bank leg and clears 1510 / 2440 instead, so the
 * moms stays declared once. What the rule cannot correct (a shared or manual
 * verifikat) is listed for the user, never guessed. Before any write the
 * pre-flight (lib/vat/kontantmetod-cutoff-preflight.ts) refuses a locked write date,
 * and a filed VAT period unless the user acknowledged that it needs a
 * corrected momsdeklaration. While the cut-off of a year is incomplete, the
 * VAT check warns KONTANTMETOD_CUTOFF_INCOMPLETE on the period holding its
 * period end.
 */
import { chunk as chunked } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createHash } from 'node:crypto'
import type {
  CreateJournalEntryLineInput,
  EntityType,
  InvoiceItem,
  JournalEntry,
  JournalEntryLine,
  SupplierInvoice,
  SupplierInvoiceItem,
  VatTreatment,
} from '@/types'
import { getRevenueAccount } from '@/lib/bookkeeping/invoice-entries'
import {
  buildCreditNoteLines,
  buildDeductionCarryLines,
  buildInvoiceRegistrationLines,
  headerToSekOrThrow,
  type InvoiceRegistrationLinesSource,
} from '@/lib/bookkeeping/invoice-lines'
import { toSekOrThrow } from '@/lib/bookkeeping/supplier-invoice-entries'
import {
  isSupplierInvoiceReverseCharge,
  supplierInvoiceRegistrationLines,
} from '@/lib/bookkeeping/supplier-invoice-registration-lines'
import { buildSupplierDescription } from '@/lib/bookkeeping/supplier-invoice-description'
import {
  generateReverseChargePurchaseLines,
  resolveReverseChargeRate,
  reverseChargeOnAccount,
  supplierInvoiceReverseChargeKind,
} from '@/lib/bookkeeping/vat-entries'
import { chartVatTreatmentsLoader } from '@/lib/bookkeeping/chart-vat-treatments'
import type { ChartVatTreatments, ReverseChargeKind } from '@/lib/bookkeeping/vat-entries'
import { correctionBusinessEvents } from '@/lib/bookkeeping/ledger-business-events'
import { anchorCustomerInvoiceDocument } from '@/lib/core/documents/customer-invoice-underlag'
import { anchorSupplierInvoiceDocument } from '@/lib/core/documents/supplier-invoice-underlag'
import { invoiceCustomerOutstanding, invoiceCustomerShare } from '@/lib/bookkeeping/customer-share'
import { ACCOUNT_NUMBER_RE } from '@/lib/invariants'
import { createLogger } from '@/lib/logger'
import { ORE_TOLERANCE, roundOre } from '@/lib/money'
import { lineBalance } from '@/lib/bookkeeping/line-balance'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { mappingVersion } from '@/lib/posting/mapping-version'
import { postingPort } from '@/lib/posting/port'
import type { BusinessEventTaxAmount } from '@/lib/posting/store'
import { isLedgerCurrency, sekOfForeign } from '@/lib/bookkeeping/currency-utils'
import {
  fetchCreditedAfter,
  fetchPaymentsAsOf,
  resolveOutstandingAsOf,
  type OutstandingAsOfBasis,
  type PaymentsAsOf,
} from '@/lib/reports/reskontra-payments'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { invoicesWrittenOffAsOf } from '@/lib/core/bookkeeping/written-off-as-of'
import {
  kontantmetodCutoffBusinessEvent,
  systemDerivedLinkBasis,
  yearEndStornoBusinessEvent,
  type YearEndPostingContext,
} from './year-end-business-events'

export { legacyKontantmetodVandningWarning } from './kontantmetod-cutoff-texts'

const log = createLogger('kontantmetod-cutoff')

/**
 * Vilande utgående moms per VAT treatment, as the LEGACY aggregate cut-off
 * booked it (buildCutoffLines). The per-invoice carry books the ordinary
 * moms accounts through the registration builders instead. Also the
 * collector's test for a treatment that can carry Swedish output moms at all:
 * rates outside 25/12/6 (export, reverse charge, exempt) never reach this
 * map, so their whole outstanding amount is revenue.
 */
export const VILANDE_OUTPUT_VAT_ACCOUNTS: Partial<Record<VatTreatment, string>> = {
  standard_25: '2618',
  reduced_12: '2628',
  reduced_6: '2638',
}

/** Vilande ingående moms (legacy aggregate cut-off). One account for every rate. */
export const VILANDE_INPUT_VAT_ACCOUNT = '2648'

export const RECEIVABLES_ACCOUNT = '1510'
/** BAS 1513, Kundfordringar delad faktura: Skatteverket's ROT/RUT share. */
const ROT_RUT_RECEIVABLE_ACCOUNT = '1513'
export const PAYABLES_ACCOUNT = '2440'

/**
 * Grundbok text for the four LEGACY cut-off verifikat. DISPLAY ONLY. The
 * per-invoice carries use kontantmetodCarryDescription, which must never
 * equal any of these: the race guard of 20260813124509 keys on them.
 *
 * Nothing may key off these strings. What a cut-off verifikat IS lives in
 * `kontantmetod_cutoff_entries.kind`, written by the writer below and read by
 * the finder and by the two VAT functions (migration 20260914150109). Before
 * that table every reader reconstructed the set from this text, including the
 * SQL that decides what reaches a filed momsdeklaration, so a rewording here
 * would have silently changed a legal figure (issue #2053).
 */
export const KONTANTMETOD_CUTOFF_DESCRIPTIONS = {
  receivable: 'Kundfordringar vid bokslut (kontantmetoden)',
  receivableReversal: 'Vändning kundfordringar bokslut (kontantmetoden)',
  payable: 'Leverantörsskulder vid bokslut (kontantmetoden)',
  payableReversal: 'Vändning leverantörsskulder bokslut (kontantmetoden)',
} as const

/** The stable identity of each of the four legacy verifikat. */
export type LegacyKontantmetodCutoffKind =
  'receivable' | 'receivable_reversal' | 'payable' | 'payable_reversal'

/**
 * Every marker kind: the four legacy ones, and the per-invoice carry of a
 * customer (receivable_invoice) or supplier (payable_invoice) invoice.
 */
export type KontantmetodCutoffKind =
  | LegacyKontantmetodCutoffKind
  | 'receivable_invoice'
  | 'payable_invoice'

/** Grundbok text per kind, used only to label a conflict for a human. */
const CUTOFF_DESCRIPTION_BY_KIND: Record<LegacyKontantmetodCutoffKind, string> = {
  receivable: KONTANTMETOD_CUTOFF_DESCRIPTIONS.receivable,
  receivable_reversal: KONTANTMETOD_CUTOFF_DESCRIPTIONS.receivableReversal,
  payable: KONTANTMETOD_CUTOFF_DESCRIPTIONS.payable,
  payable_reversal: KONTANTMETOD_CUTOFF_DESCRIPTIONS.payableReversal,
}

/** A customer invoice still outstanding at period end. Amounts are SEK. */
export interface CutoffReceivable {
  id: string
  /** Human reference for the line description. */
  reference: string
  vatTreatment: VatTreatment
  /**
   * The invoice's delivery_country (#2906): goods delivered abroad book the
   * goods accounts (3105 / 3108), like the invoice's own verifikat.
   */
  goodsDeliveryCountry?: string | null
  /** Outstanding INCLUDING moms at period end. */
  outstanding: number
  /** The moms share of `outstanding`. */
  vat: number
}

/** A supplier invoice still outstanding at period end. Amounts are SEK. */
export interface CutoffPayable {
  id: string
  reference: string
  /** Outstanding INCLUDING moms at period end. */
  outstanding: number
  /** The ingående moms share of `outstanding`. */
  vat: number
  /**
   * Omvänd betalningsskyldighet. The supplier charges no moms, so the buyer
   * self-assesses output AND input moms on 2614/2624/2634 + 2645/2647, which
   * is a symmetric pair that must never be split. `vat` is 0 on every such row
   * by construction, and this flag forces it to 0 anyway: routing a stray
   * amount into the single 2648 bucket would post a one-sided reverse charge.
   * The complete output/input pair and its declaration basis are included in
   * the final VAT period through `reverseChargeGroups` below.
   */
  reverseCharge?: boolean
  reverseChargeGroups?: Array<{
    rate: number
    base: number
    nonBasisBase: number
    /** The basis box the invoice books (supplierInvoiceReverseChargeKind). */
    kind: ReverseChargeKind
  }>
  /**
   * Net expense split across BAS accounts, as weights. Only the ratios matter:
   * the net total is always derived as `outstanding - vat` so the verifikat
   * balances no matter how the source rows round.
   */
  netByAccount: Array<{ account: string; amount: number }>
}

export interface CutoffLines {
  receivableLines: CreateJournalEntryLineInput[]
  payableLines: CreateJournalEntryLineInput[]
  receivableTotal: number
  payableTotal: number
}

interface MarkedCutoffEntry {
  id: string
  fiscal_period_id: string
  entry_date: string
  status: string
  lines: Array<{
    account_number: string
    debit_amount: number | string | null
    credit_amount: number | string | null
  }> | null
}

interface PostedCutoffEntry extends Omit<MarkedCutoffEntry, 'lines'> {
  kind: KontantmetodCutoffKind
  lines: NonNullable<MarkedCutoffEntry['lines']>
}

export interface KontantmetodCutoffPostingStatus {
  complete: boolean
  hasAny: boolean
  receivableEntryId: string | null
  receivableReversalId: string | null
  payableEntryId: string | null
  payableReversalId: string | null
  missing: KontantmetodCutoffKind[]
  duplicates: string[]
}

// Go through roundOre first: Math.round(x * 100) alone mis-rounds exact-half
// values that arrive with float drift (lib/money.ts).
const toOre = (amount: number): number => Math.round(roundOre(amount) * 100)
const toKronor = (ore: number): number => ore / 100

/**
 * Split `totalOre` across `weights` so the parts sum to exactly `totalOre`.
 *
 * Proportional shares with largest-remainder allocation. Doing this in whole
 * öre (rather than rounding each share independently) is what keeps the
 * verifikat balanced: independent rounding drifts by an öre per bucket and the
 * DB balance trigger would reject the entry.
 */
export function distributeOre(totalOre: number, weights: number[]): number[] {
  if (weights.length === 0) return []
  if (weights.length === 1) return [totalOre]

  const sign = totalOre < 0 ? -1 : 1
  const absoluteTotal = Math.abs(totalOre)

  const weightSum = weights.reduce((sum, w) => sum + Math.abs(w), 0)
  // Degenerate input (all-zero weights): put everything on the first bucket
  // rather than emitting NaN.
  if (weightSum === 0) return weights.map((_, i) => (i === 0 ? totalOre : 0))

  const exact = weights.map((w) => (Math.abs(w) / weightSum) * absoluteTotal)
  const floors = exact.map((value) => Math.floor(value))
  let remainder = absoluteTotal - floors.reduce((sum, value) => sum + value, 0)

  // Hand the leftover öre to the largest fractional parts first.
  const order = exact
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac)

  const result = [...floors]
  for (const { index } of order) {
    if (remainder <= 0) break
    result[index] += 1
    remainder -= 1
  }
  return result.map((value) => value * sign)
}

function signedLine(
  accountNumber: string,
  normalSide: 'debit' | 'credit',
  signedOre: number,
  lineDescription: string,
): CreateJournalEntryLineInput {
  const normal = signedOre >= 0
  const amount = toKronor(Math.abs(signedOre))
  const debit = (normalSide === 'debit') === normal
  return {
    account_number: accountNumber,
    debit_amount: debit ? amount : 0,
    credit_amount: debit ? 0 : amount,
    line_description: lineDescription,
  }
}

/**
 * Build the cut-off verifikat lines. Pure: no IO, so the money math is
 * directly testable.
 *
 * Receivables: Debit 1510 / Credit 30xx + Credit 2618|2628|2638
 * Payables:    Debit 4-6xxx + Debit 2648 / Credit 2440
 */
export function buildCutoffLines(
  receivables: CutoffReceivable[],
  payables: CutoffPayable[],
  entityType: EntityType,
): CutoffLines {
  const receivableLines: CreateJournalEntryLineInput[] = []
  const payableLines: CreateJournalEntryLineInput[] = []

  // ---- Fordringar -------------------------------------------------------
  // Group revenue by the account the treatment books to (goods delivered
  // abroad split from services, #2906) and moms by treatment: the vilande
  // moms account follows from the treatment alone.
  const revenueByAccount = new Map<string, number>()
  const outputVatByTreatment = new Map<VatTreatment, number>()
  let receivableOre = 0

  for (const row of receivables) {
    const outstandingOre = toOre(row.outstanding)
    if (outstandingOre === 0) continue
    // Derive net from outstanding minus moms so the two legs always add back
    // to the receivable, whatever rounding the source row carries.
    const vatOre = toOre(row.vat)
    const netOre = outstandingOre - vatOre

    receivableOre += outstandingOre
    const revenueAccount = getRevenueAccount(row.vatTreatment, entityType, { goods: !!row.goodsDeliveryCountry })
    revenueByAccount.set(revenueAccount, (revenueByAccount.get(revenueAccount) ?? 0) + netOre)
    if (vatOre !== 0) {
      outputVatByTreatment.set(
        row.vatTreatment,
        (outputVatByTreatment.get(row.vatTreatment) ?? 0) + vatOre,
      )
    }
  }

  if (receivableOre !== 0) {
    receivableLines.push(signedLine(
      RECEIVABLES_ACCOUNT,
      'debit',
      receivableOre,
      'Kundfordringar vid räkenskapsårets utgång (kontantmetoden)',
    ))

    for (const [revenueAccount, netOre] of revenueByAccount) {
      if (netOre === 0) continue
      receivableLines.push(signedLine(
        revenueAccount,
        'credit',
        netOre,
        'Obetalda kundfakturor vid bokslut',
      ))
    }

    for (const [treatment, vatOre] of outputVatByTreatment) {
      const account = VILANDE_OUTPUT_VAT_ACCOUNTS[treatment]
      // No vilande account means the treatment carries no Swedish output moms
      // (export, omvänd betalningsskyldighet, undantagen). A non-zero moms
      // amount there is a data error: fold it into revenue rather than invent
      // a moms account, so the verifikat still balances and the anomaly shows
      // up as revenue rather than as a phantom momsskuld.
      if (!account) {
        log.warn('outstanding moms on a treatment with no vilande account; booked as revenue', {
          treatment,
          ore: vatOre,
        })
        receivableLines.push(signedLine(
          getRevenueAccount(treatment, entityType),
          'credit',
          vatOre,
          'Obetalda kundfakturor vid bokslut',
        ))
        continue
      }
      receivableLines.push(signedLine(
        account,
        'credit',
        vatOre,
        'Utgående moms på obetald faktura vid bokslut',
      ))
    }
  }

  // ---- Skulder ----------------------------------------------------------
  const expenseByAccount = new Map<string, number>()
  const reverseChargeByGroup = new Map<string, {
    rate: number
    baseOre: number
    nonBasisBaseOre: number
    kind: ReverseChargeKind
  }>()
  let payableOre = 0
  let inputVatOre = 0

  for (const row of payables) {
    const outstandingOre = toOre(row.outstanding)
    if (outstandingOre === 0) continue
    // Reverse charge carries no charged moms on the invoice itself. The
    // self-assessed pair is built from its basis groups below, never split into
    // the single vilande bucket. Force the invoice moms field to zero.
    const vatOre = row.reverseCharge ? 0 : toOre(row.vat)
    const netOre = outstandingOre - vatOre

    payableOre += outstandingOre
    inputVatOre += vatOre

    const buckets = row.netByAccount.length > 0
      ? row.netByAccount
      // No item detail: park the net on the generic övriga kostnader account
      // rather than dropping it. The entry is reversed the next day, so the
      // account choice never survives into the new year.
      : [{ account: '6990', amount: 1 }]
    const shares = distributeOre(netOre, buckets.map((b) => b.amount))
    buckets.forEach((bucket, index) => {
      const share = shares[index]
      if (share === 0) return
      expenseByAccount.set(bucket.account, (expenseByAccount.get(bucket.account) ?? 0) + share)
    })
    for (const group of row.reverseChargeGroups ?? []) {
      const key = `${group.kind}:${group.rate}`
      const current = reverseChargeByGroup.get(key) ?? {
        rate: group.rate,
        baseOre: 0,
        nonBasisBaseOre: 0,
        kind: group.kind,
      }
      current.baseOre += toOre(group.base)
      current.nonBasisBaseOre += toOre(group.nonBasisBase)
      reverseChargeByGroup.set(key, current)
    }
  }

  if (payableOre !== 0) {
    for (const [account, netOre] of expenseByAccount) {
      if (netOre === 0) continue
      payableLines.push(signedLine(
        account,
        'debit',
        netOre,
        'Obetalda leverantörsfakturor vid bokslut',
      ))
    }

    if (inputVatOre !== 0) {
      payableLines.push(signedLine(
        VILANDE_INPUT_VAT_ACCOUNT,
        'debit',
        inputVatOre,
        'Ingående moms på obetald faktura vid bokslut',
      ))
    }

    const appendReverseChargeLines = (
      generated: CreateJournalEntryLineInput[],
      sign: number,
    ) => {
      for (const line of generated) {
        const normalSide = line.debit_amount > 0 ? 'debit' : 'credit'
        const amount = line.debit_amount || line.credit_amount
        payableLines.push(signedLine(
          line.account_number,
          normalSide,
          toOre(amount) * sign,
          line.line_description ?? 'Omvänd skattskyldighet vid bokslut',
        ))
      }
    }
    for (const group of reverseChargeByGroup.values()) {
      if (group.baseOre === 0) continue
      const sign = group.baseOre < 0 ? -1 : 1
      const base = toKronor(Math.abs(group.baseOre))
      const nonBasisBase = toKronor(Math.abs(group.nonBasisBaseOre))
      appendReverseChargeLines(
        generateReverseChargePurchaseLines({
          base,
          rate: group.rate,
          kind: group.kind,
          basisBase: nonBasisBase,
        }),
        sign,
      )
    }

    payableLines.push(signedLine(
      PAYABLES_ACCOUNT,
      'credit',
      payableOre,
      'Leverantörsskulder vid räkenskapsårets utgång (kontantmetoden)',
    ))
  }

  return {
    receivableLines,
    payableLines,
    receivableTotal: toKronor(Math.abs(receivableOre)),
    payableTotal: toKronor(Math.abs(payableOre)),
  }
}

function comparableLines(lines: Array<{
  account_number: string
  debit_amount: number | string | null
  credit_amount: number | string | null
}>): string[] {
  return lines
    .map((line) =>
      [
        line.account_number,
        roundOre(Number(line.debit_amount ?? 0)).toString(),
        roundOre(Number(line.credit_amount ?? 0)).toString(),
      ].join(':'),
    )
    .sort()
}

export function cutoffLinesEqual(
  left: CreateJournalEntryLineInput[],
  right: Array<{
    account_number: string
    debit_amount: number | string | null
    credit_amount: number | string | null
  }>,
): boolean {
  const normalizedLeft = comparableLines(left)
  const normalizedRight = comparableLines(right)
  return normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((line, index) => line === normalizedRight[index])
}

/**
 * LEGACY: inspect the immutable journal for a complete aggregate cut-off and
 * its day-one reversals. Used only for a period that already holds a posted
 * legacy cut-off (assessKontantmetodCutoff's legacy mode), unchanged.
 *
 * Entries are found through their marker rows, never through their grundbok
 * text: `kontantmetod_cutoff_entries` is what the writer wrote, so the finder
 * and the two VAT functions now agree on the same recorded fact instead of
 * three independent copies of a Swedish sentence. Legacy cut-offs were marked
 * by the migration's one-time backfill, so there is no text fallback here.
 *
 * Matching exact account totals on top of the marker, rather than trusting the
 * marker alone, makes a late invoice or payment reopen the blocker until a
 * fresh cut-off is posted. Status is filtered here rather than in the query:
 * a stornoed cut-off keeps its marker (posted rows are never edited), and it
 * must read as absent so a replacement pair can be posted.
 */
export async function inspectKontantmetodCutoffPostings(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  nextFiscalPeriodId: string,
  periodEnd: string,
  expected: CutoffLines,
): Promise<KontantmetodCutoffPostingStatus> {
  const { data, error } = await supabase
    .from('kontantmetod_cutoff_entries')
    .select(
      'kind, entry:journal_entries!inner(id, fiscal_period_id, entry_date, status, lines:journal_entry_lines(account_number, debit_amount, credit_amount))',
    )
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)

  if (error) {
    throw new Error(`Kontantmetodens bokslutsavgränsning kunde inte kontrolleras: ${error.message}`)
  }

  const rows: PostedCutoffEntry[] = []
  for (const row of (data ?? []) as Array<{
    kind: KontantmetodCutoffKind
    entry: MarkedCutoffEntry | MarkedCutoffEntry[] | null
  }>) {
    const entry = Array.isArray(row.entry) ? row.entry[0] : row.entry
    if (!entry || entry.status !== 'posted') continue
    if (entry.fiscal_period_id !== fiscalPeriodId && entry.fiscal_period_id !== nextFiscalPeriodId) {
      continue
    }
    rows.push({ ...entry, kind: row.kind, lines: entry.lines ?? [] })
  }

  const missing: KontantmetodCutoffPostingStatus['missing'] = []
  const duplicates: string[] = []

  const matchOne = (
    kind: LegacyKontantmetodCutoffKind,
    periodId: string,
    lines: CreateJournalEntryLineInput[],
    expectedDate: string,
  ): string | null => {
    const label = CUTOFF_DESCRIPTION_BY_KIND[kind]
    const candidates = rows.filter(
      (row) => row.kind === kind && row.fiscal_period_id === periodId,
    )

    if (lines.length === 0) {
      if (candidates.length > 0) duplicates.push(label)
      return null
    }

    const exact = candidates.filter(
      (row) => row.entry_date === expectedDate && cutoffLinesEqual(lines, row.lines ?? []),
    )
    if (candidates.length !== 1 || exact.length !== 1) {
      // Any marker with non-matching lines is a conflict, even when only one
      // exists. Treating it as merely missing could stage a second cut-off on
      // top of an immutable entry after the source reskontra changed.
      if (candidates.length > 0) duplicates.push(label)
      missing.push(kind)
      return null
    }
    return exact[0]!.id
  }

  const receivableEntryId = matchOne(
    'receivable',
    fiscalPeriodId,
    expected.receivableLines,
    periodEnd,
  )
  const receivableReversalId = matchOne(
    'receivable_reversal',
    nextFiscalPeriodId,
    reverseLines(expected.receivableLines),
    nextDay(periodEnd),
  )
  const payableEntryId = matchOne(
    'payable',
    fiscalPeriodId,
    expected.payableLines,
    periodEnd,
  )
  const payableReversalId = matchOne(
    'payable_reversal',
    nextFiscalPeriodId,
    reverseLines(expected.payableLines),
    nextDay(periodEnd),
  )

  return {
    complete: missing.length === 0 && duplicates.length === 0,
    hasAny: rows.length > 0,
    receivableEntryId,
    receivableReversalId,
    payableEntryId,
    payableReversalId,
    missing,
    duplicates,
  }
}

/** Swap every debit and credit: the vändning posted on day 1 of the new year. */
export function reverseLines(
  lines: CreateJournalEntryLineInput[],
): CreateJournalEntryLineInput[] {
  return lines.map((line) => ({
    ...line,
    debit_amount: line.credit_amount,
    credit_amount: line.debit_amount,
    line_description: `Vändning: ${line.line_description ?? ''}`.trim(),
  }))
}

/** The day after `date`, ISO. Used to date the vändning. */
export function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/** A customer invoice row as the carry builder reads it (full row + items). */
export interface CustomerCarrySource extends InvoiceRegistrationLinesSource {
  invoice_date: string
  status: string
  credited_invoice_id?: string | null
  deduction_total?: number | null
  deduction_reclaimed_total?: number | null
  journal_entry_id?: string | null
}

/**
 * One invoice open at period end and not linked to any verifikat: the source
 * of one carry verifikat. Amounts are in the invoice's own currency and
 * signed like its total (negative on a credit note).
 */
export type KontantmetodCarryDoc =
  | {
      side: 'customer'
      invoice: CustomerCarrySource
      reference: string
      creditNote: boolean
      /** As-of outstanding at period end (the reskontra's rule). */
      outstandingOwn: number
      /** What the customer owes in full: the total minus any ROT/RUT share. */
      customerShareOwn: number
      /**
       * Carry Skatteverket's share alone: a ROT/RUT invoice the customer paid
       * in the year under kontantmetodens two steps (its payment booked only
       * the customer's share), whose payout was still to come on period end
       * (findDeductionShareCarries). The fordran on Skatteverket is booked on
       * 1513 with the share's revenue and moms (buildDeductionCarryLines).
       */
      deductionShare?: boolean
    }
  | {
      side: 'supplier'
      invoice: SupplierInvoice
      items: SupplierInvoiceItem[]
      supplierType: string
      /**
       * The company's momskoder, read only for a reverse-charge invoice (the
       * registration builder needs them there: reverseChargeOnAccount,
       * crm#1096); undefined otherwise.
       */
      chart?: ChartVatTreatments
      reference: string
      creditNote: boolean
      /** As-of outstanding at period end, signed (negative on a credit note). */
      outstandingOwn: number
      /** The invoice total, signed. */
      totalOwn: number
    }

/**
 * An invoice open at period end that was paid after period end, before the
 * cut-off was posted, through a generated kontantmetod cash verifikat (E):
 * E booked the revenue or cost and the moms at payment, while the carry books
 * them in the closed year. E is corrected with correctEntry (storno plus a
 * rättelse that clears 1510 / 2440) after the carry posts. The resume case,
 * an invoice already carried whose correction is still missing, is listed
 * the same way with its carry.
 */
export interface PaidBeforePosting {
  side: 'customer' | 'supplier'
  invoiceId: string
  reference: string
  /** The cash verifikat booked at payment. */
  entryId: string
  entryDate: string
  /** The one payment row that points at it. */
  paymentRowId: string
  /** The payment row's amount, in the invoice's own currency. */
  paymentAmount: number
  /** The carry verifikat when the invoice is already carried, else null. */
  carryEntryId: string | null
}

/**
 * The same situation where E cannot be corrected automatically: E settles
 * several invoices, is not a generated cash verifikat (a manual, batch or
 * SIE voucher), or the payment row has no verifikat at all. Code
 * KONTANTMETOD_CUTOFF_PAID_BEFORE_POSTING_MANUAL.
 */
export interface PaidBeforePostingManual {
  side: 'customer' | 'supplier'
  invoiceId: string
  reference: string
  entryId: string | null
  entryDate: string | null
  paymentRowId: string
  reason: 'shared_verifikat' | 'not_generated_cash_entry' | 'no_verifikat'
}

/**
 * An invoice a legacy cut-off (with vändning, self-hosted only) already
 * covered at an earlier year end and that is still open now. Its moms may
 * already have been declared through that legacy cut-off, so it is withheld
 * from the automatic carry (KONTANTMETOD_LEGACY_COVERED) until the byrå
 * acknowledges it by id.
 */
export interface LegacyCoveredInvoice {
  side: 'customer' | 'supplier'
  invoiceId: string
  reference: string
  /** period_end of the earliest legacy cut-off that covered it. */
  legacyPeriodEnd: string
}

/** An earlier year end closed with a legacy cut-off (aggregate + vändning). */
export interface LegacyCutoffRef {
  fiscalPeriodId: string
  periodEnd: string
  receivable: boolean
  payable: boolean
}

export interface CutoffCollection {
  /**
   * Legacy aggregate rows: what a legacy cut-off of THIS period would book.
   * Read only in legacy mode (a period that already holds a posted legacy
   * cut-off), by buildCutoffLines and the legacy inspector, unchanged.
   */
  receivables: CutoffReceivable[]
  payables: CutoffPayable[]
  /**
   * Invoices whose vat_treatment is missing. Never guessed at: a reduced-rate
   * or exempt invoice silently defaulted to 25 % would land on the wrong
   * moms account and the wrong revenue account. Posting refuses while this
   * is non-empty so the user fixes the source rows instead.
   */
  unknownVatTreatment: string[]
  /**
   * Invoices carrying moms on a treatment that cannot have Swedish output moms
   * (export, omvänd betalningsskyldighet, undantagen). Absorbing that into the
   * revenue line would balance the verifikat while silently swallowing a real
   * invoicing error, which is the netting the swedish-vat reference prohibits.
   * Excluded and refused on the same footing as a missing treatment.
   */
  strayVatOnZeroRate: string[]
  /**
   * Customer and supplier invoices whose period-end state is an assumption,
   * not evidence: settled (wholly or in part) with neither a payment row nor
   * paid_at, so the reskontra's as-of rule takes today's state as the state
   * at period end. Typically history a provider migration imported already
   * paid. Never refused (the assumption is the reskontra's own rule), but
   * always disclosed: an invoice among them that was paid after period end
   * was a fordran or skuld on the day and is missing from the cut-off.
   */
  undatedSettlements: string[]
  /** Per-invoice årsomföring: every unlinked invoice to carry, one verifikat each. */
  carries: KontantmetodCarryDoc[]
  /**
   * ROT/RUT (and grön teknik) invoices with any settlement before period end,
   * or a reclaimed deduction: never carried automatically
   * (KONTANTMETOD_CUTOFF_ROT_PARTIAL_MANUAL). The 1513 share and the moms
   * already booked at the year-1 payment cannot be split from the remainder
   * by a rule.
   */
  rotPartialManual: string[]
  /**
   * The same invoices by id, with the bounds a manual carry of each is
   * checked against (buildKontantmetodManualCarryPlan). The accountant books
   * the open part through the cut-off's manual_carries input, which posts and
   * links it like any carry.
   */
  rotPartialManualInvoices: RotPartialManualInvoice[]
  paidBeforePosting: PaidBeforePosting[]
  paidBeforePostingManual: PaidBeforePostingManual[]
  /** Withheld from `carries` until acknowledged. */
  legacyCovered: LegacyCoveredInvoice[]
}

/**
 * A ROT/RUT invoice the rule cannot carry (rotPartialManual), with what a
 * manual carry of it must hold. Amounts are SEK magnitudes at the invoice's
 * own rate, the rate the year-2 clearing credits.
 */
export interface RotPartialManualInvoice {
  invoiceId: string
  reference: string
  creditNote: boolean
  /**
   * The customer share still open on period end: exactly what the manual
   * carry puts on 151x (1513 excluded). Null when it cannot be translated to
   * SEK; such an invoice cannot be carried manually either.
   */
  openCustomerShareSek: number | null
  /**
   * Exactly what the manual carry puts on 1513: Skatteverket's share of the
   * open part. The share of the part paid before period end was booked at
   * that payment and is never carried again; less than this leaves the
   * year-2 payout clearing 1513 with no moms behind it, so the moms on the
   * difference is never declared and 1513 goes negative.
   */
  openDeductionSek: number
  /**
   * Whether the open part carries moms. The year-2 payment and payout clear
   * 1510 / 1513 with no moms, so when it does the carry must book it.
   */
  openPartHasVat: boolean
}

/**
 * The disclosure for `undatedSettlements`, one wording for the readiness
 * warning and the staged cut-off. Null when nothing was assumed.
 */
export function undatedSettlementsNote(count: number, periodEnd: string): string | null {
  if (count <= 0) return null
  const subject = count === 1 ? '1 faktura saknar' : `${count} fakturor saknar`
  const assumption = count === 1 ? 'att den hade' : 'att de hade'
  const check = count === 1 ? 'att den inte betalades' : 'att ingen av dem betalades'
  return (
    `${subject} betalningsdatum: kontantmetodens bokslutsavgränsning antar ${assumption} ` +
    `samma betalstatus per ${periodEnd} som i dag. Kontrollera mot banken ${check} efter ${periodEnd}.`
  )
}

/** One carry verifikat, ready to post: what the preview shows is what posts. */
export interface KontantmetodCarryPlan {
  side: 'customer' | 'supplier'
  invoiceId: string
  reference: string
  creditNote: boolean
  /**
   * 'full': the registration builder's lines exactly. 'proportional': the
   * invoice was partly settled on period end (a legacy partial or an undated
   * settlement), so the same lines are scaled to the part still open.
   * 'manual': lines the accountant wrote for an invoice the rule cannot
   * carry (KONTANTMETOD_CUTOFF_ROT_PARTIAL_MANUAL), checked by
   * buildKontantmetodManualCarryPlan and posted and linked like any carry.
   */
  mode: 'full' | 'proportional' | 'manual'
  description: string
  notes: string
  lines: CreateJournalEntryLineInput[]
  /** The 1510 / 2440 leg in SEK, a magnitude. */
  total: number
}

export interface KontantmetodCutoffAssessment {
  /**
   * 'legacy' when this period already holds a posted legacy cut-off
   * (aggregate verifikat with vändning): it is judged by the legacy inspector,
   * unchanged, and nothing new is posted into it. 'per_invoice' otherwise.
   */
  mode: 'per_invoice' | 'legacy'
  collection: CutoffCollection
  /** per_invoice: one plan per invoice still to carry. Empty in legacy mode. */
  plans: KontantmetodCarryPlan[]
  /** Legacy mode only: the aggregate lines the legacy inspector compares. */
  lines: CutoffLines
  /** Legacy mode: the inspector's status. per_invoice: a summary of `complete`. */
  postings: KontantmetodCutoffPostingStatus
  /**
   * True when nothing is left to do for the cut-off of this period: no
   * invoice left to carry, no payment to correct, nothing manual, nothing
   * withheld, no invoice with an unusable moms setting (legacy: the
   * inspector found the exact pair and vändning).
   */
  complete: boolean
  /** Earlier year ends closed with a legacy cut-off, for the warning. */
  legacyCutoffs: LegacyCutoffRef[]
}

const EMPTY_CUTOFF_LINES: CutoffLines = {
  receivableLines: [],
  payableLines: [],
  receivableTotal: 0,
  payableTotal: 0,
}

export function sortedCutoffCollection(collection: CutoffCollection): CutoffCollection {
  const byInvoice = <T extends { side: string; invoiceId: string }>(rows: T[]): T[] =>
    [...rows].sort((a, b) => `${a.side}:${a.invoiceId}`.localeCompare(`${b.side}:${b.invoiceId}`))
  return {
    receivables: [...collection.receivables].sort((a, b) => a.id.localeCompare(b.id)),
    payables: [...collection.payables]
      .map((row) => ({
        ...row,
        netByAccount: [...row.netByAccount].sort((a, b) => a.account.localeCompare(b.account)),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    unknownVatTreatment: [...collection.unknownVatTreatment].sort(),
    strayVatOnZeroRate: [...collection.strayVatOnZeroRate].sort(),
    undatedSettlements: [...collection.undatedSettlements].sort(),
    carries: [...collection.carries].sort((a, b) =>
      `${a.side}:${a.invoice.id}`.localeCompare(`${b.side}:${b.invoice.id}`),
    ),
    rotPartialManual: [...collection.rotPartialManual].sort(),
    rotPartialManualInvoices: [...collection.rotPartialManualInvoices].sort((a, b) =>
      a.invoiceId.localeCompare(b.invoiceId),
    ),
    paidBeforePosting: byInvoice(collection.paidBeforePosting),
    paidBeforePostingManual: byInvoice(collection.paidBeforePostingManual),
    legacyCovered: byInvoice(collection.legacyCovered),
  }
}

/**
 * The part of a collection that decides what gets posted, in a stable order:
 * the carries by identity and amount rather than as whole invoice rows,
 * whose bookkeeping-irrelevant columns (updated_at, notes) would make the
 * comparison churn.
 */
function canonicalCollection(collection: CutoffCollection) {
  const sorted = sortedCutoffCollection(collection)
  return {
    ...sorted,
    carries: sorted.carries.map((doc) => ({
      side: doc.side,
      id: doc.invoice.id,
      outstanding_own: roundOre(doc.outstandingOwn),
    })),
  }
}

function canonicalLines(lines: CreateJournalEntryLineInput[]): string[] {
  return lines
    .map((line) => JSON.stringify({
      account_number: line.account_number,
      debit_amount: roundOre(line.debit_amount),
      credit_amount: roundOre(line.credit_amount),
      line_description: line.line_description ?? null,
    }))
    .sort()
}

/**
 * The fingerprint a staged cut-off is approved against: the collection, every
 * per-invoice carry verifikat (header text and lines), every correction of a
 * cash verifikat booked before the cut-off (its corrected lines, or why it
 * cannot be corrected automatically), the legacy aggregate lines, the entity
 * type, the period end and what the approver acknowledged (filed VAT periods
 * that need a rättad momsdeklaration, legacy-covered invoices to carry). Any
 * change to what would be posted, or to what was acknowledged, changes it.
 */
export function cutoffPreviewFingerprint(args: {
  collection: CutoffCollection
  lines: CutoffLines
  entityType: EntityType
  periodEnd: string
  plans?: KontantmetodCarryPlan[]
  corrections?: PaidBeforePostingCorrectionPreview[]
  correctionRefusals?: PaidBeforePostingCorrectionRefusal[]
  acknowledgedFiledVatPeriods?: readonly string[]
  acknowledgedLegacyInvoiceIds?: readonly string[]
}): string {
  const byKey = <T extends { side: string; invoiceId: string; entryId: string | null }>(rows: T[]): T[] =>
    [...rows].sort((a, b) =>
      `${a.side}:${a.invoiceId}:${a.entryId ?? ''}`.localeCompare(`${b.side}:${b.invoiceId}:${b.entryId ?? ''}`),
    )
  const plans = [...(args.plans ?? [])]
    .sort((a, b) => `${a.side}:${a.invoiceId}`.localeCompare(`${b.side}:${b.invoiceId}`))
    .map((plan) => ({
      side: plan.side,
      invoice_id: plan.invoiceId,
      mode: plan.mode,
      description: plan.description,
      lines: canonicalLines(plan.lines),
    }))
  const corrections = byKey(args.corrections ?? []).map((c) => ({
    side: c.side,
    invoice_id: c.invoiceId,
    entry_id: c.entryId,
    entry_date: c.entryDate,
    corrected_lines: canonicalLines(c.correctedLines),
  }))
  const correctionRefusals = byKey(args.correctionRefusals ?? []).map((c) => ({
    side: c.side,
    invoice_id: c.invoiceId,
    entry_id: c.entryId,
    reason: c.reason,
  }))
  const payload = JSON.stringify({
    collection: canonicalCollection(args.collection),
    entity_type: args.entityType,
    period_end: args.periodEnd,
    reversal_date: nextDay(args.periodEnd),
    receivable_lines: canonicalLines(args.lines.receivableLines),
    payable_lines: canonicalLines(args.lines.payableLines),
    plans,
    corrections,
    correction_refusals: correctionRefusals,
    acknowledged_filed_vat_periods: [...new Set(args.acknowledgedFiledVatPeriods ?? [])].sort(),
    acknowledged_legacy_invoice_ids: [...new Set(args.acknowledgedLegacyInvoiceIds ?? [])].sort(),
  })
  return createHash('sha256').update(payload).digest('hex')
}

/**
 * An aggregate verifikat still has to say which affärshändelser it covers
 * (BFL 5 kap 6-7 §: motpart and underlag must be traceable). The lines are
 * grouped by account, so the invoice references go into the entry `notes`
 * where an examiner can follow them back to the sub-ledger.
 *
 * Truncated past a sane length: the note is a pointer to the reskontra, not a
 * replacement for it, and an unbounded note on a company with thousands of
 * open invoices helps nobody.
 */
export function buildCutoffNote(label: string, references: string[]): string {
  const named = references.filter((ref) => ref && ref.trim().length > 0)
  if (named.length === 0) return `${label}: inga fakturanummer registrerade`
  const MAX = 50
  const shown = named.slice(0, MAX).join(', ')
  const rest = named.length - Math.min(named.length, MAX)
  return rest > 0
    ? `${label} (${named.length} st): ${shown} och ${rest} till. ` +
        'Fullständig specifikation finns i reskontran per bokslutsdagen.'
    : `${label} (${named.length} st): ${shown}`
}

function resolveHeaderSek(
  row: Record<string, unknown>,
  amountKey: string,
  sekKey: string,
): number {
  const amount = Number(row[amountKey] ?? 0)
  const sekValue = row[sekKey]
  const sek = sekValue == null ? null : Number(sekValue)
  if (sek != null && Number.isFinite(sek) && (amount === 0 || sek !== 0)) return sek
  const currency = String(row.currency ?? 'SEK').toUpperCase()
  if (currency === 'SEK') return amount
  const rate = Number(row.exchange_rate ?? 0)
  if (Number.isFinite(rate) && rate > 0) return sekOfForeign(amount, rate)
  throw new Error(
    `Faktura ${String(row.id ?? '')} i ${currency} saknar användbart SEK-belopp eller valutakurs`,
  )
}

// ---------------------------------------------------------------------------
// Per-invoice carry lines (årsomföring)
// ---------------------------------------------------------------------------

export interface KontantmetodCarryLines {
  lines: CreateJournalEntryLineInput[]
  mode: 'full' | 'proportional'
  /** The 1510 / 2440 leg in SEK, a magnitude. */
  anchorSek: number
}

/** The receivable / payable account the carry leaves the invoice on. */
const CARRY_ANCHOR_ACCOUNT = { customer: RECEIVABLES_ACCOUNT, supplier: PAYABLES_ACCOUNT } as const

/** Swap every debit and credit, keeping everything else (a credit note's mirror). */
function mirrorLines(lines: CreateJournalEntryLineInput[]): CreateJournalEntryLineInput[] {
  return lines.map((line) => ({
    ...line,
    debit_amount: line.credit_amount,
    credit_amount: line.debit_amount,
    ...(line.amount_in_currency != null ? { amount_in_currency: -line.amount_in_currency } : {}),
  }))
}

function anchorLineOf(
  lines: CreateJournalEntryLineInput[],
  account: string,
): CreateJournalEntryLineInput {
  const anchors = lines.filter((line) => line.account_number === account)
  if (anchors.length !== 1) {
    throw new Error(`Årsomföringen ska ha exakt en rad på ${account}, hittade ${anchors.length}`)
  }
  return anchors[0]!
}

/**
 * Scale a full registration verifikat to the part of the invoice still open:
 * the anchor (1510 / 2440) becomes exactly `targetSek`, every other line its
 * proportional share in whole öre, and the rounding residual lands on the
 * largest line so the verifikat balances. The accounts are the registration
 * builder's own, so the moms stays on the ordinary 2611/2621/2631/2641.
 */
function scaleCarryLines(
  full: CreateJournalEntryLineInput[],
  anchorAccount: string,
  targetSek: number,
  targetOwn: number,
): CreateJournalEntryLineInput[] {
  const anchor = anchorLineOf(full, anchorAccount)
  const anchorNetOre = toOre(anchor.debit_amount) - toOre(anchor.credit_amount)
  if (anchorNetOre === 0) throw new Error(`Årsomföringens rad på ${anchorAccount} saknar belopp`)
  const targetOre = toOre(targetSek) * Math.sign(anchorNetOre)
  const ratio = targetOre / anchorNetOre

  const others = full.filter((line) => line !== anchor)
  const scaled = others.map((line) =>
    Math.round((toOre(line.debit_amount) - toOre(line.credit_amount)) * ratio),
  )
  // The other lines must net to the anchor's opposite, to the öre.
  const residual = -targetOre - scaled.reduce((sum, ore) => sum + ore, 0)
  if (residual !== 0 && scaled.length > 0) {
    let largest = 0
    scaled.forEach((ore, index) => {
      if (Math.abs(ore) > Math.abs(scaled[largest]!)) largest = index
    })
    scaled[largest] = scaled[largest]! + residual
  }

  const sideOf = (ore: number) => ({
    debit_amount: ore > 0 ? toKronor(ore) : 0,
    credit_amount: ore < 0 ? toKronor(-ore) : 0,
  })
  const ownAbs = roundOre(Math.abs(targetOwn))
  const scaledAnchor: CreateJournalEntryLineInput = {
    ...anchor,
    ...sideOf(targetOre),
    ...(anchor.amount_in_currency != null
      ? { amount_in_currency: Math.sign(anchor.amount_in_currency) * ownAbs }
      : {}),
  }
  const result: CreateJournalEntryLineInput[] = []
  for (const line of full) {
    if (line === anchor) {
      result.push(scaledAnchor)
      continue
    }
    const ore = scaled[others.indexOf(line)]!
    if (ore === 0) continue
    result.push({ ...line, ...sideOf(ore) })
  }
  return result
}

/**
 * The lines of one invoice's carry verifikat. Pure: no IO.
 *
 * When the invoice was entirely open on period end (the outstanding equals
 * the full customer share, or the full supplier total), the carry is the
 * invoice's own registration verifikat exactly as faktureringsmetoden books
 * it at issue: buildInvoiceRegistrationLines (a credit note:
 * buildCreditNoteLines) or supplierInvoiceRegistrationLines, with
 * deferAccruals off (no accrual schedule exists under kontantmetoden, so a
 * 29xx / 17xx balance would never dissolve). For ROT/RUT that includes the
 * 1513 leg: the full revenue and moms belong to the closed year, the
 * customer's share sits on 1510 and Skatteverket's on 1513.
 *
 * When part of it was settled on period end (a legacy partial payment, or an
 * undated settlement the reskontra assumes), the same lines are scaled to the
 * open part. The 1510 / 2440 leg is then the open part translated at the
 * invoice rate (headerToSekOrThrow / toSekOrThrow), which is exactly what the
 * year-2 clearing credits (createInvoicePaymentJournalEntry's
 * bookedSekAmount), so the receivable clears to the öre. A ROT/RUT invoice
 * never reaches the proportional path: the collector refuses it
 * (KONTANTMETOD_CUTOFF_ROT_PARTIAL_MANUAL).
 */
export function buildKontantmetodCarryLines(
  doc: KontantmetodCarryDoc,
  entityType: EntityType,
): KontantmetodCarryLines {
  const anchorAccount = CARRY_ANCHOR_ACCOUNT[doc.side]

  let full: CreateJournalEntryLineInput[]
  let isFull: boolean
  let openOwn: number
  let currency: string
  let exchangeRate: number | null | undefined

  if (doc.side === 'customer' && doc.deductionShare) {
    // Skatteverket's share alone: the customer's share was booked at its
    // payment in the year. Whole or not at all: nothing of it was received.
    const lines = buildDeductionCarryLines(doc.invoice, entityType)
    if (!lines) throw new Error('Skatteverkets andel kan inte delas av fakturans rader')
    const anchorSek = roundOre(
      lines
        .filter((line) => line.account_number === ROT_RUT_RECEIVABLE_ACCOUNT)
        .reduce((sum, line) => sum + line.debit_amount - line.credit_amount, 0),
    )
    return { lines, mode: 'full', anchorSek }
  }

  if (doc.side === 'customer') {
    const invoice = doc.invoice
    full = doc.creditNote
      ? buildCreditNoteLines(invoice, entityType, undefined, { deferAccruals: false })
      : buildInvoiceRegistrationLines(invoice, entityType, null, { deferAccruals: false })
    isFull = Math.abs(doc.outstandingOwn - doc.customerShareOwn) < ORE_TOLERANCE
    openOwn = doc.outstandingOwn
    currency = invoice.currency
    exchangeRate = invoice.exchange_rate
  } else {
    const invoice = doc.invoice
    if (doc.creditNote) {
      // A leverantörskreditfaktura keeps the original's items, each signed as
      // the original books it (crm#1094: a rabatt row stays negative): the
      // registration shape of the credited amount, mirrored, is the credit
      // note's verifikat (Dr 2440 / Cr cost / Cr 2641), as
      // createSupplierCreditNoteEntry books it. Rows stored with the credit
      // note's own (negative) sign are turned as a whole, never row by row,
      // so a row's sign relative to the others survives.
      const net = doc.items.reduce((sum, item) => sum + Number(item.line_total ?? 0), 0)
      const sign = net < 0 ? -1 : 1
      const items = doc.items.map((item) => ({
        ...item,
        line_total: sign * Number(item.line_total ?? 0),
        vat_amount: sign * Number(item.vat_amount ?? 0),
      }))
      full = mirrorLines(supplierInvoiceRegistrationLines(
        { ...invoice, total: Math.abs(invoice.total) },
        items,
        doc.supplierType,
        supplierCarryDescription(invoice),
        doc.chart,
        { deferAccruals: false },
      ))
    } else {
      full = supplierInvoiceRegistrationLines(
        invoice,
        doc.items,
        doc.supplierType,
        supplierCarryDescription(invoice),
        doc.chart,
        { deferAccruals: false },
      )
    }
    isFull = Math.abs(doc.outstandingOwn - doc.totalOwn) < ORE_TOLERANCE
    openOwn = doc.outstandingOwn
    currency = invoice.currency
    exchangeRate = invoice.exchange_rate
  }

  if (isFull) {
    const anchor = anchorLineOf(full, anchorAccount)
    return {
      lines: full,
      mode: 'full',
      anchorSek: roundOre(anchor.debit_amount + anchor.credit_amount),
    }
  }

  const targetSek = roundOre(Math.abs(
    doc.side === 'customer'
      ? headerToSekOrThrow(Math.abs(openOwn), null, currency, exchangeRate)
      : toSekOrThrow(Math.abs(openOwn), currency, exchangeRate),
  ))
  return {
    lines: scaleCarryLines(full, anchorAccount, targetSek, openOwn),
    mode: 'proportional',
    anchorSek: targetSek,
  }
}

/**
 * Line text of a supplier carry: the registration verifikat's own line text
 * (createSupplierInvoiceRegistrationEntry), without the supplier name.
 */
function supplierCarryDescription(
  invoice: Pick<SupplierInvoice, 'supplier_invoice_number' | 'arrival_number'>,
): string {
  return buildSupplierDescription('Leverantörsfaktura', invoice.supplier_invoice_number, undefined, `(ankomstnr ${invoice.arrival_number})`)
}

/** Grundbok text of a carry verifikat. Display only: identity is the marker. */
export function kontantmetodCarryDescription(
  side: 'customer' | 'supplier',
  reference: string,
  creditNote: boolean,
  deductionShare = false,
): string {
  if (side === 'customer' && deductionShare) {
    return `Kundfaktura ${reference}: Skatteverkets andel ej utbetald vid bokslut (kontantmetoden)`
  }
  if (side === 'customer') {
    return creditNote
      ? `Kreditfaktura ${reference}: oreglerad vid bokslut (kontantmetoden)`
      : `Kundfaktura ${reference}: obetald vid bokslut (kontantmetoden)`
  }
  return creditNote
    ? `Leverantörskreditfaktura ${reference}: oreglerad vid bokslut (kontantmetoden)`
    : `Leverantörsfaktura ${reference}: obetald vid bokslut (kontantmetoden)`
}

/**
 * Build the ready-to-post plan of one carry. Throws, naming the invoice, when
 * the lines cannot be built (a foreign invoice with no usable rate) or do not
 * balance: a cut-off is never posted on a guess.
 */
export function buildKontantmetodCarryPlan(
  doc: KontantmetodCarryDoc,
  entityType: EntityType,
): KontantmetodCarryPlan {
  let built: KontantmetodCarryLines
  try {
    built = buildKontantmetodCarryLines(doc, entityType)
  } catch (err) {
    throw new Error(
      `Årsomföringen för faktura ${doc.reference} kunde inte byggas: ` +
        (err instanceof Error ? err.message : 'okänt fel'),
    )
  }
  const finite = built.lines.every(
    (line) => Number.isFinite(line.debit_amount) && Number.isFinite(line.credit_amount),
  )
  if (!finite || !lineBalance(built.lines).balanced || built.anchorSek <= 0) {
    throw new Error(`Årsomföringen för faktura ${doc.reference} balanserar inte`)
  }
  return {
    side: doc.side,
    invoiceId: doc.invoice.id,
    reference: doc.reference,
    creditNote: doc.creditNote,
    mode: built.mode,
    description: kontantmetodCarryDescription(
      doc.side, doc.reference, doc.creditNote, doc.side === 'customer' && !!doc.deductionShare,
    ),
    notes: `Årsomföring kontantmetoden, BFL 5 kap 2 §, faktura ${doc.reference}`,
    lines: built.lines,
    total: built.anchorSek,
  }
}

// ---------------------------------------------------------------------------
// Manual carries (KONTANTMETOD_CUTOFF_ROT_PARTIAL_MANUAL)
// ---------------------------------------------------------------------------

export const KONTANTMETOD_MANUAL_CARRY_INVALID = 'KONTANTMETOD_MANUAL_CARRY_INVALID' as const
/** The manual carry's 1513 is not exactly Skatteverket's share of the open part. */
export const KONTANTMETOD_MANUAL_CARRY_DEDUCTION_MISMATCH = 'KONTANTMETOD_MANUAL_CARRY_DEDUCTION_MISMATCH' as const

export type KontantmetodManualCarryErrorCode =
  | typeof KONTANTMETOD_MANUAL_CARRY_INVALID
  | typeof KONTANTMETOD_MANUAL_CARRY_DEDUCTION_MISMATCH

/** A manual carry the cut-off refuses to stage or post, naming why. */
export class KontantmetodManualCarryError extends Error {
  readonly code: KontantmetodManualCarryErrorCode
  constructor(message: string, code: KontantmetodManualCarryErrorCode = KONTANTMETOD_MANUAL_CARRY_INVALID) {
    super(message)
    this.name = 'KontantmetodManualCarryError'
    this.code = code
  }
}

/** One manual carry as the staging tool takes it: the invoice and its lines. */
export interface KontantmetodManualCarryInput {
  invoice_id: string
  lines: Array<{
    account_number: string
    debit_amount: number
    credit_amount: number
    line_description?: string
  }>
}

const MANUAL_CARRY_MAX_LINES = 50

/**
 * Check the lines an accountant wrote for one ROT/RUT invoice the rule cannot
 * carry, and turn them into a plan that posts and links exactly like a
 * rule-built carry (year_end on period_end, record_kontantmetod_cutoff_link),
 * so the marker guard, the link and the year-2 clearing all apply. Pure.
 *
 * The lines must balance, book no money (19xx), put exactly the open customer
 * share on 151x outside 1513 (debit; credit for a credit note), and put on
 * 1513 exactly Skatteverket's share of the open part
 * (KONTANTMETOD_MANUAL_CARRY_DEDUCTION_MISMATCH otherwise): the share of the
 * part paid before period end was booked at that payment and is never carried
 * again, and the year-2 payout clears the rest of 1513 with no moms. Every
 * other line is the revenue (3xxx) and output moms (261x to 263x) behind those
 * two receivables, on the opposite side, so the open part's full revenue and
 * moms land in the closed year: revenue always, moms whenever the open part
 * carries moms and never when it does not. How the revenue and the moms split
 * is the accountant's: the moms already booked at the year-1 payment cannot
 * be read back by a rule.
 */
export function buildKontantmetodManualCarryPlan(
  target: RotPartialManualInvoice,
  rawLines: unknown,
): KontantmetodCarryPlan {
  const fail = (why: string): never => {
    throw new KontantmetodManualCarryError(`Manuell årsomföring av faktura ${target.reference}: ${why}`)
  }
  if (target.openCustomerShareSek == null || target.openCustomerShareSek <= 0) {
    fail('den obetalda delen kan inte räknas om till kronor')
  }
  if (!Array.isArray(rawLines) || rawLines.length < 2 || rawLines.length > MANUAL_CARRY_MAX_LINES) {
    fail(`ange mellan 2 och ${MANUAL_CARRY_MAX_LINES} rader`)
  }
  const lines: CreateJournalEntryLineInput[] = []
  for (const raw of rawLines as unknown[]) {
    const line = raw as Record<string, unknown> | null
    const account = line?.account_number
    if (typeof account !== 'string' || !ACCOUNT_NUMBER_RE.test(account)) {
      fail('varje rad behöver ett fyrsiffrigt kontonummer')
    }
    const debit = Number(line?.debit_amount ?? 0)
    const credit = Number(line?.credit_amount ?? 0)
    if (!Number.isFinite(debit) || !Number.isFinite(credit) || debit < 0 || credit < 0) {
      fail(`raden på ${String(account)} har ett ogiltigt belopp`)
    }
    if ((debit > 0) === (credit > 0)) {
      fail(`raden på ${String(account)} ska ha antingen debet eller kredit`)
    }
    if (roundOre(debit) !== debit || roundOre(credit) !== credit) {
      fail(`raden på ${String(account)} har belopp under öre`)
    }
    if (String(account).startsWith('19')) {
      fail('en årsomföring bokför inga pengar: inga rader på 19xx')
    }
    const description = line?.line_description
    lines.push({
      account_number: account as string,
      debit_amount: debit,
      credit_amount: credit,
      ...(typeof description === 'string' && description.trim() ? { line_description: description.trim() } : {}),
    })
  }

  const net = (accept: (account: string) => boolean): number =>
    lines
      .filter((line) => accept(line.account_number))
      .reduce((sum, line) => sum + toOre(line.debit_amount) - toOre(line.credit_amount), 0)
  if (!lineBalance(lines).balanced) fail('raderna balanserar inte')

  // The invoice's own side: a kundfordran is a debit, a credit note's a credit.
  const sign = target.creditNote ? -1 : 1
  const openOre = toOre(target.openCustomerShareSek!)
  const receivableOre = net((account) => account.startsWith('151') && account !== '1513') * sign
  if (receivableOre !== openOre) {
    fail(
      `kundfordran (151x utom 1513) ska vara ${toKronor(openOre)} kr på fakturans sida, ` +
        `raderna bokför ${toKronor(receivableOre)} kr`,
    )
  }
  const deductionOre = net((account) => account === '1513') * sign
  const openDeductionOre = toOre(target.openDeductionSek)
  if (deductionOre !== openDeductionOre) {
    throw new KontantmetodManualCarryError(
      `Manuell årsomföring av faktura ${target.reference}: 1513 ska vara exakt Skatteverkets andel av den ` +
        `obetalda delen, ${toKronor(openDeductionOre)} kr på fakturans sida, raderna bokför ` +
        `${toKronor(deductionOre)} kr (andelen för den betalda delen bokfördes vid betalningen)`,
      KONTANTMETOD_MANUAL_CARRY_DEDUCTION_MISMATCH,
    )
  }

  // Everything else is the revenue and moms behind those receivables. With
  // the lines balanced and nothing else allowed, together they equal the
  // open customer share plus the 1513 share exactly.
  const isRevenue = (account: string): boolean => account.startsWith('3')
  const isOutputVat = (account: string): boolean => /^26[123]/.test(account)
  const stray = lines.find((line) =>
    !line.account_number.startsWith('151') && !isRevenue(line.account_number) && !isOutputVat(line.account_number))
  if (stray) {
    fail(
      `konto ${stray.account_number} hör inte till en årsomföring: utöver 151x och 1513 bokförs bara ` +
        'intäkt (3xxx) och utgående moms (261x till 263x)',
    )
  }
  const revenueOre = -net(isRevenue) * sign
  const vatOre = -net(isOutputVat) * sign
  if (revenueOre <= 0) fail('intäkten för den obetalda delen saknas (3xxx på motsatt sida mot kundfordran)')
  if (target.openPartHasVat && vatOre <= 0) {
    fail('momsen för den obetalda delen saknas (utgående moms 261x till 263x på motsatt sida mot kundfordran)')
  }
  if (!target.openPartHasVat && vatOre !== 0) fail('fakturan har ingen moms att bokföra på 26xx')

  return {
    side: 'customer',
    invoiceId: target.invoiceId,
    reference: target.reference,
    creditNote: target.creditNote,
    mode: 'manual',
    description: kontantmetodCarryDescription('customer', target.reference, target.creditNote),
    notes: `Manuell årsomföring kontantmetoden, BFL 5 kap 2 §, faktura ${target.reference}`,
    lines,
    total: toKronor(openOre),
  }
}

/**
 * The manual carries of one cut-off, checked against the invoices on
 * rotPartialManual. Throws KontantmetodManualCarryError for a malformed
 * input, an invoice that is not waiting for a manual carry, an invoice named
 * twice, or lines that fail buildKontantmetodManualCarryPlan. Pure.
 */
export function resolveKontantmetodManualCarries(
  collection: Pick<CutoffCollection, 'rotPartialManualInvoices'>,
  raw: unknown,
): KontantmetodCarryPlan[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    throw new KontantmetodManualCarryError('manual_carries ska vara en lista med { invoice_id, lines }')
  }
  const eligible = new Map(collection.rotPartialManualInvoices.map((item) => [item.invoiceId, item]))
  const seen = new Set<string>()
  const plans: KontantmetodCarryPlan[] = []
  for (const item of raw as unknown[]) {
    const invoiceId = (item as Record<string, unknown> | null)?.invoice_id
    if (typeof invoiceId !== 'string' || !invoiceId) {
      throw new KontantmetodManualCarryError('varje manuell årsomföring behöver invoice_id')
    }
    if (seen.has(invoiceId)) {
      throw new KontantmetodManualCarryError(`faktura ${invoiceId} förekommer två gånger i manual_carries`)
    }
    seen.add(invoiceId)
    const target = eligible.get(invoiceId)
    if (!target) {
      throw new KontantmetodManualCarryError(
        `faktura ${invoiceId} väntar inte på en manuell årsomföring (bara fakturor under KONTANTMETOD_CUTOFF_ROT_PARTIAL_MANUAL)`,
      )
    }
    plans.push(buildKontantmetodManualCarryPlan(target, (item as Record<string, unknown>).lines))
  }
  return plans.sort((a, b) => a.invoiceId.localeCompare(b.invoiceId))
}

/** The plain input form of a manual carry plan: what is staged and re-checked at approval. */
export function manualCarryInputOf(plan: KontantmetodCarryPlan): KontantmetodManualCarryInput {
  return {
    invoice_id: plan.invoiceId,
    lines: plan.lines.map((line) => ({
      account_number: line.account_number,
      debit_amount: line.debit_amount,
      credit_amount: line.credit_amount,
      ...(line.line_description ? { line_description: line.line_description } : {}),
    })),
  }
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

interface CustomerAsOf {
  totalOwn: number
  customerShareOwn: number
  hasDeduction: boolean
  outstandingOwn: number
  basis: OutstandingAsOfBasis
}

/**
 * A customer invoice's outstanding on `asOf`, in its own currency: the
 * reskontra's as-of rule (resolveOutstandingAsOf) measured against the
 * customer share, floored for ROT/RUT.
 */
function customerOutstandingAsOf(
  row: Record<string, unknown>,
  payments: PaymentsAsOf,
  asOf: string,
): CustomerAsOf {
  const totalOwn = Number(row.total ?? 0)
  // ROT/RUT (fakturamodellen): the customer owes the total minus the
  // skattereduktion. The deduction is a fordran on Skatteverket carried on
  // 1513, booked by the same voucher that recognises the sale, and every
  // settlement path records the customer share as the payment row amount.
  // Measuring the outstanding against the gross total left exactly
  // deduction_total "open" on a fully paid invoice and booked it as a phantom
  // 1510 fordran with phantom moms (#2248). The share has ONE definition
  // (lib/bookkeeping/customer-share.ts, twin of the DB guard), the as-of
  // reconstruction is the reskontra's; only the floor below belongs to the
  // cut-off.
  const shareInput = { total: totalOwn, deduction_total: Number(row.deduction_total ?? 0) }
  const hasDeduction = Math.abs(shareInput.deduction_total) > 0
  const customerShareOwn = invoiceCustomerShare(shareInput)
  // The live outstanding the kundreskontra reads (total - paid_amount),
  // measured against the customer share like the payment rows. One
  // exception: a credit note resting at 'credited' is the migration's inert
  // copy of a kreditfaktura the provider already netted into the balance of
  // the invoice it credits, whose paid_amount therefore carries it. Counting
  // it again would book the credit twice (the reporting company's own
  // kreditfaktura in feedback seq 798354). A credit note issued here rests
  // at 'sent' and keeps offsetting its original.
  const liveOwn = totalOwn < 0 && row.status === 'credited'
    ? 0
    : invoiceCustomerOutstanding(shareInput, Number(row.paid_amount ?? 0))
  const asOfResult = resolveOutstandingAsOf(
    { id: row.id as string, paid_at: (row.paid_at as string | null) ?? null },
    customerShareOwn,
    liveOwn,
    payments,
    asOf,
  )
  let outstandingOwn = asOfResult.outstanding
  if (hasDeduction) {
    // Floored at zero on the invoice's own side, the guard's GREATEST(0, ...)
    // made sign-aware so a credit note keeps its sign: an öre of
    // over-collection against a derived customer share is noise, not a
    // fordran the company owes back. A plain invoice keeps the unfloored
    // gross computation it always had.
    outstandingOwn = totalOwn < 0 ? Math.min(0, outstandingOwn) : Math.max(0, outstandingOwn)
  }
  return { totalOwn, customerShareOwn, hasDeduction, outstandingOwn, basis: asOfResult.basis }
}

interface SupplierAsOf {
  /** The invoice total, signed (negative on a credit note). */
  totalOwn: number
  totalAbs: number
  /** Outstanding on `asOf`, signed like the total. */
  outstandingOwn: number
  /** The as-of rule's magnitude, before the sign. */
  outstandingAbs: number
  basis: OutstandingAsOfBasis
}

/**
 * A supplier invoice's outstanding on `asOf`. The live outstanding is the
 * maintained remaining_amount, a magnitude like the payment rows. Unlike the
 * customer side, both credit paths apply a kreditfaktura there (Kreditera
 * zeroes the original, a migrated original carries the provider's netted
 * balance) and both leave the credit note itself at 0, so a credit is counted
 * once whichever path wrote it. A credit dated after `asOf` is not taken from
 * here: the as-of rule reopens its original in full.
 */
function supplierOutstandingAsOf(
  row: Record<string, unknown>,
  payments: PaymentsAsOf,
  asOf: string,
): SupplierAsOf {
  const sign = row.is_credit_note ? -1 : 1
  const totalAbs = Math.abs(Number(row.total ?? 0))
  const asOfResult = resolveOutstandingAsOf(
    { id: row.id as string, paid_at: (row.paid_at as string | null) ?? null },
    totalAbs,
    Number(row.remaining_amount ?? 0),
    payments,
    asOf,
  )
  return {
    totalOwn: totalAbs * sign,
    totalAbs,
    outstandingOwn: roundOre(asOfResult.outstanding * sign),
    outstandingAbs: asOfResult.outstanding,
    basis: asOfResult.basis,
  }
}

/** Ids per round trip for `.in()` reads (keeps the request URL bounded). */
const IN_CHUNK = 200

/**
 * Supplier invoice statuses the per-invoice cut-off reads: every state in
 * which the invoice can still be owed on period end. Only 'reversed' (the
 * registration was undone) is left out; a pg test pins this list against the
 * supplier_invoices status CHECK so a new status cannot be dropped silently.
 */
export const KONTANTMETOD_CARRY_SUPPLIER_STATUSES = [
  'registered',
  'approved',
  'overdue',
  'disputed',
  'partially_paid',
  'paid',
  'credited',
] as const

/** The statuses the legacy aggregate cut-off read, kept for legacy mode. */
const LEGACY_CUTOFF_SUPPLIER_STATUSES = ['registered', 'approved', 'partially_paid', 'paid', 'credited']

const CASH_ENTRY_SOURCE = {
  customer: 'invoice_cash_payment',
  supplier: 'supplier_invoice_cash_payment',
} as const

/** A live carry of this period: its verifikat and the invoice it carries. */
export interface LiveCarry {
  entryId: string
  reference: string
  /** A credit note's carry sits on the opposite side of 1510 / 2440. */
  creditNote?: boolean
}

export interface CollectKontantmetodCutoffOptions {
  /**
   * 'legacy': collect exactly as the legacy aggregate cut-off did (every
   * invoice, linked or not, no carries). 'per_invoice' (default): only
   * invoices not linked to any verifikat are carried.
   */
  mode?: 'per_invoice' | 'legacy'
  /**
   * The live carries of this period (invoice id -> carry verifikat id): the
   * resume case of paidBeforePosting, an invoice already carried whose
   * year-2 cash verifikat is still uncorrected.
   */
  liveCarries?: {
    customer: ReadonlyMap<string, LiveCarry>
    supplier: ReadonlyMap<string, LiveCarry>
  }
  /** Earlier year ends closed with a legacy cut-off (aggregate + vändning). */
  legacyCutoffs?: readonly LegacyCutoffRef[]
  /** Legacy-covered invoices the byrå has decided to carry anyway. */
  acknowledgedLegacyInvoiceIds?: readonly string[]
}

interface CarryCandidate {
  side: 'customer' | 'supplier'
  id: string
  reference: string
  invoiceDate: string
  creditedInvoiceId: string | null
  creditNote: boolean
  outstandingOwn: number
  /** Customer share (customer) or signed total (supplier). */
  fullOwn: number
  row: Record<string, unknown>
  /** See KontantmetodCarryDoc.deductionShare. */
  deductionShare?: boolean
}

/**
 * Fetch every invoice still outstanding at `periodEnd`.
 *
 * "Outstanding at period end" is deliberately payment-DATE based, not the
 * current remaining_amount: an invoice settled in January was still a
 * fordran on 31 December and must be part of the cut-off. Reading
 * remaining_amount would silently shrink the cut-off every day the user
 * delays running the bokslut.
 *
 * The date comes from the reskontra's own as-of rule (resolveOutstandingAsOf
 * in lib/reports/reskontra-payments.ts, behind the kund- and
 * leverantörsreskontra's backdated view): payment rows first, then paid_at,
 * and only when neither exists the invoice's live state. Today's settlement
 * paths all write a payment row, so the last rule reaches only history
 * settled outside them: above all invoices a provider migration imported
 * already paid (Fortnox sends no payment date), and settlements from before
 * the payment tables carried every one. Counting those as unpaid booked the
 * migrated history a second time as year-end fordringar (feedback seq
 * 798354); taking their state as it stands is an assumption, so each one is
 * listed in `undatedSettlements`.
 *
 * Per-invoice mode reads only invoices with no verifikat link: a linked
 * invoice already sits on 1510 / 2440 (carried by an earlier run, or booked
 * at issue before a switch to kontantmetoden), and carrying it would book it
 * a second time. That filter is also what makes a re-run incremental.
 */
export async function collectKontantmetodCutoff(
  supabase: SupabaseClient,
  companyId: string,
  periodStart: string,
  periodEnd: string,
  options: CollectKontantmetodCutoffOptions = {},
): Promise<CutoffCollection> {
  const perInvoice = (options.mode ?? 'per_invoice') === 'per_invoice'
  let invoices: Array<Record<string, unknown>>
  let supplierInvoices: Array<Record<string, unknown>>
  try {
    [invoices, supplierInvoices] = await Promise.all([
      fetchAllRows<Record<string, unknown>>(
        ({ from, to }) => {
          let query = supabase
            .from('invoices')
            .select('id, invoice_number, invoice_date, status, total, total_sek, vat_amount, vat_amount_sek, vat_treatment, delivery_country, credited_invoice_id, document_type, currency, exchange_rate, deduction_total, deduction_reclaimed_total, paid_amount, paid_at, journal_entry_id')
            .eq('company_id', companyId)
            .lte('invoice_date', periodEnd)
            // written_off: open on the day unless written off by then (below).
            .in('status', ['sent', 'overdue', 'partially_paid', 'paid', 'credited', 'written_off'])
          if (perInvoice) query = query.is('journal_entry_id', null)
          return query.order('id', { ascending: true }).range(from, to)
        },
        { dedupeBy: (row) => row.id as string },
      ),
      fetchAllRows<Record<string, unknown>>(
        ({ from, to }) => {
          // Per invoice, every supplier invoice still owed on period end is a
          // skuld (BFL 5 kap 2 §), whatever its workflow state: the nightly
          // update_overdue_supplier_invoices job turns an unpaid invoice past
          // its due date 'overdue', and a 'disputed' one stays owed until the
          // accountant decides otherwise (a carry is stornoed on its own
          // date). Legacy mode keeps the old list: a legacy cut-off is
          // judged against what it booked then, so its figures stay.
          let query = supabase
            .from('supplier_invoices')
            .select('id, supplier_invoice_number, arrival_number, invoice_date, status, total, total_sek, vat_amount, vat_amount_sek, reverse_charge, reverse_charge_kind, is_credit_note, credited_invoice_id, currency, exchange_rate, remaining_amount, paid_at, registration_journal_entry_id, supplier:suppliers(supplier_type), items:supplier_invoice_items(account_number, line_total, vat_rate, reverse_charge_rate)')
            .eq('company_id', companyId)
            .lte('invoice_date', periodEnd)
            .in('status', perInvoice ? [...KONTANTMETOD_CARRY_SUPPLIER_STATUSES] : LEGACY_CUTOFF_SUPPLIER_STATUSES)
          if (perInvoice) query = query.is('registration_journal_entry_id', null)
          return query.order('id', { ascending: true }).range(from, to)
        },
        { dedupeBy: (row) => row.id as string },
      ),
    ])
  } catch (err) {
    throw new Error(
      'Kontantmetodens bokslutsavgränsning kunde inte läsa reskontran: ' +
        (err instanceof Error ? err.message : 'okänt fel'),
    )
  }

  // A konstaterad kundförlust dated on or before period end took the claim
  // out of the fordringar; one dated later leaves it open on the day.
  if (invoices.some((row) => row.status === 'written_off')) {
    let writtenOff: Set<string>
    try {
      writtenOff = await invoicesWrittenOffAsOf(supabase, companyId, periodEnd)
    } catch (err) {
      throw new Error(
        'Kontantmetodens bokslutsavgränsning kunde inte läsa kundförlusterna: ' +
          (err instanceof Error ? err.message : 'okänt fel'),
      )
    }
    invoices = invoices.filter((row) => row.status !== 'written_off' || !writtenOff.has(row.id as string))
  }

  // Payments ON OR BEFORE period end reduce the outstanding balance; later
  // ones must not. Every row is read, including later ones: a row dated after
  // period end still proves the invoice was open on the day, which is what
  // tells it apart from one with no payment history at all. Amounts are in
  // the invoice's own currency.
  let invoicePayments: PaymentsAsOf
  let supplierPayments: PaymentsAsOf
  try {
    [invoicePayments, supplierPayments] = await Promise.all([
      fetchPaymentsAsOf(supabase, 'invoice_payments', 'invoice_id', companyId, periodEnd),
      fetchPaymentsAsOf(
        supabase,
        'supplier_invoice_payments',
        'supplier_invoice_id',
        companyId,
        periodEnd,
      ),
    ])
  } catch (err) {
    throw new Error(
      'Kontantmetodens bokslutsavgränsning kunde inte läsa betalningar: ' +
        (err instanceof Error ? err.message : 'okänt fel'),
    )
  }

  // A kreditfaktura dated after period end settled its original only then, so
  // on the day the original was still open. The live state below may already
  // carry that credit (Kreditera zeroes a supplier original's
  // remaining_amount, a migrated original holds the provider's netted
  // balance), which would otherwise read as a settlement at period end.
  try {
    const [customerCredited, supplierCredited] = await Promise.all([
      fetchCreditedAfter(supabase, 'invoices', companyId, periodEnd),
      fetchCreditedAfter(supabase, 'supplier_invoices', companyId, periodEnd),
    ])
    invoicePayments = { ...invoicePayments, creditedAfter: customerCredited }
    supplierPayments = { ...supplierPayments, creditedAfter: supplierCredited }
  } catch (err) {
    throw new Error(
      'Kontantmetodens bokslutsavgränsning kunde inte läsa kreditfakturor: ' +
        (err instanceof Error ? err.message : 'okänt fel'),
    )
  }

  const receivables: CutoffReceivable[] = []
  const unknownVatTreatment: string[] = []
  const strayVatOnZeroRate: string[] = []
  const undatedSettlements: string[] = []
  const rotPartialManual: string[] = []
  const rotPartialManualInvoices: RotPartialManualInvoice[] = []
  const candidates: CarryCandidate[] = []
  // Paid ROT/RUT invoices whose Skatteverket share may still be unbooked
  // (kontantmetodens two steps), for findDeductionShareCarries.
  const deductionShareRows: Array<{ row: Record<string, unknown>; reference: string; customerShareOwn: number }> = []
  for (const row of invoices) {
    // Credit notes reduce the receivable through their own negative totals;
    // they are already part of the invoice set, so no special casing beyond
    // skipping non-invoice document types (offers, delivery notes).
    const documentType = row.document_type as string | null
    if (documentType && documentType !== 'invoice') continue

    const total = resolveHeaderSek(row, 'total', 'total_sek')
    const vat = resolveHeaderSek(row, 'vat_amount', 'vat_amount_sek')
    const reference = (row.invoice_number as string) ?? ''
    const asOf = customerOutstandingAsOf(row, invoicePayments, periodEnd)
    const { totalOwn, customerShareOwn, hasDeduction, outstandingOwn } = asOf
    if (asOf.basis === 'assumed' && Math.abs(outstandingOwn - customerShareOwn) >= ORE_TOLERANCE) {
      undatedSettlements.push(reference || (row.id as string))
    }
    const outstanding = totalOwn === 0 ? 0 : roundOre(total * (outstandingOwn / totalOwn))
    if (Math.abs(outstanding) < ORE_TOLERANCE) {
      // The customer paid their share by period end; Skatteverket's may still
      // be a fordran kontantmetoden has not booked (findDeductionShareCarries).
      if (
        perInvoice &&
        hasDeduction &&
        totalOwn > 0 &&
        !row.credited_invoice_id &&
        row.status !== 'credited' &&
        row.status !== 'written_off' &&
        Math.abs(Number(row.deduction_reclaimed_total ?? 0)) < ORE_TOLERANCE
      ) {
        deductionShareRows.push({ row, reference, customerShareOwn })
      }
      continue
    }

    // Never guess the treatment. Defaulting a 12 %/6 %/undantagen invoice to
    // 25 % would route it to the wrong moms account AND the wrong revenue
    // account. Collect and refuse.
    const treatment = row.vat_treatment as VatTreatment | null
    if (!treatment) {
      unknownVatTreatment.push(reference || (row.id as string))
      continue
    }

    // Scale the moms share to the part still outstanding: a half-paid invoice
    // carries half its moms into the cut-off. The base is the CUSTOMER share:
    // under bokslutsmetoden the payment voucher credits the full invoice moms
    // when the customer pays their share (the 1513 leg carries no moms of its
    // own), so the moms still unreported follows the customer residual, and
    // an unpaid ROT/RUT invoice puts its whole moms into the final period.
    // On a plain invoice the customer share IS the total, so nothing moves.
    const ratio = customerShareOwn === 0 ? 0 : outstandingOwn / customerShareOwn
    const scaledVat = roundOre(vat * ratio)

    // Moms on a treatment that cannot carry Swedish output moms is a real
    // invoicing error. Surface it instead of quietly folding it into revenue:
    // the verifikat would balance and the mistake would disappear.
    if (!VILANDE_OUTPUT_VAT_ACCOUNTS[treatment] && Math.abs(scaledVat) >= ORE_TOLERANCE) {
      strayVatOnZeroRate.push(reference || (row.id as string))
      continue
    }
    receivables.push({
      id: row.id as string,
      reference,
      vatTreatment: treatment,
      goodsDeliveryCountry: (row.delivery_country as string | null) ?? null,
      outstanding,
      vat: scaledVat,
    })

    if (!perInvoice) continue
    // ROT/RUT with anything settled on period end, or a deduction
    // Skatteverket refused and that was booked back onto the customer: the
    // year-1 payment voucher already booked the moms and the 1513 share of
    // what was paid, and no rule splits the remainder. Manual.
    const reclaimed = Math.abs(Number(row.deduction_reclaimed_total ?? 0))
    if (hasDeduction && (Math.abs(outstandingOwn - customerShareOwn) >= ORE_TOLERANCE || reclaimed > 0)) {
      rotPartialManual.push(reference || (row.id as string))
      rotPartialManualInvoices.push(
        rotPartialManualInvoice(row, reference, totalOwn, outstandingOwn, customerShareOwn, reclaimed, scaledVat),
      )
      continue
    }
    // Paid beyond its share on period end: a credit balance owed back to
    // the customer, not a fordran. Nothing to carry.
    if (Math.sign(outstandingOwn) !== Math.sign(customerShareOwn)) {
      log.warn('overpaid customer invoice on period end left out of the carry', {
        companyId,
        invoiceId: row.id,
      })
      continue
    }
    candidates.push({
      side: 'customer',
      id: row.id as string,
      reference: reference || `utkast ${String(row.id).slice(0, 8)}`,
      invoiceDate: row.invoice_date as string,
      creditedInvoiceId: (row.credited_invoice_id as string | null) ?? null,
      creditNote: totalOwn < 0 || Boolean(row.credited_invoice_id),
      outstandingOwn,
      fullOwn: customerShareOwn,
      row,
    })
  }

  const payables: CutoffPayable[] = []
  // The company's momskoder, read once and only if a reverse-charge invoice
  // is still open: an item on an account that reports ruta 20-24 itself
  // takes no basis pair and that account's momssats (reverseChargeOnAccount,
  // crm#1096).
  const loadChart = chartVatTreatmentsLoader(supabase, companyId)
  for (const row of supplierInvoices) {
    const sign = row.is_credit_note ? -1 : 1
    const total = Math.abs(resolveHeaderSek(row, 'total', 'total_sek')) * sign
    const vat = Math.abs(resolveHeaderSek(row, 'vat_amount', 'vat_amount_sek')) * sign
    const reference = (row.supplier_invoice_number as string) ?? ''
    const asOf = supplierOutstandingAsOf(row, supplierPayments, periodEnd)
    const { totalOwn, outstandingOwn } = asOf
    if (asOf.basis === 'assumed' && Math.abs(asOf.outstandingAbs - asOf.totalAbs) >= ORE_TOLERANCE) {
      undatedSettlements.push(reference || (row.id as string))
    }
    const outstanding = totalOwn === 0 ? 0 : roundOre(total * (outstandingOwn / totalOwn))
    if (Math.abs(outstanding) < ORE_TOLERANCE) continue

    const ratio = totalOwn === 0 ? 0 : outstandingOwn / totalOwn
    const items = (row.items ?? []) as Array<Record<string, unknown>>
    const supplierValue = Array.isArray(row.supplier) ? row.supplier[0] : row.supplier
    const supplierType = (supplierValue as Record<string, unknown> | null)?.supplier_type
    let reverseChargeGroups: CutoffPayable['reverseChargeGroups']
    if (row.reverse_charge) {
      if (!['eu_business', 'non_eu_business', 'swedish_business'].includes(String(supplierType))) {
        throw new Error(
          `Leverantörsfaktura ${String(row.supplier_invoice_number ?? row.id)} med omvänd skattskyldighet saknar giltig leverantörstyp`,
        )
      }
      const groups = new Map<number, { base: number; nonBasisBase: number }>()
      const chart = await loadChart()
      for (const item of items) {
        const { rate, basisPair } = reverseChargeOnAccount(
          String(item.account_number ?? ''),
          resolveReverseChargeRate({
            vat_rate: item.vat_rate == null ? null : Number(item.vat_rate),
            reverse_charge_rate: item.reverse_charge_rate == null
              ? null
              : Number(item.reverse_charge_rate),
          }),
          chart,
        )
        const itemBase = totalOwn === 0
          ? 0
          : roundOre(Math.abs(Number(item.line_total ?? 0)) * Math.abs(total / totalOwn) * ratio)
        const current = groups.get(rate) ?? { base: 0, nonBasisBase: 0 }
        current.base = roundOre(current.base + itemBase)
        if (basisPair) current.nonBasisBase = roundOre(current.nonBasisBase + itemBase)
        groups.set(rate, current)
      }
      reverseChargeGroups = [...groups.entries()].map(([rate, group]) => ({
        rate,
        base: group.base * sign,
        nonBasisBase: group.nonBasisBase * sign,
        kind: supplierInvoiceReverseChargeKind(
          supplierType as 'eu_business' | 'non_eu_business' | 'swedish_business',
          row.reverse_charge_kind as string | null | undefined,
        ),
      }))
    }
    payables.push({
      id: row.id as string,
      reference,
      outstanding,
      vat: roundOre(vat * ratio),
      reverseCharge: Boolean(row.reverse_charge),
      reverseChargeGroups,
      netByAccount: items
        .filter((item) => item.account_number)
        .map((item) => ({
          account: item.account_number as string,
          amount: Math.abs(Number(item.line_total ?? 0)),
        })),
    })

    if (!perInvoice) continue
    candidates.push({
      side: 'supplier',
      id: row.id as string,
      reference: reference || `ankomstnr ${String(row.arrival_number ?? row.id)}`,
      invoiceDate: row.invoice_date as string,
      creditedInvoiceId: (row.credited_invoice_id as string | null) ?? null,
      creditNote: Boolean(row.is_credit_note),
      outstandingOwn,
      fullOwn: totalOwn,
      row,
    })
  }

  // A kreditfaktura and the invoice it credits that are both still unlinked
  // and together net to nothing on period end are not carried: the pair is
  // no fordran or skuld, and carrying both would book the sale and its
  // reversal in the closed year for no balance.
  const nettedIds = nettedCreditPairs(candidates)
  let carryCandidates = candidates.filter((c) => !nettedIds.has(`${c.side}:${c.id}`))

  // Legacy-covered: an earlier legacy cut-off already took these into a
  // momsdeklaration (with a vändning the VAT functions excluded). Withheld
  // unless acknowledged.
  let legacyCovered: LegacyCoveredInvoice[] = []
  if (perInvoice && (options.legacyCutoffs?.length ?? 0) > 0 && carryCandidates.length > 0) {
    const covered = await findLegacyCovered(
      supabase,
      companyId,
      carryCandidates,
      options.legacyCutoffs ?? [],
    )
    const acknowledged = new Set(options.acknowledgedLegacyInvoiceIds ?? [])
    legacyCovered = covered.filter((c) => !acknowledged.has(c.invoiceId))
    const withheld = new Set(legacyCovered.map((c) => `${c.side}:${c.invoiceId}`))
    carryCandidates = carryCandidates.filter((c) => !withheld.has(`${c.side}:${c.id}`))
  }

  let deductionShareCandidates: CarryCandidate[] = []
  if (perInvoice && deductionShareRows.length > 0) {
    const found = await findDeductionShareCarries(supabase, companyId, periodStart, periodEnd, deductionShareRows)
    deductionShareCandidates = found.carries
    for (const manual of found.manual) {
      rotPartialManual.push(manual.reference)
      rotPartialManualInvoices.push(manual)
    }
  }

  const carries = perInvoice
    ? await loadCarryDocs(supabase, companyId, [...carryCandidates, ...deductionShareCandidates])
    : []

  let paidBeforePosting: PaidBeforePosting[] = []
  let paidBeforePostingManual: PaidBeforePostingManual[] = []
  if (perInvoice) {
    ;({ paidBeforePosting, paidBeforePostingManual } = await findPaidBeforePosting(
      supabase,
      companyId,
      periodEnd,
      carryCandidates,
      options.liveCarries,
    ))
  }

  log.info('collected kontantmetoden cut-off', {
    companyId,
    periodStart,
    periodEnd,
    mode: perInvoice ? 'per_invoice' : 'legacy',
    receivables: receivables.length,
    payables: payables.length,
    carries: carries.length,
    paidBeforePosting: paidBeforePosting.length,
    manual: paidBeforePostingManual.length + rotPartialManual.length,
    legacyCovered: legacyCovered.length,
    undatedSettlements: undatedSettlements.length,
  })

  if (unknownVatTreatment.length > 0) {
    log.warn('invoices without vat_treatment excluded from the cut-off', {
      companyId,
      count: unknownVatTreatment.length,
    })
  }
  if (strayVatOnZeroRate.length > 0) {
    log.warn('invoices with moms on a zero-rate treatment excluded from the cut-off', {
      companyId,
      count: strayVatOnZeroRate.length,
    })
  }

  return {
    receivables,
    payables,
    unknownVatTreatment,
    strayVatOnZeroRate,
    undatedSettlements,
    carries,
    rotPartialManual,
    rotPartialManualInvoices,
    paidBeforePosting,
    paidBeforePostingManual,
    legacyCovered,
  }
}

/**
 * Kontantmetodens two steps at the year end (BFL 5 kap 2 §; ML 2023:200
 * 7 kap. 16 §: moms on fordringar unpaid at the beskattningsår's end belongs
 * to its last period). A ROT/RUT invoice the customer paid in the year under
 * the two steps booked only the customer's share (buildInvoiceCashLines with
 * deferDeductionShare); Skatteverket's share is booked by its payout. When
 * the payout had not come by period end, that share was a fordran on the day
 * and is carried here, on 1513 with its revenue and moms
 * (buildDeductionCarryLines), linked to the invoice so the year-2 payout
 * clears 1513 like any fakturamodellen claim (rot-rut-payout-recognition
 * reads the link).
 *
 * The same positive evidence as the payout's: live kontantmetod payment
 * verifikat dated in the period, none of them with a 1513 line (one booked
 * before the two steps already holds the share on 1513). Then by the
 * invoice's begäran settled in the period:
 *   - none: the whole share is carried;
 *   - paid in full: the payout booked it, nothing to carry;
 *   - paid in part: the refused rest is the customer's now, a kundfordran on
 *     the day with its revenue and moms: listed for a manual carry
 *     (rotPartialManual) with that rest as the open customer share.
 */
async function findDeductionShareCarries(
  supabase: SupabaseClient,
  companyId: string,
  periodStart: string,
  periodEnd: string,
  rows: Array<{ row: Record<string, unknown>; reference: string; customerShareOwn: number }>,
): Promise<{ carries: CarryCandidate[]; manual: RotPartialManualInvoice[] }> {
  const fail = (what: string, message: string): never => {
    throw new Error(`Kontantmetodens bokslutsavgränsning kunde inte läsa ${what}: ${message}`)
  }
  const ids = rows.map(({ row }) => row.id as string)
  const vouchersByInvoice = new Map<string, string[]>()
  type ItemRow = {
    invoice_id: string
    requested_amount: number | string
    decided_amount: number | string | null
    request: { status: string; decided_total: number | string | null; settlement_journal_entry_id: string | null } | null
  }
  const itemsByInvoice = new Map<string, ItemRow[]>()
  for (const chunk of chunked(ids, IN_CHUNK)) {
    const [payments, items] = await Promise.all([
      supabase
        .from('invoice_payments')
        .select('invoice_id, journal_entry_id')
        .in('invoice_id', chunk)
        .not('journal_entry_id', 'is', null),
      supabase
        .from('rot_rut_payout_request_items')
        .select('invoice_id, requested_amount, decided_amount, request:rot_rut_payout_requests(status, decided_total, settlement_journal_entry_id)')
        .in('invoice_id', chunk),
    ])
    if (payments.error) fail('betalningarna', payments.error.message)
    if (items.error) fail('begäran om utbetalning', items.error.message)
    for (const payment of (payments.data ?? []) as Array<{ invoice_id: string; journal_entry_id: string }>) {
      vouchersByInvoice.set(payment.invoice_id, [...(vouchersByInvoice.get(payment.invoice_id) ?? []), payment.journal_entry_id])
    }
    for (const raw of (items.data ?? []) as Array<Record<string, unknown>>) {
      const request = Array.isArray(raw.request) ? raw.request[0] : raw.request
      const item = { ...raw, request: (request ?? null) } as ItemRow
      itemsByInvoice.set(item.invoice_id, [...(itemsByInvoice.get(item.invoice_id) ?? []), item])
    }
  }

  const settlementIds = [...itemsByInvoice.values()]
    .flat()
    .map((item) => item.request?.settlement_journal_entry_id)
    .filter((id): id is string => !!id)
  const entryIds = [...new Set([...[...vouchersByInvoice.values()].flat(), ...settlementIds])]
  const live = new Map<string, { source_type: string | null; entry_date: string }>()
  const with1513 = new Set<string>()
  for (const chunk of chunked(entryIds, IN_CHUNK)) {
    const { data, error } = await supabase
      .from('journal_entries')
      .select('id, status, reversed_by_id, source_type, entry_date')
      .eq('company_id', companyId)
      .in('id', chunk)
    if (error) fail('verifikaten', error.message)
    for (const entry of (data ?? []) as Array<{ id: string; status: string; reversed_by_id: string | null; source_type: string | null; entry_date: string }>) {
      if (entry.status === 'posted' && !entry.reversed_by_id) live.set(entry.id, entry)
    }
  }
  const paymentIds = [...new Set([...vouchersByInvoice.values()].flat())].filter((id) => live.has(id))
  for (const chunk of chunked(paymentIds, IN_CHUNK)) {
    const { data, error } = await supabase
      .from('journal_entry_lines')
      .select('journal_entry_id')
      .in('journal_entry_id', chunk)
      .eq('account_number', ROT_RUT_RECEIVABLE_ACCOUNT)
    if (error) fail('verifikatraderna', error.message)
    for (const line of (data ?? []) as Array<{ journal_entry_id: string }>) with1513.add(line.journal_entry_id)
  }

  const inPeriod = (date: string) => date >= periodStart && date <= periodEnd
  const carries: CarryCandidate[] = []
  const manual: RotPartialManualInvoice[] = []
  for (const { row, reference, customerShareOwn } of rows) {
    const id = row.id as string
    const own = (vouchersByInvoice.get(id) ?? []).filter((voucherId) => live.has(voucherId))
    if (!own.some((voucherId) => live.get(voucherId)!.source_type === CASH_ENTRY_SOURCE.customer)) continue
    if (own.some((voucherId) => with1513.has(voucherId) || !inPeriod(live.get(voucherId)!.entry_date))) continue

    const items = itemsByInvoice.get(id) ?? []
    const settled = items.filter((item) => {
      const voucherId = item.request?.settlement_journal_entry_id
      if (!voucherId || ['cancelled', 'rejected'].includes(item.request?.status ?? '')) return false
      const voucher = live.get(voucherId)
      return !!voucher && inPeriod(voucher.entry_date)
    })
    if (settled.length === 0) {
      carries.push({
        side: 'customer',
        id,
        reference: reference || `utkast ${id.slice(0, 8)}`,
        invoiceDate: row.invoice_date as string,
        creditedInvoiceId: null,
        creditNote: false,
        outstandingOwn: 0,
        fullOwn: customerShareOwn,
        row,
        deductionShare: true,
      })
      continue
    }
    if (settled.every((item) => item.request?.status === 'paid')) continue

    // Paid in part in the period: the refused rest is the customer's.
    const paid = settled.reduce<number | null>((sum, item) => {
      if (sum === null) return null
      const amount = item.decided_amount ?? (items.length === 1 ? item.request?.decided_total : null)
      return amount == null ? null : roundOre(sum + Number(amount))
    }, 0)
    const deduction = Math.abs(Number(row.deduction_total ?? 0))
    manual.push({
      invoiceId: id,
      reference: reference || id,
      creditNote: false,
      openCustomerShareSek: paid === null ? null : roundOre(Math.max(0, deduction - paid)),
      openDeductionSek: 0,
      openPartHasVat: Math.abs(Number(row.vat_amount ?? 0)) >= ORE_TOLERANCE,
    })
  }
  return { carries, manual }
}

/**
 * What a manual carry of a ROT/RUT invoice is checked against: the open
 * customer share (what goes on 151x), Skatteverket's share of the open part
 * only (exactly what goes on 1513), both at the invoice's own rate, and
 * whether the open part carries moms.
 */
function rotPartialManualInvoice(
  row: Record<string, unknown>,
  reference: string,
  totalOwn: number,
  outstandingOwn: number,
  customerShareOwn: number,
  reclaimed: number,
  openVatSek: number,
): RotPartialManualInvoice {
  const currency = (row.currency as string | null) ?? 'SEK'
  const rate = row.exchange_rate == null ? null : Number(row.exchange_rate)
  const toSek = (amount: number): number | null => {
    try {
      return roundOre(Math.abs(headerToSekOrThrow(Math.abs(amount), null, currency, rate)))
    } catch {
      return null
    }
  }
  const openRatio = customerShareOwn === 0
    ? 0
    : Math.min(1, Math.abs(outstandingOwn) / Math.abs(customerShareOwn))
  const deductionLeft = Math.max(0, Math.abs(Number(row.deduction_total ?? 0)) - reclaimed)
  return {
    invoiceId: row.id as string,
    reference: reference || (row.id as string),
    creditNote: totalOwn < 0 || Boolean(row.credited_invoice_id),
    openCustomerShareSek: toSek(outstandingOwn),
    openDeductionSek: toSek(roundOre(deductionLeft * openRatio)) ?? 0,
    openPartHasVat: Math.abs(openVatSek) >= ORE_TOLERANCE,
  }
}

/** Keys (`side:id`) of credit notes and originals that net to nothing. */
function nettedCreditPairs(candidates: CarryCandidate[]): Set<string> {
  const byKey = new Map(candidates.map((c) => [`${c.side}:${c.id}`, c]))
  const creditsByOriginal = new Map<string, CarryCandidate[]>()
  for (const c of candidates) {
    if (!c.creditNote || !c.creditedInvoiceId) continue
    const key = `${c.side}:${c.creditedInvoiceId}`
    if (!byKey.has(key)) continue
    creditsByOriginal.set(key, [...(creditsByOriginal.get(key) ?? []), c])
  }
  const netted = new Set<string>()
  for (const [originalKey, credits] of creditsByOriginal) {
    const original = byKey.get(originalKey)!
    const net = roundOre(original.outstandingOwn + credits.reduce((s, c) => s + c.outstandingOwn, 0))
    if (Math.abs(net) < ORE_TOLERANCE) {
      netted.add(originalKey)
      for (const c of credits) netted.add(`${c.side}:${c.id}`)
    }
  }
  return netted
}

/**
 * The candidates an earlier legacy cut-off covered: dated on or before that
 * period's end and outstanding on it, by the same as-of rule.
 */
async function findLegacyCovered(
  supabase: SupabaseClient,
  companyId: string,
  candidates: CarryCandidate[],
  legacyCutoffs: readonly LegacyCutoffRef[],
): Promise<LegacyCoveredInvoice[]> {
  const covered = new Map<string, LegacyCoveredInvoice>()
  const ordered = [...legacyCutoffs].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd))
  for (const cutoff of ordered) {
    for (const side of ['customer', 'supplier'] as const) {
      if (side === 'customer' ? !cutoff.receivable : !cutoff.payable) continue
      const affected = candidates.filter(
        (c) => c.side === side && c.invoiceDate <= cutoff.periodEnd && !covered.has(`${side}:${c.id}`),
      )
      if (affected.length === 0) continue
      let payments: PaymentsAsOf
      try {
        const [rows, creditedAfter] = await Promise.all([
          side === 'customer'
            ? fetchPaymentsAsOf(supabase, 'invoice_payments', 'invoice_id', companyId, cutoff.periodEnd)
            : fetchPaymentsAsOf(
                supabase,
                'supplier_invoice_payments',
                'supplier_invoice_id',
                companyId,
                cutoff.periodEnd,
              ),
          fetchCreditedAfter(
            supabase,
            side === 'customer' ? 'invoices' : 'supplier_invoices',
            companyId,
            cutoff.periodEnd,
          ),
        ])
        payments = { ...rows, creditedAfter }
      } catch (err) {
        throw new Error(
          'Kontantmetodens bokslutsavgränsning kunde inte läsa en tidigare avgränsnings betalningar: ' +
            (err instanceof Error ? err.message : 'okänt fel'),
        )
      }
      for (const c of affected) {
        const open = side === 'customer'
          ? customerOutstandingAsOf(c.row, payments, cutoff.periodEnd).outstandingOwn
          : supplierOutstandingAsOf(c.row, payments, cutoff.periodEnd).outstandingOwn
        if (Math.abs(open) >= ORE_TOLERANCE) {
          covered.set(`${side}:${c.id}`, {
            side,
            invoiceId: c.id,
            reference: c.reference,
            legacyPeriodEnd: cutoff.periodEnd,
          })
        }
      }
    }
  }
  return [...covered.values()]
}

/** Read the full invoice rows (with items) the carry builders need. */
async function loadCarryDocs(
  supabase: SupabaseClient,
  companyId: string,
  candidates: CarryCandidate[],
): Promise<KontantmetodCarryDoc[]> {
  const customerIds = candidates.filter((c) => c.side === 'customer').map((c) => c.id)
  const supplierIds = candidates.filter((c) => c.side === 'supplier').map((c) => c.id)
  const customerRows = new Map<string, Record<string, unknown>>()
  const supplierRows = new Map<string, Record<string, unknown>>()
  for (const ids of chunked(customerIds, IN_CHUNK)) {
    const { data, error } = await supabase
      .from('invoices')
      .select('*, items:invoice_items(*)')
      .eq('company_id', companyId)
      .in('id', ids)
    if (error) {
      throw new Error(`Kontantmetodens bokslutsavgränsning kunde inte läsa fakturorna: ${error.message}`)
    }
    for (const row of (data ?? []) as Array<Record<string, unknown>>) customerRows.set(row.id as string, row)
  }
  for (const ids of chunked(supplierIds, IN_CHUNK)) {
    const { data, error } = await supabase
      .from('supplier_invoices')
      .select('*, items:supplier_invoice_items(*), supplier:suppliers(id, name, supplier_type)')
      .eq('company_id', companyId)
      .in('id', ids)
    if (error) {
      throw new Error(`Kontantmetodens bokslutsavgränsning kunde inte läsa leverantörsfakturorna: ${error.message}`)
    }
    for (const row of (data ?? []) as Array<Record<string, unknown>>) supplierRows.set(row.id as string, row)
  }

  const bySortOrder = <T extends { sort_order?: number | null }>(items: T[]): T[] =>
    [...items].sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0))
  // The company's momskoder, read once and only for a reverse-charge invoice.
  const loadChart = chartVatTreatmentsLoader(supabase, companyId)

  const docs: KontantmetodCarryDoc[] = []
  for (const c of candidates) {
    if (c.side === 'customer') {
      const row = customerRows.get(c.id)
      if (!row) throw new Error(`Faktura ${c.reference} kunde inte läsas för årsomföringen`)
      const items = Array.isArray(row.items) ? bySortOrder(row.items as InvoiceItem[]) : undefined
      docs.push({
        side: 'customer',
        invoice: { ...(row as unknown as CustomerCarrySource), items },
        reference: c.reference,
        creditNote: c.creditNote,
        outstandingOwn: c.outstandingOwn,
        customerShareOwn: c.fullOwn,
        ...(c.deductionShare ? { deductionShare: true } : {}),
      })
    } else {
      const row = supplierRows.get(c.id)
      if (!row) throw new Error(`Leverantörsfaktura ${c.reference} kunde inte läsas för årsomföringen`)
      const supplierValue = Array.isArray(row.supplier) ? row.supplier[0] : row.supplier
      const items = Array.isArray(row.items) ? bySortOrder(row.items as SupplierInvoiceItem[]) : []
      const invoice = row as unknown as SupplierInvoice
      const supplierType = String((supplierValue as Record<string, unknown> | null)?.supplier_type ?? '')
      docs.push({
        side: 'supplier',
        invoice,
        items,
        supplierType,
        chart: isSupplierInvoiceReverseCharge(invoice, supplierType) ? await loadChart() : undefined,
        reference: c.reference,
        creditNote: c.creditNote,
        outstandingOwn: c.outstandingOwn,
        totalOwn: c.fullOwn,
      })
    }
  }
  return docs
}

interface PaymentRowAfter {
  id: string
  invoiceId: string
  journalEntryId: string | null
  amount: number
}

/**
 * Invoices open on period end that were paid after it through a verifikat
 * that booked revenue or cost and moms at payment: the unlinked candidates
 * about to be carried, and the invoices already carried (the resume case).
 */
async function findPaidBeforePosting(
  supabase: SupabaseClient,
  companyId: string,
  periodEnd: string,
  candidates: CarryCandidate[],
  liveCarries: CollectKontantmetodCutoffOptions['liveCarries'],
): Promise<{ paidBeforePosting: PaidBeforePosting[]; paidBeforePostingManual: PaidBeforePostingManual[] }> {
  type Target = {
    side: 'customer' | 'supplier'
    reference: string
    carryEntryId: string | null
    creditNote: boolean
  }
  const targets = new Map<string, Target>()
  for (const c of candidates) {
    targets.set(`${c.side}:${c.id}`, {
      side: c.side,
      reference: c.reference,
      carryEntryId: null,
      creditNote: c.creditNote,
    })
  }
  const noCarries = new Map<string, LiveCarry>()
  for (const [id, carry] of liveCarries?.customer ?? noCarries) {
    targets.set(`customer:${id}`, {
      side: 'customer',
      reference: carry.reference,
      carryEntryId: carry.entryId,
      creditNote: carry.creditNote ?? false,
    })
  }
  for (const [id, carry] of liveCarries?.supplier ?? noCarries) {
    targets.set(`supplier:${id}`, {
      side: 'supplier',
      reference: carry.reference,
      carryEntryId: carry.entryId,
      creditNote: carry.creditNote ?? false,
    })
  }
  if (targets.size === 0) return { paidBeforePosting: [], paidBeforePostingManual: [] }

  let customerRows: PaymentRowAfter[]
  let supplierRows: PaymentRowAfter[]
  try {
    const [customer, supplier] = await Promise.all([
      fetchAllRows<Record<string, unknown>>(({ from, to }) =>
        supabase
          .from('invoice_payments')
          .select('id, invoice_id, journal_entry_id, payment_date, amount')
          .eq('company_id', companyId)
          .gt('payment_date', periodEnd)
          .order('id', { ascending: true })
          .range(from, to),
      ),
      fetchAllRows<Record<string, unknown>>(({ from, to }) =>
        supabase
          .from('supplier_invoice_payments')
          .select('id, supplier_invoice_id, journal_entry_id, payment_date, amount')
          .eq('company_id', companyId)
          .gt('payment_date', periodEnd)
          .order('id', { ascending: true })
          .range(from, to),
      ),
    ])
    customerRows = customer.map((r) => ({
      id: r.id as string,
      invoiceId: r.invoice_id as string,
      journalEntryId: (r.journal_entry_id as string | null) ?? null,
      amount: Math.abs(Number(r.amount ?? 0)),
    }))
    supplierRows = supplier.map((r) => ({
      id: r.id as string,
      invoiceId: r.supplier_invoice_id as string,
      journalEntryId: (r.journal_entry_id as string | null) ?? null,
      amount: Math.abs(Number(r.amount ?? 0)),
    }))
  } catch (err) {
    throw new Error(
      'Kontantmetodens bokslutsavgränsning kunde inte läsa betalningar efter periodens slut: ' +
        (err instanceof Error ? err.message : 'okänt fel'),
    )
  }

  const relevant = [
    ...customerRows.map((r) => ({ ...r, side: 'customer' as const })),
    ...supplierRows.map((r) => ({ ...r, side: 'supplier' as const })),
  ].filter((r) => targets.has(`${r.side}:${r.invoiceId}`))
  if (relevant.length === 0) return { paidBeforePosting: [], paidBeforePostingManual: [] }

  const entryIds = [...new Set(relevant.map((r) => r.journalEntryId).filter((id): id is string => !!id))]
  const entries = new Map<string, {
    status: string
    source_type: string | null
    source_id: string | null
    entry_date: string
    lines: CarryClearingLine[]
  }>()
  const rowsPerEntry = new Map<string, number>()
  for (const ids of chunked(entryIds, IN_CHUNK)) {
    const [entryRead, customerLinks, supplierLinks] = await Promise.all([
      supabase
        .from('journal_entries')
        .select('id, status, source_type, source_id, entry_date, lines:journal_entry_lines(account_number, debit_amount, credit_amount)')
        .eq('company_id', companyId)
        .in('id', ids),
      supabase
        .from('invoice_payments')
        .select('id, journal_entry_id')
        .eq('company_id', companyId)
        .in('journal_entry_id', ids),
      supabase
        .from('supplier_invoice_payments')
        .select('id, journal_entry_id')
        .eq('company_id', companyId)
        .in('journal_entry_id', ids),
    ])
    const failed = entryRead.error ?? customerLinks.error ?? supplierLinks.error
    if (failed) {
      throw new Error(
        `Kontantmetodens bokslutsavgränsning kunde inte läsa betalningsverifikat: ${failed.message}`,
      )
    }
    for (const e of (entryRead.data ?? []) as Array<Record<string, unknown>>) {
      entries.set(e.id as string, {
        status: e.status as string,
        source_type: (e.source_type as string | null) ?? null,
        source_id: (e.source_id as string | null) ?? null,
        entry_date: e.entry_date as string,
        lines: (Array.isArray(e.lines) ? e.lines : []) as CarryClearingLine[],
      })
    }
    for (const link of [
      ...((customerLinks.data ?? []) as Array<Record<string, unknown>>),
      ...((supplierLinks.data ?? []) as Array<Record<string, unknown>>),
    ]) {
      const id = link.journal_entry_id as string
      rowsPerEntry.set(id, (rowsPerEntry.get(id) ?? 0) + 1)
    }
  }

  const paidBeforePosting: PaidBeforePosting[] = []
  const paidBeforePostingManual: PaidBeforePostingManual[] = []
  for (const row of relevant) {
    const target = targets.get(`${row.side}:${row.invoiceId}`)!
    const base = { side: row.side, invoiceId: row.invoiceId, reference: target.reference, paymentRowId: row.id }
    if (!row.journalEntryId) {
      // No verifikat behind the payment: nothing clears the 1510 / 2440 the
      // carry books, whether the invoice is about to be carried or already
      // is (a door whose bookkeeping failed after the row was written).
      // Listed until the payment is booked as a clearing.
      paidBeforePostingManual.push({ ...base, entryId: null, entryDate: null, reason: 'no_verifikat' })
      continue
    }
    const entry = entries.get(row.journalEntryId)
    // Reversed or corrected already (correctEntry marks it reversed), or not
    // visible: nothing left to correct.
    if (!entry || entry.status !== 'posted') continue
    const generatedCash =
      entry.source_type === CASH_ENTRY_SOURCE[row.side] && entry.source_id === row.invoiceId
    if (!generatedCash) {
      // Judged by its lines, never by its source_type: a manual, SIE or bank
      // verifikat linked to the invoice is the intended shape only when it
      // clears the receivable or payable the carry books and books nothing
      // else (no revenue or cost, no moms). One that books Dr 1930 / Cr 3001
      // / Cr 2611 declares the moms again in year 2 and stays listed until
      // it is stornoed or corrected.
      if (isCarryClearingVerifikat(row.side, target.creditNote, entry.lines)) continue
      paidBeforePostingManual.push({
        ...base,
        entryId: row.journalEntryId,
        entryDate: entry.entry_date,
        reason: 'not_generated_cash_entry',
      })
      continue
    }
    if ((rowsPerEntry.get(row.journalEntryId) ?? 0) !== 1) {
      paidBeforePostingManual.push({
        ...base,
        entryId: row.journalEntryId,
        entryDate: entry.entry_date,
        reason: 'shared_verifikat',
      })
      continue
    }
    paidBeforePosting.push({
      ...base,
      entryId: row.journalEntryId,
      entryDate: entry.entry_date,
      paymentAmount: row.amount,
      carryEntryId: target.carryEntryId,
    })
  }
  return { paidBeforePosting, paidBeforePostingManual }
}

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

interface MarkerRow {
  kind: KontantmetodCutoffKind
  fiscal_period_id: string
  invoice_id: string | null
  supplier_invoice_id: string | null
  journal_entry_id: string
  entry: { id: string; entry_date: string; status: string } | Array<{
    id: string
    entry_date: string
    status: string
  }> | null
}

function markerEntry(row: MarkerRow): { id: string; entry_date: string; status: string } | null {
  const entry = Array.isArray(row.entry) ? row.entry[0] : row.entry
  return entry ?? null
}

/**
 * Assess the cut-off of one closing period: what is left to carry, what is
 * left to correct, what needs a person, and whether it is complete.
 *
 * A period that already holds a posted legacy cut-off (aggregate verifikat
 * with vändning) is judged by the legacy inspector exactly as before, and
 * nothing new is posted into it. Every other period is per invoice: the
 * collection's carries become one plan each.
 */
export async function assessKontantmetodCutoff(
  supabase: SupabaseClient,
  companyId: string,
  period: { id: string; period_start: string; period_end: string },
  nextFiscalPeriodId: string | null,
  entityType: EntityType,
  options: { acknowledgedLegacyInvoiceIds?: readonly string[] } = {},
): Promise<KontantmetodCutoffAssessment> {
  let markers: MarkerRow[]
  try {
    const rows = await fetchAllRows<Record<string, unknown>>(({ from, to }) =>
      supabase
        .from('kontantmetod_cutoff_entries')
        .select('id, kind, fiscal_period_id, invoice_id, supplier_invoice_id, journal_entry_id, entry:journal_entries!inner(id, entry_date, status)')
        .eq('company_id', companyId)
        .order('id', { ascending: true })
        .range(from, to),
    )
    markers = rows as unknown as MarkerRow[]
  } catch (err) {
    throw new Error(
      'Kontantmetodens bokslutsavgränsning kunde inte kontrolleras: ' +
        (err instanceof Error ? err.message : 'okänt fel'),
    )
  }

  const isLegacyAggregate = (row: MarkerRow) =>
    (row.kind === 'receivable' || row.kind === 'payable') && markerEntry(row)?.status === 'posted'

  // Earlier year ends closed with a legacy cut-off: the aggregate verifikat
  // is dated on that period's end.
  const legacyByPeriod = new Map<string, LegacyCutoffRef>()
  for (const row of markers) {
    if (!isLegacyAggregate(row) || row.fiscal_period_id === period.id) continue
    const entryDate = markerEntry(row)!.entry_date
    if (entryDate >= period.period_start) continue
    const ref = legacyByPeriod.get(row.fiscal_period_id) ?? {
      fiscalPeriodId: row.fiscal_period_id,
      periodEnd: entryDate,
      receivable: false,
      payable: false,
    }
    if (row.kind === 'receivable') ref.receivable = true
    else ref.payable = true
    legacyByPeriod.set(row.fiscal_period_id, ref)
  }
  const legacyCutoffs = [...legacyByPeriod.values()].sort((a, b) =>
    a.periodEnd.localeCompare(b.periodEnd),
  )

  const legacyMode = markers.some((row) => row.fiscal_period_id === period.id && isLegacyAggregate(row))
  if (legacyMode) {
    const collection = sortedCutoffCollection(await collectKontantmetodCutoff(
      supabase,
      companyId,
      period.period_start,
      period.period_end,
      { mode: 'legacy' },
    ))
    const lines = buildCutoffLines(collection.receivables, collection.payables, entityType)
    const postings = await inspectKontantmetodCutoffPostings(
      supabase,
      companyId,
      period.id,
      nextFiscalPeriodId ?? '',
      period.period_end,
      lines,
    )
    return {
      mode: 'legacy',
      collection,
      plans: [],
      lines,
      postings,
      complete:
        postings.complete &&
        collection.unknownVatTreatment.length === 0 &&
        collection.strayVatOnZeroRate.length === 0,
      legacyCutoffs,
    }
  }

  // Live carries of this period: posted, and the invoice link still points
  // at the carry (a stornoed carry released it).
  const carryMarkers = markers.filter(
    (row) =>
      row.fiscal_period_id === period.id &&
      (row.kind === 'receivable_invoice' || row.kind === 'payable_invoice') &&
      markerEntry(row)?.status === 'posted',
  )
  const liveCarries = await resolveLiveCarries(supabase, companyId, carryMarkers)

  const collection = sortedCutoffCollection(await collectKontantmetodCutoff(
    supabase,
    companyId,
    period.period_start,
    period.period_end,
    {
      mode: 'per_invoice',
      liveCarries,
      legacyCutoffs,
      acknowledgedLegacyInvoiceIds: options.acknowledgedLegacyInvoiceIds,
    },
  ))
  const plans = collection.carries.map((doc) => buildKontantmetodCarryPlan(doc, entityType))
  const complete =
    plans.length === 0 &&
    collection.paidBeforePosting.length === 0 &&
    collection.paidBeforePostingManual.length === 0 &&
    collection.rotPartialManual.length === 0 &&
    collection.legacyCovered.length === 0 &&
    collection.unknownVatTreatment.length === 0 &&
    collection.strayVatOnZeroRate.length === 0

  return {
    mode: 'per_invoice',
    collection,
    plans,
    lines: EMPTY_CUTOFF_LINES,
    postings: {
      complete,
      hasAny: liveCarries.customer.size + liveCarries.supplier.size > 0,
      receivableEntryId: null,
      receivableReversalId: null,
      payableEntryId: null,
      payableReversalId: null,
      missing: [],
      duplicates: [],
    },
    complete,
    legacyCutoffs,
  }
}

async function resolveLiveCarries(
  supabase: SupabaseClient,
  companyId: string,
  carryMarkers: MarkerRow[],
): Promise<NonNullable<CollectKontantmetodCutoffOptions['liveCarries']>> {
  const customer = new Map<string, LiveCarry>()
  const supplier = new Map<string, LiveCarry>()
  const customerMarkers = carryMarkers.filter((m) => m.kind === 'receivable_invoice' && m.invoice_id)
  const supplierMarkers = carryMarkers.filter((m) => m.kind === 'payable_invoice' && m.supplier_invoice_id)

  for (const batch of chunked(customerMarkers, IN_CHUNK)) {
    const { data, error } = await supabase
      .from('invoices')
      .select('id, invoice_number, journal_entry_id, total, credited_invoice_id')
      .eq('company_id', companyId)
      .in('id', batch.map((m) => m.invoice_id as string))
    if (error) {
      throw new Error(`Kontantmetodens bokslutsavgränsning kunde inte läsa årsomförda fakturor: ${error.message}`)
    }
    const rows = new Map(((data ?? []) as Array<Record<string, unknown>>).map((r) => [r.id as string, r]))
    for (const m of batch) {
      const row = rows.get(m.invoice_id as string)
      if (row && row.journal_entry_id === m.journal_entry_id) {
        customer.set(m.invoice_id as string, {
          entryId: m.journal_entry_id,
          reference: (row.invoice_number as string | null) ?? (m.invoice_id as string),
          creditNote: Number(row.total ?? 0) < 0 || Boolean(row.credited_invoice_id),
        })
      }
    }
  }
  for (const batch of chunked(supplierMarkers, IN_CHUNK)) {
    const { data, error } = await supabase
      .from('supplier_invoices')
      .select('id, supplier_invoice_number, registration_journal_entry_id, is_credit_note')
      .eq('company_id', companyId)
      .in('id', batch.map((m) => m.supplier_invoice_id as string))
    if (error) {
      throw new Error(`Kontantmetodens bokslutsavgränsning kunde inte läsa årsomförda leverantörsfakturor: ${error.message}`)
    }
    const rows = new Map(((data ?? []) as Array<Record<string, unknown>>).map((r) => [r.id as string, r]))
    for (const m of batch) {
      const row = rows.get(m.supplier_invoice_id as string)
      if (row && row.registration_journal_entry_id === m.journal_entry_id) {
        supplier.set(m.supplier_invoice_id as string, {
          entryId: m.journal_entry_id,
          reference: (row.supplier_invoice_number as string | null) ?? (m.supplier_invoice_id as string),
          creditNote: Boolean(row.is_credit_note),
        })
      }
    }
  }
  return { customer, supplier }
}

// ---------------------------------------------------------------------------
// Corrections: paid after period end, before the cut-off posted (edge case 1)
// ---------------------------------------------------------------------------

/** Settlement-side accounts in class 3-8 a cash verifikat may keep in its rättelse. */
const CORRECTION_KEEPABLE_RESULT_ACCOUNTS = new Set(['3740', '3960', '7960', '6570'])

/**
 * True for an account the cash verifikat may keep in its rättelse: the bank or
 * PSP leg (19xx, 1686, any other balance account the payment went through),
 * öresavrundning (3740), a bank fee (6570) and kursdifferens (3960 / 7960).
 * Never moms (26xx), the ROT/RUT fordran (1513) or revenue and cost: those
 * belong to the carry, and finding one here means the cash verifikat is not
 * the shape the carry was built from.
 */
function isCorrectionKeepableAccount(account: string): boolean {
  if (account.startsWith('26') || account === '1513') return false
  if (/^[3-8]/.test(account)) return CORRECTION_KEEPABLE_RESULT_ACCOUNTS.has(account)
  return true
}

/** The parts of a journal line the clearing test reads (numbers may arrive as strings). */
export interface CarryClearingLine {
  account_number: string
  debit_amount: number | string | null
  credit_amount: number | string | null
}

/**
 * True when a payment verifikat only CLEARS the receivable or payable a carry
 * books: a net credit on 151x (customer) or a net debit on 244x (supplier),
 * the opposite for a credit note, and every other line on an account the
 * settlement may touch (the bank or PSP leg, öresavrundning 3740, a bank fee
 * 6570, kursdifferens 3960 / 7960). Anything on revenue or cost, on 26xx
 * moms, or a 151x / 244x movement the wrong way makes it a verifikat that
 * books the affärshändelse again, which for a carried invoice declares the
 * moms a second time. Pure.
 */
export function isCarryClearingVerifikat(
  side: 'customer' | 'supplier',
  creditNote: boolean,
  lines: readonly CarryClearingLine[],
): boolean {
  const anchorPrefix = side === 'customer' ? '151' : '244'
  // The carry debits 1510 (customer) or credits 2440 (supplier); its
  // clearing moves the other way. A credit note mirrors both.
  const clearingSign = (side === 'customer') !== creditNote ? -1 : 1
  let anchorNetOre = 0
  for (const line of lines) {
    const account = String(line.account_number ?? '')
    const netOre = toOre(Number(line.debit_amount ?? 0)) - toOre(Number(line.credit_amount ?? 0))
    if (account.startsWith(anchorPrefix)) {
      anchorNetOre += netOre
      continue
    }
    if (!isCorrectionKeepableAccount(account)) return false
  }
  return Math.sign(anchorNetOre) === clearingSign
}

/** A journal line as read back from journal_entry_lines (numbers may arrive as strings). */
export interface CorrectionSourceLine {
  account_number: string
  debit_amount: number | string | null
  credit_amount: number | string | null
  line_description?: string | null
  currency?: string | null
  amount_in_currency?: number | string | null
  exchange_rate?: number | string | null
  tax_code?: string | null
  dimensions?: Record<string, string> | null
}

/** Why a cash verifikat cannot be corrected by rule; the user corrects it by hand. */
export class KontantmetodCorrectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KontantmetodCorrectionError'
  }
}

function correctionInputLine(line: CorrectionSourceLine): CreateJournalEntryLineInput {
  const dimensions = line.dimensions && Object.keys(line.dimensions).length > 0 ? line.dimensions : null
  return {
    account_number: line.account_number,
    debit_amount: toKronor(toOre(Number(line.debit_amount ?? 0))),
    credit_amount: toKronor(toOre(Number(line.credit_amount ?? 0))),
    ...(line.line_description ? { line_description: line.line_description } : {}),
    ...(line.currency ? { currency: line.currency } : {}),
    ...(line.amount_in_currency != null ? { amount_in_currency: Number(line.amount_in_currency) } : {}),
    ...(line.exchange_rate != null ? { exchange_rate: Number(line.exchange_rate) } : {}),
    ...(line.tax_code ? { tax_code: line.tax_code } : {}),
    ...(dimensions ? { dimensions: { ...dimensions } } : {}),
  }
}

/**
 * The rättelse lines for a cash verifikat E that booked revenue or cost and
 * moms when an invoice the cut-off carries was paid after period end. Pure.
 *
 * They are exactly the clearing the faktureringsmetod payment door books for
 * the same payment: E's settlement side stays as it was (the bank or PSP leg,
 * öresavrundning, a bank fee), and everything E booked as the affärshändelse
 * (revenue or cost, moms, the ROT/RUT 1513 leg, a reverse-charge pair) is
 * replaced by one line that clears 1510 / 2440 at the amount the carry put
 * there. A foreign invoice's difference between the SEK that moved and the
 * carried SEK is kursdifferens: 3960 (vinst) or 7960 (förlust).
 *
 *   customer: Dr 19xx bank / Cr 1510 carried, ±3960/7960
 *   supplier: Dr 2440 carried / Cr 19xx bank, ±3960/7960
 *
 * The storno of E (correctEntry) takes the revenue or cost and moms back out
 * of E's own VAT period, so they are declared once, in the closed year, by the
 * carry. Throws KontantmetodCorrectionError, naming the reason, when E is not
 * the shape the rule covers; the user corrects it by hand.
 */
export function buildPaidBeforePostingCorrectionLines(args: {
  side: 'customer' | 'supplier'
  reference: string
  cashLines: CorrectionSourceLine[]
  carryLines: CorrectionSourceLine[]
  /** The payment row's amount in the invoice's currency; null = the whole carry. */
  paymentAmount: number | null
}): CreateJournalEntryLineInput[] {
  const anchorAccount = CARRY_ANCHOR_ACCOUNT[args.side]
  const anchors = args.carryLines.filter((line) => line.account_number === anchorAccount)
  if (anchors.length !== 1) {
    throw new KontantmetodCorrectionError(
      `årsomföringen har ${anchors.length} rader på ${anchorAccount}, förväntade en`,
    )
  }
  const carryAnchor = anchors[0]!
  const anchorNetOre = toOre(Number(carryAnchor.debit_amount ?? 0)) - toOre(Number(carryAnchor.credit_amount ?? 0))
  if (anchorNetOre === 0) throw new KontantmetodCorrectionError(`årsomföringens rad på ${anchorAccount} saknar belopp`)
  const anchorSekOre = Math.abs(anchorNetOre)
  const foreignAmount = carryAnchor.amount_in_currency == null ? null : Math.abs(Number(carryAnchor.amount_in_currency))
  const foreign = !isLedgerCurrency(carryAnchor.currency?.toUpperCase()) && foreignAmount != null && foreignAmount > 0
  const openOwn = foreign ? foreignAmount! : toKronor(anchorSekOre)

  let clearOre: number
  if (args.paymentAmount == null || Math.abs(args.paymentAmount - openOwn) < ORE_TOLERANCE) {
    clearOre = anchorSekOre
  } else if (args.paymentAmount > openOwn) {
    throw new KontantmetodCorrectionError(
      `betalningen (${roundOre(args.paymentAmount)}) är större än det årsomförda beloppet (${roundOre(openOwn)})`,
    )
  } else {
    // A part of the carried amount: at the carry's own rate, so the parts of
    // several payments add up to the carry.
    clearOre = foreign
      ? Math.round(anchorSekOre * (args.paymentAmount / openOwn))
      : toOre(args.paymentAmount)
  }

  const dropped = new Set(args.carryLines.map((line) => line.account_number))
  const kept: CreateJournalEntryLineInput[] = []
  for (const line of args.cashLines) {
    if (line.account_number === anchorAccount) {
      throw new KontantmetodCorrectionError(`kontantverifikatet har redan en rad på ${anchorAccount}`)
    }
    if (dropped.has(line.account_number)) continue
    if (!isCorrectionKeepableAccount(line.account_number)) {
      throw new KontantmetodCorrectionError(
        `kontantverifikatet har en rad på ${line.account_number} som årsomföringen inte bokar`,
      )
    }
    kept.push(correctionInputLine(line))
  }
  if (kept.length === 0) throw new KontantmetodCorrectionError('kontantverifikatet saknar betalningsrad')

  const text = args.side === 'customer'
    ? `Kundfaktura ${args.reference}: betald efter bokslut, mot årsomföringen`
    : `Leverantörsfaktura ${args.reference}: betald efter bokslut, mot årsomföringen`
  // The opposite side of the carry's anchor: a carried kundfordran (debit) is
  // credited, a carried leverantörsskuld (credit) debited; a credit note's
  // carry the other way round.
  const clearsWithCredit = anchorNetOre > 0
  const lines: CreateJournalEntryLineInput[] = [
    ...kept,
    {
      account_number: anchorAccount,
      debit_amount: clearsWithCredit ? 0 : toKronor(clearOre),
      credit_amount: clearsWithCredit ? toKronor(clearOre) : 0,
      line_description: text,
    },
  ]

  const residualOre = lines.reduce(
    (sum, line) => sum + toOre(line.debit_amount) - toOre(line.credit_amount),
    0,
  )
  if (residualOre !== 0) {
    if (!foreign) {
      throw new KontantmetodCorrectionError(
        `betalningen (${toKronor(Math.abs(residualOre))} kr) stämmer inte med det årsomförda beloppet`,
      )
    }
    lines.push(residualOre > 0
      ? { account_number: '3960', debit_amount: 0, credit_amount: toKronor(residualOre), line_description: 'Valutakursvinst' }
      : { account_number: '7960', debit_amount: toKronor(-residualOre), credit_amount: 0, line_description: 'Valutakursförlust' })
  }
  return lines
}

/** One correction as the preview shows it, and as it posts. */
export interface PaidBeforePostingCorrectionPreview {
  side: 'customer' | 'supplier'
  invoiceId: string
  reference: string
  /** The cash verifikat E that is stornoed. */
  entryId: string
  entryDate: string
  /** The carry this correction clears against; null when the run posts it first. */
  carryEntryId: string | null
  /** The storno: E's lines, debit and credit swapped. */
  stornoLines: CreateJournalEntryLineInput[]
  /** The rättelse that replaces E. */
  correctedLines: CreateJournalEntryLineInput[]
}

/** A correction the rule cannot make: KONTANTMETOD_CUTOFF_PAID_BEFORE_POSTING_MANUAL. */
export interface PaidBeforePostingCorrectionRefusal {
  side: 'customer' | 'supplier'
  invoiceId: string
  reference: string
  entryId: string
  entryDate: string
  reason: string
}

interface LoadedEntry {
  id: string
  status: string
  entry_date: string
  voucher_series: string | null
  voucher_number: number | null
  lines: CorrectionSourceLine[]
}

async function loadEntriesWithLines(
  supabase: SupabaseClient,
  companyId: string,
  ids: string[],
): Promise<Map<string, LoadedEntry>> {
  const entries = new Map<string, LoadedEntry>()
  for (const batch of chunked([...new Set(ids)], IN_CHUNK)) {
    const { data, error } = await supabase
      .from('journal_entries')
      .select('id, status, entry_date, voucher_series, voucher_number, lines:journal_entry_lines(*)')
      .eq('company_id', companyId)
      .in('id', batch)
    if (error) {
      throw new Error(`Kontantmetodens bokslutsavgränsning kunde inte läsa verifikat: ${error.message}`)
    }
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      entries.set(row.id as string, {
        id: row.id as string,
        status: row.status as string,
        entry_date: row.entry_date as string,
        voucher_series: (row.voucher_series as string | null) ?? null,
        voucher_number: row.voucher_number == null ? null : Number(row.voucher_number),
        lines: (Array.isArray(row.lines) ? row.lines : []) as CorrectionSourceLine[],
      })
    }
  }
  return entries
}

function stornoPreviewLines(lines: CorrectionSourceLine[]): CreateJournalEntryLineInput[] {
  return lines.map((line) => {
    const input = correctionInputLine(line)
    return {
      ...input,
      debit_amount: input.credit_amount,
      credit_amount: input.debit_amount,
      ...(input.amount_in_currency != null ? { amount_in_currency: -input.amount_in_currency } : {}),
    }
  })
}

/**
 * What each correction in `items` would post, or why it cannot be made by
 * rule. An invoice not yet carried takes its carry lines from its plan (what
 * the same run posts first); a carried one from its posted carry.
 */
export async function previewPaidBeforePostingCorrections(
  supabase: SupabaseClient,
  companyId: string,
  items: PaidBeforePosting[],
  plans: KontantmetodCarryPlan[],
): Promise<{ corrections: PaidBeforePostingCorrectionPreview[]; refusals: PaidBeforePostingCorrectionRefusal[] }> {
  const corrections: PaidBeforePostingCorrectionPreview[] = []
  const refusals: PaidBeforePostingCorrectionRefusal[] = []
  if (items.length === 0) return { corrections, refusals }

  const entries = await loadEntriesWithLines(supabase, companyId, [
    ...items.map((item) => item.entryId),
    ...items.map((item) => item.carryEntryId).filter((id): id is string => !!id),
  ])
  const planByInvoice = new Map(plans.map((plan) => [`${plan.side}:${plan.invoiceId}`, plan]))

  for (const item of items) {
    const base = {
      side: item.side,
      invoiceId: item.invoiceId,
      reference: item.reference,
      entryId: item.entryId,
      entryDate: item.entryDate,
    }
    const cash = entries.get(item.entryId)
    const carryLines: CorrectionSourceLine[] | null = item.carryEntryId
      ? entries.get(item.carryEntryId)?.lines ?? null
      : planByInvoice.get(`${item.side}:${item.invoiceId}`)?.lines ?? null
    if (!cash || cash.status !== 'posted') {
      refusals.push({ ...base, reason: 'kontantverifikatet kunde inte läsas eller är inte längre bokfört' })
      continue
    }
    if (!carryLines) {
      refusals.push({ ...base, reason: 'fakturan årsomförs inte i den här körningen' })
      continue
    }
    try {
      const correctedLines = buildPaidBeforePostingCorrectionLines({
        side: item.side,
        reference: item.reference,
        cashLines: cash.lines,
        carryLines,
        paymentAmount: item.paymentAmount,
      })
      corrections.push({
        ...base,
        carryEntryId: item.carryEntryId,
        stornoLines: stornoPreviewLines(cash.lines),
        correctedLines,
      })
    } catch (err) {
      refusals.push({ ...base, reason: err instanceof Error ? err.message : 'okänt fel' })
    }
  }
  return { corrections, refusals }
}

/** Verifikationstext of the rättelse, naming the carry it clears against. */
export function paidBeforePostingCorrectionDescription(carryVoucher: string): string {
  return `Rättelse: betald efter bokslut, årsomföring kontantmetoden (verifikat ${carryVoucher})`
}

export interface CorrectedPayment {
  side: 'customer' | 'supplier'
  invoiceId: string
  reference: string
  /** The cash verifikat E, now reversed. */
  entryId: string
  stornoEntryId: string
  correctionEntryId: string
}

export interface FailedCorrection {
  side: 'customer' | 'supplier'
  invoiceId: string
  reference: string
  entryId: string
  /** Registry code when the failure has one (a period lock, a DB refusal). */
  code: string | null
  message: string
}

/**
 * Correct one cash verifikat E against its carry with correctEntry (BFL 5 kap
 * 5 §: storno plus rättelse, both on E's own date). Returns null when E is no
 * longer posted: it was corrected already, so there is nothing to do.
 *
 * Through the posting port's correctJournalEntry, which hands correctEntry
 * its arguments unchanged and, while POSTING_EVENTS is shadow or strict,
 * records the rättelse's two events as every rättelse does (step 2i):
 * ledger.storno of E linked to its storno (role reversal) and
 * ledger.correction of E linked to the corrected verifikat (role
 * correction), dated the day they are made, both recorded before the storno
 * is drafted. The correction's lines are this rule's
 * (buildPaidBeforePostingCorrectionLines), so it names the cut-off's rule
 * version; the basis is the door's (`posting`), as for the carries: the
 * correction is part of what the cut-off was asked to post, not a
 * compensation.
 */
async function correctPaidBeforePosting(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  item: PaidBeforePosting,
  carryEntryId: string,
  posting: (() => YearEndPostingContext) | undefined,
): Promise<{ stornoEntryId: string; correctionEntryId: string } | null> {
  const { data: original, error } = await supabase
    .from('journal_entries')
    .select('*, lines:journal_entry_lines(*)')
    .eq('id', item.entryId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw new Error(`Kontantverifikatet kunde inte läsas: ${error.message}`)
  if (!original || (original as { status?: string }).status !== 'posted') return null

  const carry = (await loadEntriesWithLines(supabase, companyId, [carryEntryId])).get(carryEntryId)
  if (!carry || carry.status !== 'posted') {
    throw new KontantmetodCorrectionError('årsomföringen är inte bokförd')
  }
  const correctedLines = buildPaidBeforePostingCorrectionLines({
    side: item.side,
    reference: item.reference,
    cashLines: ((original as { lines?: CorrectionSourceLine[] }).lines ?? []),
    carryLines: carry.lines,
    paymentAmount: item.paymentAmount,
  })
  const voucher = carry.voucher_number != null
    ? formatVoucher(carry)
    : carry.id
  const { reversal, corrected } = await postingPort.correctJournalEntry({
    supabase,
    companyId,
    userId,
    entryId: item.entryId,
    // Built only while the port is on: off, correctEntry gets the call it always did.
    ...correctionBusinessEvents({
      entryId: item.entryId,
      occurredOn: todayIsoStockholm,
      linkBasis: () => posting?.().linkBasis,
      mappingVersion: () => mappingVersion('kontantmetodCutoff'),
    }),
    correction: {
      lines: correctedLines,
      options: {
        preloadedOriginal: original as unknown as JournalEntry & { lines?: JournalEntryLine[] | null },
        description: paidBeforePostingCorrectionDescription(voucher),
      },
    },
  })
  return { stornoEntryId: reversal.id, correctionEntryId: corrected.id }
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

/** Carry verifikat posted per call: bounded so one run stays inside a request. */
export const KONTANTMETOD_CUTOFF_CHUNK_SIZE = 100

export interface PostedCarry {
  side: 'customer' | 'supplier'
  invoiceId: string
  reference: string
  entryId: string
}

export interface CompensatedCarry extends PostedCarry {
  /** The storno on period_end that took the carry back out; null if it failed. */
  stornoEntryId: string | null
  /** Why the link was not recorded (CUTOFF_INVOICE_ALREADY_LINKED, ...). */
  code: string
}

export interface PostKontantmetodCutoffResult {
  posted: PostedCarry[]
  /** Carries posted but not linked (lost a race, or the guard refused), stornoed. */
  compensated: CompensatedCarry[]
  /**
   * Cash verifikat booked at a payment after period end, corrected with
   * correctEntry (storno plus rättelse on their own date) after the carry
   * posted (edge case 1).
   */
  corrected: CorrectedPayment[]
  /**
   * Corrections that failed. The carry stands and stays linked; the invoice
   * stays on paidBeforePosting, so readiness keeps the blocker and a re-run
   * performs only the correction (self-healing).
   */
  correctionFailed: FailedCorrection[]
  /** Plans not attempted in this call (beyond the chunk): run again. */
  remaining: number
}

export class KontantmetodCutoffPartialError extends Error {
  readonly postedIds: Record<string, string>
  readonly cause: unknown

  constructor(message: string, postedIds: Record<string, string>, cause: unknown) {
    super(message)
    this.name = 'KontantmetodCutoffPartialError'
    this.postedIds = postedIds
    this.cause = cause
  }
}

interface LinkRpcResult {
  ok?: boolean
  code?: string
}

/** The ordinary utgående moms accounts per treatment, as getOutputVatAccount books them. */
const CARRY_OUTPUT_VAT_TREATMENTS: ReadonlyMap<string, VatTreatment> = new Map([
  ['2611', 'standard_25'],
  ['2621', 'reduced_12'],
  ['2631', 'reduced_6'],
])

/** Debiterad ingående moms, as the supplier registration builder (inputVatLines) books it. */
const CARRY_INPUT_VAT_ACCOUNT = '2641'

/**
 * What one carry verifikat states in its business event (year_end.closing,
 * one per invoice carried): the 1510 / 2440 leg it puts on the balance sheet
 * (plan.total, moms included) and the moms it books, read off its own lines
 * as the registration builders book it. A customer carry states utgående
 * moms per treatment (2611 / 2621 / 2631); a supplier carry its ingående
 * moms on 2641 with no treatment (one account for every rate). A
 * reverse-charge pair (2614 / 2645, 2647) states none: it stays in the
 * lines. Magnitudes, so a credit note's carry states the moms it takes back.
 * A manual carry's lines are the accountant's own: it names no rule version.
 * Pure.
 */
export function carryBusinessEventFacts(
  plan: Pick<KontantmetodCarryPlan, 'side' | 'mode' | 'lines' | 'total'>,
): { amount: number; taxAmounts: BusinessEventTaxAmount[]; manualLines: boolean } {
  const netOreByTreatment = new Map<VatTreatment | null, number>()
  for (const line of plan.lines) {
    let treatment: VatTreatment | null | undefined
    if (plan.side === 'customer') treatment = CARRY_OUTPUT_VAT_TREATMENTS.get(line.account_number)
    else if (line.account_number === CARRY_INPUT_VAT_ACCOUNT) treatment = null
    if (treatment === undefined) continue
    const netOre = toOre(line.debit_amount) - toOre(line.credit_amount)
    netOreByTreatment.set(treatment, (netOreByTreatment.get(treatment) ?? 0) + netOre)
  }
  const taxAmounts: BusinessEventTaxAmount[] = []
  for (const [treatment, netOre] of netOreByTreatment) {
    if (netOre === 0) continue
    taxAmounts.push({ tax: 'vat', treatment, amount_sek: toKronor(Math.abs(netOre)) })
  }
  return { amount: plan.total, taxAmounts, manualLines: plan.mode === 'manual' }
}

/**
 * Post the per-invoice carries, at most `chunkSize` per call.
 *
 * For each plan, in order:
 *   1. the posting port (postJournalEntry) posts the carry verifikat dated
 *      period_end, source_type 'year_end', source_id the closing period;
 *   2. record_kontantmetod_cutoff_link writes the marker and the invoice link
 *      in one transaction under a lock on the invoice. When it refuses (the
 *      invoice was linked meanwhile: CUTOFF_INVOICE_ALREADY_LINKED) or the
 *      marker guard raises, the carry is stornoed on period_end through the
 *      port's reverseJournalEntry (BFL 5 kap 5 §: never deleted), which
 *      leaves a visible net-zero pair in the same VAT period and no voucher
 *      gap;
 *   3. the invoice's document is anchored to the carry, best-effort.
 *
 * Then every cash verifikat in `paidBeforePosting` whose invoice is carried
 * (now or by an earlier run) is corrected with correctEntry
 * (buildPaidBeforePostingCorrectionLines), reported in `corrected` or
 * `correctionFailed`.
 *
 * Posting port (step 2g): each carry records its own business event
 * (year_end.closing, carryBusinessEventFacts) and each compensating storno
 * ledger.storno (system_derived), only while POSTING_EVENTS is on.
 * `opts.posting` is what the door saw (its link basis). The correction of a
 * cash verifikat goes through the port's correctJournalEntry (step 3) and
 * records ledger.storno and ledger.correction of that verifikat, as every
 * rättelse does (correctPaidBeforePosting).
 *
 * A run is resumable by construction: a linked invoice drops out of the next
 * collection. A failure to post stops the run; whatever already posted stays
 * posted and linked, and is reported through KontantmetodCutoffPartialError.
 * A carry that could neither be linked nor stornoed also stops the run: it
 * stands unlinked, so a re-run would carry the invoice a second time.
 */
export async function postKontantmetodCutoff(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  opts: {
    fiscalPeriodId: string
    periodEnd: string
    plans: KontantmetodCarryPlan[]
    /**
     * Cash verifikat to correct after the carries (edge case 1). An item whose
     * invoice is neither carried already nor carried by this call waits for
     * the run that carries it.
     */
    paidBeforePosting?: PaidBeforePosting[]
    /** Refuse if any invoice lacked a vat_treatment (see CutoffCollection). */
    unknownVatTreatment?: string[]
    /** Refuse if any invoice carried moms on a zero-rate treatment. */
    strayVatOnZeroRate?: string[]
    chunkSize?: number
    /** What the door saw, for the posting port; called only while POSTING_EVENTS is on. */
    posting?: () => YearEndPostingContext
  },
): Promise<PostKontantmetodCutoffResult> {
  if (opts.unknownVatTreatment && opts.unknownVatTreatment.length > 0) {
    throw new Error(
      `${opts.unknownVatTreatment.length} fakturor saknar momsinställning och kan inte tas med i bokslutsavgränsningen: ` +
        `${opts.unknownVatTreatment.slice(0, 10).join(', ')}. Komplettera fakturorna och kör om.`,
    )
  }

  if (opts.strayVatOnZeroRate && opts.strayVatOnZeroRate.length > 0) {
    throw new Error(
      `${opts.strayVatOnZeroRate.length} fakturor har moms trots en momsfri momsinställning (export, omvänd betalningsskyldighet eller undantagen) och kan inte tas med i bokslutsavgränsningen: ` +
        `${opts.strayVatOnZeroRate.slice(0, 10).join(', ')}. Rätta fakturorna och kör om.`,
    )
  }

  const chunkSize = Math.max(1, Math.min(opts.chunkSize ?? KONTANTMETOD_CUTOFF_CHUNK_SIZE, KONTANTMETOD_CUTOFF_CHUNK_SIZE))
  const batch = opts.plans.slice(0, chunkSize)
  const result: PostKontantmetodCutoffResult = {
    posted: [],
    compensated: [],
    corrected: [],
    correctionFailed: [],
    remaining: opts.plans.length - batch.length,
  }

  const postedIds = (): Record<string, string> => {
    const ids: Record<string, string> = {}
    for (const p of result.posted) ids[`carry_${p.invoiceId}`] = p.entryId
    for (const c of result.compensated) {
      ids[`carry_${c.invoiceId}`] = c.entryId
      if (c.stornoEntryId) ids[`storno_${c.invoiceId}`] = c.stornoEntryId
    }
    return ids
  }

  for (let index = 0; index < batch.length; index++) {
    const plan = batch[index]!
    let entry: JournalEntry
    try {
      entry = await postingPort.postJournalEntry({
        supabase,
        companyId,
        userId,
        event: () =>
          kontantmetodCutoffBusinessEvent({
            fiscalPeriodId: opts.fiscalPeriodId,
            occurredOn: opts.periodEnd,
            ...carryBusinessEventFacts(plan),
            linkBasis: opts.posting?.().linkBasis,
          }),
        input: {
          fiscal_period_id: opts.fiscalPeriodId,
          entry_date: opts.periodEnd,
          description: plan.description,
          source_type: 'year_end',
          source_id: opts.fiscalPeriodId,
          notes: plan.notes,
          lines: plan.lines,
        },
      })
    } catch (err) {
      if (result.posted.length === 0 && result.compensated.length === 0) throw err
      throw new KontantmetodCutoffPartialError(
        `Årsomföringen avbröts vid faktura ${plan.reference}: ${result.posted.length} verifikat bokförda, kör om för resten`,
        postedIds(),
        err,
      )
    }

    let linkCode: string | null = null
    try {
      const { data, error } = await supabase.rpc('record_kontantmetod_cutoff_link', {
        p_company_id: companyId,
        p_fiscal_period_id: opts.fiscalPeriodId,
        p_journal_entry_id: entry.id,
        p_invoice_id: plan.side === 'customer' ? plan.invoiceId : null,
        p_supplier_invoice_id: plan.side === 'supplier' ? plan.invoiceId : null,
      })
      const rpc = data as LinkRpcResult | null
      if (error) linkCode = error.message || 'CUTOFF_LINK_FAILED'
      else if (!rpc?.ok) linkCode = rpc?.code ?? 'CUTOFF_LINK_FAILED'
    } catch (err) {
      linkCode = err instanceof Error ? err.message : 'CUTOFF_LINK_FAILED'
    }

    if (linkCode !== null) {
      let stornoEntryId: string | null = null
      try {
        // Same date, so the pair nets to zero inside the closed year's final
        // VAT period. No marker exists for this entry, so the engine's carry
        // checks do not apply to it. Through the posting port: ledger.storno,
        // system_derived (nobody chose it).
        const storno = await postingPort.reverseJournalEntry({
          supabase,
          companyId,
          userId,
          entryId: entry.id,
          reversalDate: opts.periodEnd,
          event: () =>
            yearEndStornoBusinessEvent({
              fiscalPeriodId: opts.fiscalPeriodId,
              occurredOn: todayIsoStockholm(),
              linkBasis: systemDerivedLinkBasis(opts.posting?.()),
            }),
          role: 'reversal',
        })
        stornoEntryId = storno.id
      } catch (stornoError) {
        log.error(
          'kontantmetod carry could not be linked AND its compensating storno failed: an unlinked carry stands, manual correction required',
          stornoError as Error,
          { companyId, entryId: entry.id, invoiceId: plan.invoiceId, linkCode },
        )
        result.compensated.push({
          side: plan.side,
          invoiceId: plan.invoiceId,
          reference: plan.reference,
          entryId: entry.id,
          stornoEntryId: null,
          code: linkCode,
        })
        throw new KontantmetodCutoffPartialError(
          `Årsomföringen för faktura ${plan.reference} kunde varken kopplas eller makuleras: rätta verifikatet manuellt innan du kör om`,
          postedIds(),
          stornoError,
        )
      }
      log.warn('kontantmetod carry not linked; stornoed on period end', {
        companyId,
        entryId: entry.id,
        invoiceId: plan.invoiceId,
        linkCode,
      })
      result.compensated.push({
        side: plan.side,
        invoiceId: plan.invoiceId,
        reference: plan.reference,
        entryId: entry.id,
        stornoEntryId,
        code: linkCode,
      })
      continue
    }

    result.posted.push({
      side: plan.side,
      invoiceId: plan.invoiceId,
      reference: plan.reference,
      entryId: entry.id,
    })

    // The invoice's archived document is the carry's underlag. Never throws.
    if (plan.side === 'customer') {
      await anchorCustomerInvoiceDocument(supabase, companyId, plan.invoiceId)
    } else {
      await anchorSupplierInvoiceDocument(supabase, companyId, plan.invoiceId)
    }
  }

  // Edge case 1, AFTER the carries: the rättelse clears the 1510 / 2440 the
  // carry booked, so it can only post against a carry that stands. A failure
  // is reported and the run goes on; the next run finds the same cash
  // verifikat still posted and performs only its correction.
  const carriedNow = new Map(result.posted.map((p) => [`${p.side}:${p.invoiceId}`, p.entryId]))
  for (const item of opts.paidBeforePosting ?? []) {
    const carryEntryId = item.carryEntryId ?? carriedNow.get(`${item.side}:${item.invoiceId}`) ?? null
    if (!carryEntryId) continue
    try {
      const done = await correctPaidBeforePosting(supabase, companyId, userId, item, carryEntryId, opts.posting)
      if (!done) continue
      result.corrected.push({
        side: item.side,
        invoiceId: item.invoiceId,
        reference: item.reference,
        entryId: item.entryId,
        ...done,
      })
    } catch (err) {
      const code = (err as { code?: unknown }).code
      log.warn('kontantmetod cash verifikat not corrected; the carry stands, a re-run retries', {
        companyId,
        invoiceId: item.invoiceId,
        entryId: item.entryId,
        carryEntryId,
        error: err instanceof Error ? err.message : String(err),
      })
      result.correctionFailed.push({
        side: item.side,
        invoiceId: item.invoiceId,
        reference: item.reference,
        entryId: item.entryId,
        code: typeof code === 'string' ? code : null,
        message: err instanceof Error ? err.message : 'okänt fel',
      })
    }
  }

  return result
}
