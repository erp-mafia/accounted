/**
 * Kontantmetoden year-end cut-off (BFL 5 kap 2 §).
 *
 * Under kontantmetoden (bokslutsmetoden) affärshändelser are booked when cash
 * moves, so open customer and supplier invoices never reach 1510 / 2440 during
 * the year. BFL still requires that fordringar och skulder ARE booked at
 * räkenskapsårets utgång, so the year-end needs a cut-off entry that puts every
 * still-outstanding invoice onto the balance sheet.
 *
 * Moms is the part that is easy to get wrong. Under bokslutsmetoden, unpaid
 * invoice moms must be included in the final VAT period of the year. BAS
 * provides 2618/2628/2638 for year-end output VAT and 2648 for year-end input
 * VAT. The VAT report maps those accounts for the cut-off date, while excluding
 * the mechanical day-one reversal so it cannot undo the final declaration.
 *
 * Shape: two aggregate verifikat (one for fordringar, one for skulder), each
 * reversed on the first day of the following period. Deliberately NOT
 * per-invoice, and deliberately not linked through invoices.journal_entry_id:
 *
 *  - the payment flows route on whether a live journal-entry link exists, so
 *    linking here would make every new-year payment take the accrual clearing
 *    path against a receivable the reversal has already removed, booking the
 *    settlement twice;
 *  - leaving the link unset means a new-year payment still books the normal
 *    kontantmetoden cash entry (revenue/expense + real moms at the payment
 *    date), which is what bokslutsmetoden requires.
 *
 * The reversal is what makes that safe: cut-off on the last day of the year,
 * vändning on the first day of the next, and the ledger is back to a pure cash
 * basis before any new-year payment is booked.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createHash } from 'node:crypto'
import type {
  CreateJournalEntryLineInput,
  EntityType,
  JournalEntry,
  VatTreatment,
} from '@/types'
import { getRevenueAccount } from '@/lib/bookkeeping/invoice-entries'
import {
  generateReverseChargeBasisLines,
  generateReverseChargeLines,
  isReverseChargeBasisAccount,
  resolveReverseChargeRate,
} from '@/lib/bookkeeping/vat-entries'
import { createJournalEntry, reverseEntry } from '@/lib/bookkeeping/engine'
import { createLogger } from '@/lib/logger'
import { ORE_TOLERANCE, roundOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

const log = createLogger('kontantmetod-cutoff')

/**
 * Vilande utgående moms per VAT treatment. Rates outside 25/12/6 (export,
 * reverse charge, exempt) carry no Swedish output moms at all, so they never
 * reach this map: their whole outstanding amount is revenue.
 */
export const VILANDE_OUTPUT_VAT_ACCOUNTS: Partial<Record<VatTreatment, string>> = {
  standard_25: '2618',
  reduced_12: '2628',
  reduced_6: '2638',
}

/** Vilande ingående moms. One account for every rate, mirroring 2641. */
export const VILANDE_INPUT_VAT_ACCOUNT = '2648'

export const RECEIVABLES_ACCOUNT = '1510'
export const PAYABLES_ACCOUNT = '2440'

export const KONTANTMETOD_CUTOFF_DESCRIPTIONS = {
  receivable: 'Kundfordringar vid bokslut (kontantmetoden)',
  receivableReversal: 'Vändning kundfordringar bokslut (kontantmetoden)',
  payable: 'Leverantörsskulder vid bokslut (kontantmetoden)',
  payableReversal: 'Vändning leverantörsskulder bokslut (kontantmetoden)',
} as const

/** A customer invoice still outstanding at period end. Amounts are SEK. */
export interface CutoffReceivable {
  id: string
  /** Human reference for the line description. */
  reference: string
  vatTreatment: VatTreatment
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
    supplierType: 'eu_business' | 'non_eu_business' | 'swedish_business'
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

interface PostedCutoffEntry {
  id: string
  fiscal_period_id: string
  entry_date: string
  description: string
  lines: Array<{
    account_number: string
    debit_amount: number | string | null
    credit_amount: number | string | null
  }>
}

export interface KontantmetodCutoffPostingStatus {
  complete: boolean
  hasAny: boolean
  receivableEntryId: string | null
  receivableReversalId: string | null
  payableEntryId: string | null
  payableReversalId: string | null
  missing: Array<'receivable' | 'receivable_reversal' | 'payable' | 'payable_reversal'>
  duplicates: string[]
}

export function hasIncompleteKontantmetodCutoffPair(
  status: KontantmetodCutoffPostingStatus,
  lines: CutoffLines,
): boolean {
  const receivablePartial = lines.receivableLines.length > 0 &&
    Boolean(status.receivableEntryId) !== Boolean(status.receivableReversalId)
  const payablePartial = lines.payableLines.length > 0 &&
    Boolean(status.payableEntryId) !== Boolean(status.payableReversalId)
  return status.duplicates.length > 0 || receivablePartial || payablePartial
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
  entityType: EntityType = 'aktiebolag',
): CutoffLines {
  const receivableLines: CreateJournalEntryLineInput[] = []
  const payableLines: CreateJournalEntryLineInput[] = []

  // ---- Fordringar -------------------------------------------------------
  // Group by VAT treatment: the revenue account and the vilande moms account
  // both follow from it.
  const revenueByTreatment = new Map<VatTreatment, number>()
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
    revenueByTreatment.set(row.vatTreatment, (revenueByTreatment.get(row.vatTreatment) ?? 0) + netOre)
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

    for (const [treatment, netOre] of revenueByTreatment) {
      if (netOre === 0) continue
      receivableLines.push(signedLine(
        getRevenueAccount(treatment, entityType),
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
    supplierType: 'eu_business' | 'non_eu_business' | 'swedish_business'
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
      const key = `${group.supplierType}:${group.rate}`
      const current = reverseChargeByGroup.get(key) ?? {
        rate: group.rate,
        baseOre: 0,
        nonBasisBaseOre: 0,
        supplierType: group.supplierType,
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
        generateReverseChargeLines(
          base,
          group.rate,
          group.supplierType === 'swedish_business',
        ),
        sign,
      )
      appendReverseChargeLines(
        generateReverseChargeBasisLines(nonBasisBase, group.rate, group.supplierType),
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
 * Inspect the immutable journal for a complete cut-off and its day-one
 * reversals. Matching exact account totals, rather than only a description,
 * makes a late invoice or payment reopen the blocker until a fresh cut-off is
 * posted. `source_id` anchors all four entries to the year being closed.
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
    .from('journal_entries')
    .select(
      'id, fiscal_period_id, entry_date, description, lines:journal_entry_lines(account_number, debit_amount, credit_amount)',
    )
    .eq('company_id', companyId)
    .eq('source_type', 'year_end')
    .eq('source_id', fiscalPeriodId)
    .eq('status', 'posted')
    .in('fiscal_period_id', [fiscalPeriodId, nextFiscalPeriodId])
    .in('description', Object.values(KONTANTMETOD_CUTOFF_DESCRIPTIONS))

  if (error) {
    throw new Error(`Kontantmetodens bokslutsavgränsning kunde inte kontrolleras: ${error.message}`)
  }

  const rows = (data ?? []) as PostedCutoffEntry[]
  const missing: KontantmetodCutoffPostingStatus['missing'] = []
  const duplicates: string[] = []

  const matchOne = (
    description: string,
    periodId: string,
    lines: CreateJournalEntryLineInput[],
    missingKind: KontantmetodCutoffPostingStatus['missing'][number],
    expectedDate: string,
  ): string | null => {
    const candidates = rows.filter(
      (row) => row.description === description && row.fiscal_period_id === periodId,
    )

    if (lines.length === 0) {
      if (candidates.length > 0) duplicates.push(description)
      return null
    }

    const exact = candidates.filter(
      (row) => row.entry_date === expectedDate && cutoffLinesEqual(lines, row.lines ?? []),
    )
    if (candidates.length !== 1 || exact.length !== 1) {
      // Any marker with non-matching lines is a conflict, even when only one
      // exists. Treating it as merely missing could stage a second cut-off on
      // top of an immutable entry after the source reskontra changed.
      if (candidates.length > 0) duplicates.push(description)
      missing.push(missingKind)
      return null
    }
    return exact[0]!.id
  }

  const receivableEntryId = matchOne(
    KONTANTMETOD_CUTOFF_DESCRIPTIONS.receivable,
    fiscalPeriodId,
    expected.receivableLines,
    'receivable',
    periodEnd,
  )
  const receivableReversalId = matchOne(
    KONTANTMETOD_CUTOFF_DESCRIPTIONS.receivableReversal,
    nextFiscalPeriodId,
    reverseLines(expected.receivableLines),
    'receivable_reversal',
    nextDay(periodEnd),
  )
  const payableEntryId = matchOne(
    KONTANTMETOD_CUTOFF_DESCRIPTIONS.payable,
    fiscalPeriodId,
    expected.payableLines,
    'payable',
    periodEnd,
  )
  const payableReversalId = matchOne(
    KONTANTMETOD_CUTOFF_DESCRIPTIONS.payableReversal,
    nextFiscalPeriodId,
    reverseLines(expected.payableLines),
    'payable_reversal',
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

export interface CutoffCollection {
  receivables: CutoffReceivable[]
  payables: CutoffPayable[]
  /**
   * Invoices whose vat_treatment is missing. Never guessed at: a reduced-rate
   * or exempt invoice silently defaulted to 25 % would land on the wrong
   * vilande account and the wrong revenue account. Posting refuses while this
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
}

export interface KontantmetodCutoffAssessment {
  collection: CutoffCollection
  lines: CutoffLines
  postings: KontantmetodCutoffPostingStatus
}

export function sortedCutoffCollection(collection: CutoffCollection): CutoffCollection {
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
  }
}

export function cutoffCollectionsEqual(
  left: CutoffCollection,
  right: CutoffCollection,
): boolean {
  return JSON.stringify(sortedCutoffCollection(left)) === JSON.stringify(sortedCutoffCollection(right))
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

export function cutoffPreviewFingerprint(args: {
  collection: CutoffCollection
  lines: CutoffLines
  entityType: EntityType
  periodEnd: string
}): string {
  const payload = JSON.stringify({
    collection: sortedCutoffCollection(args.collection),
    entity_type: args.entityType,
    period_end: args.periodEnd,
    reversal_date: nextDay(args.periodEnd),
    receivable_lines: canonicalLines(args.lines.receivableLines),
    payable_lines: canonicalLines(args.lines.payableLines),
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
  if (Number.isFinite(rate) && rate > 0) return roundOre(amount * rate)
  throw new Error(
    `Faktura ${String(row.id ?? '')} i ${currency} saknar användbart SEK-belopp eller valutakurs`,
  )
}

/**
 * Fetch every invoice still outstanding at `periodEnd`.
 *
 * "Outstanding at period end" is deliberately payment-DATE based, not the
 * current remaining_amount: an invoice settled in January was still a
 * fordran on 31 December and must be part of the cut-off. Reading
 * remaining_amount would silently shrink the cut-off every day the user
 * delays running the bokslut.
 */
export async function collectKontantmetodCutoff(
  supabase: SupabaseClient,
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<CutoffCollection> {
  let invoices: Array<Record<string, unknown>>
  let supplierInvoices: Array<Record<string, unknown>>
  try {
    [invoices, supplierInvoices] = await Promise.all([
      fetchAllRows<Record<string, unknown>>(
        ({ from, to }) => supabase
          .from('invoices')
          .select('id, invoice_number, invoice_date, status, total, total_sek, vat_amount, vat_amount_sek, vat_treatment, credited_invoice_id, document_type, currency, exchange_rate, deduction_total')
          .eq('company_id', companyId)
          .lte('invoice_date', periodEnd)
          .in('status', ['sent', 'overdue', 'partially_paid', 'paid', 'credited'])
          .order('id', { ascending: true })
          .range(from, to),
        { dedupeBy: (row) => row.id as string },
      ),
      fetchAllRows<Record<string, unknown>>(
        ({ from, to }) => supabase
          .from('supplier_invoices')
          .select('id, supplier_invoice_number, invoice_date, status, total, total_sek, vat_amount, vat_amount_sek, reverse_charge, is_credit_note, credited_invoice_id, currency, exchange_rate, supplier:suppliers(supplier_type), items:supplier_invoice_items(account_number, line_total, vat_rate, reverse_charge_rate)')
          .eq('company_id', companyId)
          .lte('invoice_date', periodEnd)
          .in('status', ['registered', 'approved', 'partially_paid', 'paid', 'credited'])
          .order('id', { ascending: true })
          .range(from, to),
        { dedupeBy: (row) => row.id as string },
      ),
    ])
  } catch (err) {
    throw new Error(
      'Kontantmetodens bokslutsavgränsning kunde inte läsa reskontran: ' +
        (err instanceof Error ? err.message : 'okänt fel'),
    )
  }

  // Payments ON OR BEFORE period end reduce the outstanding balance; later
  // ones must not. Amount is stored in the invoice's own currency.
  let invoicePayments: Array<Record<string, unknown>>
  let supplierPayments: Array<Record<string, unknown>>
  try {
    [invoicePayments, supplierPayments] = await Promise.all([
      fetchAllRows<Record<string, unknown>>(
        ({ from, to }) => supabase
          .from('invoice_payments')
          .select('id, invoice_id, amount, payment_date')
          .eq('company_id', companyId)
          .lte('payment_date', periodEnd)
          .order('id', { ascending: true })
          .range(from, to),
        { dedupeBy: (row) => row.id as string },
      ),
      fetchAllRows<Record<string, unknown>>(
        ({ from, to }) => supabase
          .from('supplier_invoice_payments')
          .select('id, supplier_invoice_id, amount, payment_date')
          .eq('company_id', companyId)
          .lte('payment_date', periodEnd)
          .order('id', { ascending: true })
          .range(from, to),
        { dedupeBy: (row) => row.id as string },
      ),
    ])
  } catch (err) {
    throw new Error(
      'Kontantmetodens bokslutsavgränsning kunde inte läsa betalningar: ' +
        (err instanceof Error ? err.message : 'okänt fel'),
    )
  }

  const paidByInvoice = new Map<string, number>()
  for (const row of invoicePayments) {
    const id = row.invoice_id as string
    paidByInvoice.set(id, (paidByInvoice.get(id) ?? 0) + Number(row.amount ?? 0))
  }
  const paidBySupplierInvoice = new Map<string, number>()
  for (const row of supplierPayments) {
    const id = row.supplier_invoice_id as string
    paidBySupplierInvoice.set(id, (paidBySupplierInvoice.get(id) ?? 0) + Number(row.amount ?? 0))
  }

  const receivables: CutoffReceivable[] = []
  const unknownVatTreatment: string[] = []
  const strayVatOnZeroRate: string[] = []
  for (const row of invoices) {
    // Credit notes reduce the receivable through their own negative totals;
    // they are already part of the invoice set, so no special casing beyond
    // skipping non-invoice document types (offers, delivery notes).
    const documentType = row.document_type as string | null
    if (documentType && documentType !== 'invoice') continue

    const totalOwn = Number(row.total ?? 0)
    const total = resolveHeaderSek(row, 'total', 'total_sek')
    const vat = resolveHeaderSek(row, 'vat_amount', 'vat_amount_sek')
    const paid = paidByInvoice.get(row.id as string) ?? 0

    // ROT/RUT (fakturamodellen): the customer owes the total minus the
    // skattereduktion. The deduction is a fordran on Skatteverket carried on
    // 1513, booked by the same voucher that recognises the sale (the payment
    // voucher under kontantmetoden, the invoice voucher under
    // faktureringsmetoden), and every settlement path records the customer
    // share as the payment row amount. Measuring the outstanding against the
    // gross total therefore left exactly deduction_total "open" on a fully
    // paid invoice and booked it as a phantom 1510 fordran with phantom
    // vilande moms (#2248). deduction_total is stored as a positive magnitude
    // even on a credit note (CHECK >= 0), so it follows the sign of the total.
    const deductionOwn = Math.abs(Number(row.deduction_total ?? 0))
    const customerShareOwn = deductionOwn > 0
      ? roundOre(totalOwn - Math.sign(totalOwn) * deductionOwn)
      : totalOwn
    // A plain invoice keeps the gross computation untouched. On a ROT/RUT
    // invoice the residual is floored at zero on the invoice's own side, the
    // same GREATEST(0, ...) the invoices_remaining_amount_guard trigger
    // applies: an öre of over-collection against a derived customer share is
    // noise, not a fordran the company owes back.
    let outstandingOwn: number
    if (deductionOwn > 0) {
      const residualOwn = roundOre(customerShareOwn - paid)
      outstandingOwn = totalOwn < 0 ? Math.min(0, residualOwn) : Math.max(0, residualOwn)
    } else {
      outstandingOwn = roundOre(totalOwn - paid)
    }
    const outstanding = totalOwn === 0 ? 0 : roundOre(total * (outstandingOwn / totalOwn))
    if (Math.abs(outstanding) < ORE_TOLERANCE) continue

    // Never guess the treatment. Defaulting a 12 %/6 %/undantagen invoice to
    // 25 % would route it to the wrong vilande account AND the wrong revenue
    // account; the moms impact is deferred but the year-end fordran
    // composition would be wrong on the balance sheet. Collect and refuse.
    const treatment = row.vat_treatment as VatTreatment | null
    const reference = (row.invoice_number as string) ?? ''
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
      outstanding,
      vat: scaledVat,
    })
  }

  const payables: CutoffPayable[] = []
  for (const row of supplierInvoices) {
    const sign = row.is_credit_note ? -1 : 1
    const totalOwn = Math.abs(Number(row.total ?? 0)) * sign
    const total = Math.abs(resolveHeaderSek(row, 'total', 'total_sek')) * sign
    const vat = Math.abs(resolveHeaderSek(row, 'vat_amount', 'vat_amount_sek')) * sign
    const paid = paidBySupplierInvoice.get(row.id as string) ?? 0
    const outstandingOwn = roundOre(totalOwn - (paid * sign))
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
      for (const item of items) {
        const rate = resolveReverseChargeRate({
          vat_rate: item.vat_rate == null ? null : Number(item.vat_rate),
          reverse_charge_rate: item.reverse_charge_rate == null
            ? null
            : Number(item.reverse_charge_rate),
        })
        const itemBase = totalOwn === 0
          ? 0
          : roundOre(Math.abs(Number(item.line_total ?? 0)) * Math.abs(total / totalOwn) * ratio)
        const current = groups.get(rate) ?? { base: 0, nonBasisBase: 0 }
        current.base = roundOre(current.base + itemBase)
        if (!isReverseChargeBasisAccount(String(item.account_number ?? ''))) {
          current.nonBasisBase = roundOre(current.nonBasisBase + itemBase)
        }
        groups.set(rate, current)
      }
      reverseChargeGroups = [...groups.entries()].map(([rate, group]) => ({
        rate,
        base: group.base * sign,
        nonBasisBase: group.nonBasisBase * sign,
        supplierType: supplierType as 'eu_business' | 'non_eu_business' | 'swedish_business',
      }))
    }
    payables.push({
      id: row.id as string,
      reference: (row.supplier_invoice_number as string) ?? '',
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
  }

  log.info('collected kontantmetoden cut-off', {
    companyId,
    periodStart,
    periodEnd,
    receivables: receivables.length,
    payables: payables.length,
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

  return { receivables, payables, unknownVatTreatment, strayVatOnZeroRate }
}

export async function assessKontantmetodCutoff(
  supabase: SupabaseClient,
  companyId: string,
  period: { id: string; period_start: string; period_end: string },
  nextFiscalPeriodId: string,
  entityType: EntityType = 'aktiebolag',
): Promise<KontantmetodCutoffAssessment> {
  const collection = sortedCutoffCollection(await collectKontantmetodCutoff(
    supabase,
    companyId,
    period.period_start,
    period.period_end,
  ))
  const lines = buildCutoffLines(collection.receivables, collection.payables, entityType)
  const postings = await inspectKontantmetodCutoffPostings(
    supabase,
    companyId,
    period.id,
    nextFiscalPeriodId,
    period.period_end,
    lines,
  )

  return { collection, lines, postings }
}

export interface PostCutoffResult {
  receivableEntry: JournalEntry | null
  receivableReversal: JournalEntry | null
  payableEntry: JournalEntry | null
  payableReversal: JournalEntry | null
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

/**
 * Assert the vändning can actually be posted BEFORE any cut-off entry exists.
 *
 * The cut-off and its reversal are two verifikat, and the engine gives no
 * cross-entry transaction: if the reversal fails after the cut-off is
 * committed, 1510/2440 stay permanently inflated and every new-year payment
 * double-books. Checking the target period up front turns the common failure
 * (next period missing, closed, or locked) into a refusal that posts nothing,
 * which leaves the compensating storno below as a genuine last resort rather
 * than the expected path.
 */
async function assertReversalPeriodPostable(
  supabase: SupabaseClient,
  companyId: string,
  nextFiscalPeriodId: string,
  reversalDate: string,
): Promise<void> {
  if (!nextFiscalPeriodId) {
    throw new Error(
      'Kontantmetodens bokslutsavgränsning kräver att nästa räkenskapsår är upplagt: vändningen bokas första dagen på det nya året.',
    )
  }

  const { data, error } = await supabase
    .from('fiscal_periods')
    .select('id, period_start, period_end, is_closed, locked_at')
    .eq('id', nextFiscalPeriodId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (error || !data) {
    throw new Error(
      'Kontantmetodens bokslutsavgränsning kräver att nästa räkenskapsår är upplagt: vändningen bokas första dagen på det nya året.',
    )
  }
  if (data.is_closed || data.locked_at) {
    throw new Error(
      'Nästa räkenskapsår är stängt eller låst: vändningen av bokslutsavgränsningen kan inte bokföras. Lås upp perioden och försök igen.',
    )
  }
  if (reversalDate < (data.period_start as string) || reversalDate > (data.period_end as string)) {
    throw new Error(
      `Vändningsdatumet ${reversalDate} ligger utanför nästa räkenskapsår: kontrollera periodernas datum.`,
    )
  }
}

/**
 * Post the cut-off verifikat and their vändningar.
 *
 * Refuses outright unless the vändning can be posted (see
 * assertReversalPeriodPostable) and unless every invoice has a known
 * vat_treatment: a cut-off without its vändning leaves 1510/2440 permanently
 * inflated and makes every new-year payment double-book.
 *
 * If a reversal still fails after its cut-off committed, the cut-off is
 * stornoed through the sanctioned reverseEntry() path (BFL 5 kap 5 §: posted
 * entries are never edited or deleted) so the ledger is left consistent, and
 * the original error is rethrown.
 */
export async function postKontantmetodCutoff(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  opts: {
    fiscalPeriodId: string
    nextFiscalPeriodId: string
    periodEnd: string
    receivables: CutoffReceivable[]
    payables: CutoffPayable[]
    entityType?: EntityType
    /** Refuse if any invoice lacked a vat_treatment (see CutoffCollection). */
    unknownVatTreatment?: string[]
    /** Refuse if any invoice carried moms on a zero-rate treatment. */
    strayVatOnZeroRate?: string[]
  },
): Promise<PostCutoffResult> {
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

  const { receivableLines, payableLines } = buildCutoffLines(
    opts.receivables,
    opts.payables,
    opts.entityType,
  )
  const reversalDate = nextDay(opts.periodEnd)

  const result: PostCutoffResult = {
    receivableEntry: null,
    receivableReversal: null,
    payableEntry: null,
    payableReversal: null,
  }

  if (receivableLines.length === 0 && payableLines.length === 0) return result

  await assertReversalPeriodPostable(supabase, companyId, opts.nextFiscalPeriodId, reversalDate)

  const existing = await inspectKontantmetodCutoffPostings(
    supabase,
    companyId,
    opts.fiscalPeriodId,
    opts.nextFiscalPeriodId,
    opts.periodEnd,
    {
      receivableLines,
      payableLines,
      receivableTotal: receivableLines.reduce((sum, line) => sum + line.debit_amount, 0),
      payableTotal: payableLines.reduce((sum, line) => sum + line.credit_amount, 0),
    },
  )
  if (hasIncompleteKontantmetodCutoffPair(existing, {
    receivableLines,
    payableLines,
    receivableTotal: receivableLines.reduce((sum, line) => sum + line.debit_amount, 0),
    payableTotal: payableLines.reduce((sum, line) => sum + line.credit_amount, 0),
  })) {
    throw new Error(
      'Kontantmetodens bokslutsavgränsning är delvis eller dubbelt bokförd för perioden. Kontrollera och rätta verifikaten innan du försöker igen.',
    )
  }

  if (existing.receivableEntryId && existing.receivableReversalId) {
    result.receivableEntry = { id: existing.receivableEntryId } as JournalEntry
    result.receivableReversal = { id: existing.receivableReversalId } as JournalEntry
  }
  if (existing.payableEntryId && existing.payableReversalId) {
    result.payableEntry = { id: existing.payableEntryId } as JournalEntry
    result.payableReversal = { id: existing.payableReversalId } as JournalEntry
  }

  /**
   * Post a cut-off/vändning pair. On reversal failure the cut-off is stornoed
   * so the pair is all-or-nothing from the ledger's point of view.
   */
  const postPair = async (
    lines: CreateJournalEntryLineInput[],
    label: string,
    references: string[],
  ): Promise<[JournalEntry, JournalEntry]> => {
    const description = label === 'Kundfordringar'
      ? KONTANTMETOD_CUTOFF_DESCRIPTIONS.receivable
      : KONTANTMETOD_CUTOFF_DESCRIPTIONS.payable
    const reversalDescription = label === 'Kundfordringar'
      ? KONTANTMETOD_CUTOFF_DESCRIPTIONS.receivableReversal
      : KONTANTMETOD_CUTOFF_DESCRIPTIONS.payableReversal

    const entry = await createJournalEntry(supabase, companyId, userId, {
      fiscal_period_id: opts.fiscalPeriodId,
      entry_date: opts.periodEnd,
      description,
      source_type: 'year_end',
      source_id: opts.fiscalPeriodId,
      notes: buildCutoffNote(label, references),
      lines,
    })

    try {
      const reversal = await createJournalEntry(supabase, companyId, userId, {
        fiscal_period_id: opts.nextFiscalPeriodId,
        entry_date: reversalDate,
        description: reversalDescription,
        source_type: 'year_end',
        source_id: opts.fiscalPeriodId,
        notes: buildCutoffNote(`Vändning ${label.toLowerCase()}`, references),
        lines: reverseLines(lines),
      })
      return [entry, reversal]
    } catch (reversalError) {
      // Compensate: an un-reversed cut-off is worse than no cut-off at all.
      let stornoId: string | null = null
      try {
        // Storno in the same period as the cut-off so the pair nets to zero
        // inside the year being closed.
        const storno = await reverseEntry(supabase, companyId, userId, entry.id, opts.periodEnd)
        stornoId = storno.id
      } catch (stornoError) {
        log.error(
          'cut-off reversal failed AND the compensating storno failed: 1510/2440 left inflated, manual correction required',
          stornoError as Error,
          { companyId, entryId: entry.id },
        )
      }
      const key = label === 'Kundfordringar' ? 'receivable' : 'payable'
      throw new KontantmetodCutoffPartialError(
        `Vändningen för ${label.toLowerCase()} kunde inte bokföras`,
        {
          [`${key}_entry_id`]: entry.id,
          ...(stornoId ? { [`${key}_storno_entry_id`]: stornoId } : {}),
        },
        reversalError,
      )
    }
  }

  if (receivableLines.length > 0 && !result.receivableEntry) {
    const [entry, reversal] = await postPair(
      receivableLines,
      'Kundfordringar',
      opts.receivables.map((r) => r.reference),
    )
    result.receivableEntry = entry
    result.receivableReversal = reversal
  }

  if (payableLines.length > 0 && !result.payableEntry) {
    try {
      const [entry, reversal] = await postPair(
        payableLines,
        'Leverantörsskulder',
        opts.payables.map((p) => p.reference),
      )
      result.payableEntry = entry
      result.payableReversal = reversal
    } catch (err) {
      const completedIds = {
        ...(result.receivableEntry ? { receivable_entry_id: result.receivableEntry.id } : {}),
        ...(result.receivableReversal
          ? { receivable_reversal_entry_id: result.receivableReversal.id }
          : {}),
      }
      if (Object.keys(completedIds).length === 0) throw err
      if (err instanceof KontantmetodCutoffPartialError) {
        throw new KontantmetodCutoffPartialError(
          err.message,
          { ...completedIds, ...err.postedIds },
          err.cause,
        )
      }
      throw new KontantmetodCutoffPartialError(
        'Leverantörsskuldernas bokslutsavgränsning kunde inte slutföras',
        completedIds,
        err,
      )
    }
  }

  return result
}
