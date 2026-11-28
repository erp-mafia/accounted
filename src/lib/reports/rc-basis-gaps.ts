import type { SupabaseClient } from '@supabase/supabase-js'
import {
  compareById,
  fetchEntriesWithAccountLines,
  fetchEntryLines,
  fetchLinesByEntryIds,
  type EntryLinesQuery,
} from '@/lib/bookkeeping/entry-lines'
import { isReverseChargeBasisAccount, RC_BASIS_BOXES, RC_BASIS_OFFSET_ACCOUNT } from '@/lib/bookkeeping/vat-entries'
import { roundOre } from '@/lib/money'
import { resolvePeriodDates } from './vat-declaration'
import { RC_BASIS_ACCOUNTS_BY_RATE } from './vat-filing-gate'
import { fetchDynamicVatAccounts, type DynamicVatAccounts } from './vat-revenue-accounts'
import type { VatPeriodType } from '@/types'

/**
 * Per-voucher detection of FK004: reverse-charge output VAT booked
 * (2614/2624/2634) without a matching basbelopp pair on 44xx/45xx.
 *
 * Used by the momsdeklaration UI to give the user a concrete list of
 * verifikationer to correct, rather than a generic "ruta 30-32 utan
 * ruta 20-24" warning that doesn't tell them what to fix.
 *
 * The per-verifikat rule (readVerifikatRcBasis, isRcBasisGap) is exported
 * because the worklist's Korrigera route reads the verifikat again with it
 * at correction time: the row is a snapshot, and a basis the verifikat
 * already reports must not be added twice (crm#1096).
 */

const RC_OUTPUT_ACCOUNTS = ['2614', '2624', '2634'] as const
type RcOutputAccount = typeof RC_OUTPUT_ACCOUNTS[number]

// EU goods (4515-4517), non-EU services (4531-4533), EU services (4535-4537),
// domestic goods RC (4415-4417), domestic services RC (4425-4427). Derived
// from the rate-grouped single source in vat-filing-gate.ts so this scan and
// the per-rate downgrade evidence can never disagree on the account set.
const STATIC_RC_BASIS_RATE = new Map<string, number>([
  ...RC_BASIS_ACCOUNTS_BY_RATE.r25.map((account) => [account, 0.25] as const),
  ...RC_BASIS_ACCOUNTS_BY_RATE.r12.map((account) => [account, 0.12] as const),
  ...RC_BASIS_ACCOUNTS_BY_RATE.r6.map((account) => [account, 0.06] as const),
])

const RATE_BY_OUTPUT: Record<RcOutputAccount, number> = {
  '2614': 0.25,
  '2624': 0.12,
  '2634': 0.06,
}

/**
 * The scan's tolerance in kronor: fiktiv moms at or below it is ignored, and
 * a momssats is a gap only when its basis falls short by more than it. The
 * filing gate's per-rate identity uses the same 0.5 kr.
 */
export const RC_BASIS_TOLERANCE = 0.5

/**
 * The source_type of the app's momsredovisning verifikat (the reviewed
 * settlement proposal, VAT booking templates). It clears 2614/2624/2634 into
 * 2650 and is no purchase, so it has no basis of its own, and the declaration
 * leaves it out of the rutor (fetchVatAccountTotals). The scan and the
 * Korrigera route leave it out too: a period whose reverse-charge credit notes
 * outweigh its purchases leaves 2614 in debit, the settlement credits it, and
 * that credit read as fiktiv moms without basis (crm#1766).
 */
export const RC_BASIS_SKIPPED_SOURCE_TYPE = 'vat_settlement'

/**
 * The declaration's account resolution as the basis is read with it
 * (fetchDynamicVatAccounts): the accounts with a configured momskod, the box
 * each one feeds, and the momssats the filing gate buckets its basis at.
 */
export type RcBasisAccounts = Pick<
  DynamicVatAccounts,
  'explicitAccounts' | 'mappingByAccount' | 'rcBasisRateByAccount'
>

/**
 * How the declaration reads a line on `account` as the basis of a
 * reverse-charge purchase, by the rule the filing gate buckets the basis with
 * (rcBasisTotalsByRate):
 *  - the momssats it is bucketed at: a configured account's own, otherwise a
 *    static BAS basis account's (4536 is 12 %);
 *  - 'unrated' for an account whose momskod puts it in ruta 20-24 while its
 *    momssats is none of 25, 12 and 6 %. The declaration counts the box but
 *    the gate buckets no basis there, so nothing pairs it with fiktiv moms:
 *    a configuration error that only the kontoplan can fix;
 *  - null for any other account.
 */
export function rcBasisReading(account: string, accounts: RcBasisAccounts): number | 'unrated' | null {
  if (!accounts.explicitAccounts.has(account)) return STATIC_RC_BASIS_RATE.get(account) ?? null
  const rate = accounts.rcBasisRateByAccount.get(account)
  if (rate !== undefined) return rate
  const box = accounts.mappingByAccount.get(account)?.box
  return box !== undefined && RC_BASIS_BOXES.has(box) ? 'unrated' : null
}

/** One momssats of a verifikat, as the scan reads it. */
export interface RcBasisAtRate {
  rcOutputAccount: RcOutputAccount
  rate: number
  /** Net fiktiv moms credited on the output account (ruta 30, 31 or 32). */
  rcOutputAmount: number
  /** The basis that fiktiv moms implies: moms / sats, to the öre. */
  expectedBasisAmount: number
  /** Net basis the verifikat reports at this momssats (rcBasisReading). */
  reportedBasisAmount: number
}

export interface VerifikatRcBasis {
  /** 2614, 2624 and 2634 in that order, zeros included. */
  rates: RcBasisAtRate[]
  /** Accounts with a non-zero net in the verifikat whose basis is 'unrated', sorted. */
  unratedAccounts: string[]
}

type LineAmounts = {
  account_number: string
  debit_amount: number | string | null
  credit_amount: number | string | null
}

/** One verifikat's fiktiv moms and basis per momssats, from all of its lines. */
export function readVerifikatRcBasis(
  lines: ReadonlyArray<LineAmounts>,
  accounts: RcBasisAccounts,
): VerifikatRcBasis {
  const output = new Map<string, number>()
  const basis = new Map<number, number>()
  const unrated = new Map<string, number>()
  for (const line of lines) {
    const debitNet = (Number(line.debit_amount) || 0) - (Number(line.credit_amount) || 0)
    const account = line.account_number
    if ((RC_OUTPUT_ACCOUNTS as readonly string[]).includes(account)) {
      output.set(account, roundOre((output.get(account) ?? 0) - debitNet))
      continue
    }
    const reading = rcBasisReading(account, accounts)
    if (reading === 'unrated') unrated.set(account, roundOre((unrated.get(account) ?? 0) + debitNet))
    else if (reading !== null) basis.set(reading, roundOre((basis.get(reading) ?? 0) + debitNet))
  }
  return {
    rates: RC_OUTPUT_ACCOUNTS.map((rcOutputAccount) => {
      const rate = RATE_BY_OUTPUT[rcOutputAccount]
      const rcOutputAmount = output.get(rcOutputAccount) ?? 0
      return {
        rcOutputAccount,
        rate,
        rcOutputAmount,
        expectedBasisAmount: roundOre(rcOutputAmount / rate),
        reportedBasisAmount: basis.get(rate) ?? 0,
      }
    }),
    unratedAccounts: [...unrated].filter(([, net]) => net !== 0).map(([account]) => account).sort(),
  }
}

/** The scan's verdict on one momssats: fiktiv moms whose basis falls short. */
export function isRcBasisGap(rate: RcBasisAtRate): boolean {
  return (
    rate.rcOutputAmount > RC_BASIS_TOLERANCE &&
    rate.reportedBasisAmount + RC_BASIS_TOLERANCE < rate.expectedBasisAmount
  )
}

/** What a momssats lacks: the basis its fiktiv moms implies less the basis reported at it. */
export function missingRcBasis(rate: RcBasisAtRate): number {
  return roundOre(rate.expectedBasisAmount - rate.reportedBasisAmount)
}

/** A verifikat whose lines declare one reverse-charge purchase twice in rutor 20-24 (rcBasisCountedTwice). */
export interface RcBasisCountedTwice {
  /** Debited accounts that report their own ruta 20-24 and are no BAS basis account (6541 with its momskod), sorted. */
  ownRutaAccounts: string[]
  /** Debited BAS basis accounts (44xx/45xx), sorted. */
  basisAccounts: string[]
  /** Net basis the lines report in rutor 20-24, every momssats together. */
  reportedBasisAmount: number
  /** The basis the lines' fiktiv moms is computed on (moms / sats, summed). */
  expectedBasisAmount: number
}

/**
 * The mirror of isRcBasisGap: lines that report MORE basis than their fiktiv
 * moms is computed on, because a 45xx/4598 basis pair sits beside a line on
 * an account that reports ruta 20-24 itself (a cost account whose kontoplan
 * momskod is a reverse-charge purchase, 6541 set to EU services, or a BAS
 * basis account booked as the cost, 4531). Each puts the same base in rutor
 * 20-24, so the momsdeklaration counts the purchase twice while ruta 30-32
 * counts its moms once. The producers never book this (reverseChargeOnAccount
 * leaves the pair out on such an account); typed lines can.
 *
 * Read with the declaration's own account reading (rcBasisReading), and only
 * when the lines tell how large the purchase is and that a pair is there:
 *  - fiktiv moms credited on 2614/2624/2634 (moms / sats is the purchase):
 *    without it a basis line cannot be told from a basis-only correction or
 *    an omföring between boxes;
 *  - 4598 credited: the pair's offset;
 *  - the basis reported exceeds both what the fiktiv moms is computed on and
 *    the pair's own amount: some line besides the pair reports a box itself.
 *
 * Two purchases in one verifikat, one on an account with its own ruta and one
 * with the pair, report exactly what their fiktiv moms is computed on and are
 * not flagged. Summed over the momssatser, not per sats: an account with its
 * own ruta at another sats than the pair still declares the purchase a second
 * time. Purchases only (fiktiv moms credited), as isRcBasisGap.
 */
export function rcBasisCountedTwice(
  lines: ReadonlyArray<LineAmounts>,
  accounts: RcBasisAccounts,
): RcBasisCountedTwice | null {
  let pairOffset = 0
  let reported = 0
  const reportedByAccount = new Map<string, number>()
  for (const line of lines) {
    const debitNet = (Number(line.debit_amount) || 0) - (Number(line.credit_amount) || 0)
    const account = line.account_number
    if (account === RC_BASIS_OFFSET_ACCOUNT) {
      pairOffset = roundOre(pairOffset - debitNet)
      continue
    }
    if (rcBasisReading(account, accounts) === null) continue
    reported = roundOre(reported + debitNet)
    reportedByAccount.set(account, roundOre((reportedByAccount.get(account) ?? 0) + debitNet))
  }
  if (pairOffset <= RC_BASIS_TOLERANCE) return null

  const expected = roundOre(
    readVerifikatRcBasis(lines, accounts).rates
      .filter((rate) => rate.rcOutputAmount > RC_BASIS_TOLERANCE)
      .reduce((sum, rate) => sum + rate.expectedBasisAmount, 0),
  )
  if (expected <= 0) return null
  if (reported <= expected + RC_BASIS_TOLERANCE || reported <= pairOffset + RC_BASIS_TOLERANCE) return null

  const debited = [...reportedByAccount].filter(([, net]) => net > 0).map(([account]) => account).sort()
  const basisAccounts = debited.filter((account) => isReverseChargeBasisAccount(account))
  // A 4598 credit is a pair only beside a debited basis account (44xx/45xx):
  // without one, nothing reports the purchase a second time, and an
  // understated fiktiv moms is the gap rule's business, not this one's.
  if (basisAccounts.length === 0) return null
  return {
    ownRutaAccounts: debited.filter((account) => !isReverseChargeBasisAccount(account)),
    basisAccounts,
    reportedBasisAmount: reported,
    expectedBasisAmount: expected,
  }
}

export interface RcBasisGap {
  entryId: string
  voucherNumber: number
  voucherSeries: string
  entryDate: string
  description: string
  rcOutputAccount: RcOutputAccount
  rcOutputAmount: number
  expectedBasisAmount: number
  /** The part of expectedBasisAmount the verifikat does not report: what Korrigera adds. */
  missingBasisAmount: number
  rate: number
}

interface RcLineRow {
  journal_entry_id: string
  account_number: string
  debit_amount: number
  credit_amount: number
  // Supabase typings unpredictably model joined relations as either an object
  // or an array depending on the FK; we accept both and normalize below.
  journal_entries:
    | {
        id: string
        voucher_number: number
        voucher_series: string
        entry_date: string
        description: string
      }
    | {
        id: string
        voucher_number: number
        voucher_series: string
        entry_date: string
        description: string
      }[]
}

interface EntryFields {
  id: string
  voucher_number: number
  voucher_series: string
  entry_date: string
  description: string
}

function pickEntry(row: RcLineRow): EntryFields | null {
  const j = row.journal_entries
  if (Array.isArray(j)) return j.length > 0 ? j[0] : null
  return j ?? null
}

interface SiblingLineRow {
  id: string
  journal_entry_id: string
  account_number: string
  debit_amount: number
  credit_amount: number
}

/**
 * The posted verifikat of the period with a line on 2614/2624/2634, the
 * momsredovisning (RC_BASIS_SKIPPED_SOURCE_TYPE) left out: their fiktiv moms
 * lines with the verifikat attached (rcLines) and every line of them
 * (siblingLines), each sorted by line id.
 *
 * One get_entries_with_account_lines call, which reads only the days the
 * output accounts moved. The two-step read below (every posted entry of the
 * period, then its lines in chunks of 100 ids; see
 * lib/bookkeeping/entry-lines.ts) gives the same lists for a database
 * without the function yet.
 */
async function fetchRcVerifikat(
  supabase: SupabaseClient,
  companyId: string,
  start: string,
  end: string,
): Promise<{ rcLines: RcLineRow[]; siblingLines: SiblingLineRow[] }> {
  const allRows = await fetchEntriesWithAccountLines(supabase, companyId, {
    start,
    end,
    accounts: RC_OUTPUT_ACCOUNTS,
    statuses: ['posted'],
    allLines: true,
  })
  if (allRows) {
    const rows = allRows.filter((row) => row.source_type !== RC_BASIS_SKIPPED_SOURCE_TYPE)
    const entryById = new Map(rows.map((row) => [row.id, {
      id: row.id,
      voucher_number: row.voucher_number,
      voucher_series: row.voucher_series as string,
      entry_date: row.entry_date,
      description: row.description,
      status: row.status,
      company_id: companyId,
    }]))
    const siblingLines = rows
      .flatMap((row) => row.lines.map((line) => ({
        id: line.id,
        journal_entry_id: row.id,
        account_number: line.account_number,
        debit_amount: line.debit_amount as number,
        credit_amount: line.credit_amount as number,
      })))
      .sort(compareById)
    const rcLines = siblingLines
      .filter((line) => (RC_OUTPUT_ACCOUNTS as readonly string[]).includes(line.account_number))
      .map((line) => ({ ...line, journal_entries: entryById.get(line.journal_entry_id)! }))
    return { rcLines, siblingLines }
  }

  // Two-step entry-lines fetch (see lib/bookkeeping/entry-lines.ts).
  const rcLines = (await fetchEntryLines<unknown>({
    supabase,
    entryColumns:
      'id, voucher_number, voucher_series, entry_date, description, status, company_id',
    lineColumns: 'journal_entry_id, account_number, debit_amount, credit_amount',
    filterEntries: (q: EntryLinesQuery) =>
      q
        .eq('company_id', companyId)
        .eq('status', 'posted')
        // source_type is NOT NULL, so neq drops only the momsredovisning.
        .neq('source_type', RC_BASIS_SKIPPED_SOURCE_TYPE)
        .gte('entry_date', start)
        .lte('entry_date', end),
    filterLines: (q: EntryLinesQuery) =>
      q.in('account_number', RC_OUTPUT_ACCOUNTS as unknown as string[]),
  })) as RcLineRow[]
  if (rcLines.length === 0) return { rcLines, siblingLines: [] }

  const siblingLines = await fetchLinesByEntryIds<SiblingLineRow>(
    supabase,
    [...new Set(rcLines.map((l) => l.journal_entry_id))],
    'id, journal_entry_id, account_number, debit_amount, credit_amount',
  )
  return { rcLines, siblingLines }
}

export async function findRcBasisGaps(
  supabase: SupabaseClient,
  companyId: string,
  periodType: VatPeriodType,
  year: number,
  period: number,
  options: { fiscalPeriodId?: string } = {},
): Promise<RcBasisGap[]> {
  // Same period resolution as the declaration itself: helårsmoms covers the
  // räkenskapsår, not the calendar year, so a calendar span would hide gap
  // vouchers from the tail of an extended/broken fiscal year while the
  // declaration totals (and the aggregate check) still include them.
  const { start, end } = await resolvePeriodDates(
    supabase, companyId, periodType, year, period, options.fiscalPeriodId
  )
  const dynamicVatAccounts = await fetchDynamicVatAccounts(supabase, companyId)
  const { rcLines, siblingLines } = await fetchRcVerifikat(supabase, companyId, start, end)

  if (rcLines.length === 0) return []

  // The verifikat behind the fiktiv moms lines; each is read whole below.
  const entries = new Map<string, EntryFields>()
  for (const line of rcLines) {
    if (entries.has(line.journal_entry_id)) continue
    const entry = pickEntry(line)
    if (entry) entries.set(line.journal_entry_id, entry)
  }

  const linesByEntry = new Map<string, SiblingLineRow[]>()
  for (const line of siblingLines) {
    const lines = linesByEntry.get(line.journal_entry_id)
    if (lines) lines.push(line)
    else linesByEntry.set(line.journal_entry_id, [line])
  }

  // One row per momssats that falls short: a voucher may carry fiktiv moms at
  // two sats, and a basis at one sats never covers moms at another.
  const gaps: RcBasisGap[] = []
  for (const [entryId, entry] of entries) {
    const { rates } = readVerifikatRcBasis(linesByEntry.get(entryId) ?? [], dynamicVatAccounts)
    for (const rate of rates) {
      if (!isRcBasisGap(rate)) continue
      gaps.push({
        entryId,
        voucherNumber: entry.voucher_number,
        voucherSeries: entry.voucher_series,
        entryDate: entry.entry_date,
        description: entry.description,
        rcOutputAccount: rate.rcOutputAccount,
        rcOutputAmount: rate.rcOutputAmount,
        expectedBasisAmount: rate.expectedBasisAmount,
        missingBasisAmount: missingRcBasis(rate),
        rate: rate.rate,
      })
    }
  }

  gaps.sort((a, b) => {
    if (a.voucherSeries !== b.voucherSeries) {
      return a.voucherSeries.localeCompare(b.voucherSeries)
    }
    return a.voucherNumber - b.voucherNumber
  })

  return gaps
}
