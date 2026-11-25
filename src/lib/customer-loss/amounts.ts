/**
 * Pure arithmetic for kundförlust (build spec 4.2 rows F, F2, G and H).
 *
 * Every amount is SEK and comes from the ledger: the invoice's own posted
 * voucher (the one invoices.journal_entry_id names) and the vouchers of its
 * credit notes. The open part of the claim is invoices.remaining_amount,
 * checked against those vouchers before anything is booked; where the issue
 * verifikat booked the öresavrundning (1510 at the rounded "Att betala"), the
 * claim on 151x is that much more (openReceivable).
 *
 * - The VAT share of the open part is taken per output VAT account, pro rata
 *   to the open part of the receivable: a partial payment paid the same
 *   proportion of every rate. Reverse charge, export and VAT-exempt invoices
 *   have no output VAT line, so their share is zero. ML 8 kap 16 § reduces
 *   the beskattningsunderlag only by what was not received.
 * - The ruta 05 base of each share is the share at its rate (vat * 100 /
 *   rate, to the öre). Ruta 05 is declared in whole kronor, so the öre
 *   rounding of a derived base never reaches the declaration.
 * - The befarad reserve is the open part net of its VAT (BAS practice: the
 *   reserve covers the receivable excluding VAT; VAT moves only once the loss
 *   is konstaterad).
 */
import { bookedOreRounding } from '@/lib/bookkeeping/ore-rounding'
import { ACCOUNT_RUTA } from '@/lib/reports/vat-declaration'
import { roundOre, sumOre } from '@/lib/money'
import type { CreateJournalEntryLineInput } from '@/types'

/** One output VAT share, as stored in invoice_write_offs.vat_by_rate. */
export interface VatShare {
  /** The output VAT account the invoice credited (2611, 2621, 2631, ...). */
  account: string
  /** 25, 12 or 6. */
  rate: number
  vat: number
  /** The beskattningsunderlag the share belongs to (ruta 05). */
  base: number
}

export interface LedgerLine {
  account_number: string
  debit_amount: number | string | null
  credit_amount: number | string | null
}

const RATE_BY_BOX: Record<string, number> = { ruta10: 25, ruta11: 12, ruta12: 6 }

/**
 * The rate of an output VAT account on domestic sales (rutorna 10 to 12), or
 * null for any other account. Read from the momsdeklaration's own mapping so
 * the two can never disagree.
 */
export function outputVatRate(account: string): number | null {
  const mapping = ACCOUNT_RUTA[account]
  if (!mapping || mapping.side !== 'credit') return null
  return RATE_BY_BOX[mapping.box] ?? null
}

/** Kundfordringar on the invoice's own voucher: 151x except 1513 (Skatteverket's share) and 1519 (the reserve). */
export function isReceivableAccount(account: string): boolean {
  return /^151\d$/.test(account) && account !== '1513' && account !== '1519'
}

const n = (v: number | string | null | undefined): number => Number(v ?? 0) || 0

/**
 * Output VAT per account still standing on the invoice: the credits on the
 * invoice's voucher minus the debits its credit notes booked back.
 */
export function openVatByAccount(invoiceLines: LedgerLine[], creditNoteLines: LedgerLine[]): Map<string, number> {
  const out = new Map<string, number>()
  const add = (account: string, amount: number) => out.set(account, roundOre((out.get(account) ?? 0) + amount))
  for (const line of invoiceLines) {
    if (outputVatRate(line.account_number) === null) continue
    add(line.account_number, n(line.credit_amount) - n(line.debit_amount))
  }
  for (const line of creditNoteLines) {
    if (outputVatRate(line.account_number) === null) continue
    add(line.account_number, n(line.credit_amount) - n(line.debit_amount))
  }
  for (const [account, amount] of out) if (amount <= 0) out.delete(account)
  return out
}

/** The receivable the invoice put on 151x, less what its credit notes took off. */
export function receivableBasis(invoiceLines: LedgerLine[], creditNoteLines: LedgerLine[]): number {
  let total = 0
  for (const line of [...invoiceLines, ...creditNoteLines]) {
    if (!isReceivableAccount(line.account_number)) continue
    total += n(line.debit_amount) - n(line.credit_amount)
  }
  return roundOre(total)
}

/**
 * What 151x still carries for the open claim, or null when the ledger and the
 * invoice disagree. The receivable less what was paid is the remaining
 * amount, or the remaining amount and the öresavrundning the issue verifikat
 * booked: 1510 at the rounded "Att betala" and the öre on 3740
 * (bookedOreRounding). A gap of a krona or more is no rounding.
 *
 *   999,75 kr issued as 1 000 on 1510, unpaid:  1 000
 *   the same after a payment of 500:              500
 *   1 250 kr with 1 000 left on the invoice:     null
 */
export function openReceivable(basis: number, paid: number, remaining: number): number | null {
  const carried = roundOre(basis - paid)
  if (carried === roundOre(remaining)) return carried
  return bookedOreRounding(remaining, carried) !== 0 ? carried : null
}

/** Whether the invoice's own voucher put a receivable on 151x (the booked-branch rule, build spec 4.2 F). */
export function reachedLedgerAsReceivable(invoiceLines: LedgerLine[]): boolean {
  return invoiceLines.some((line) => isReceivableAccount(line.account_number) && n(line.debit_amount) > 0)
}

function baseOf(vat: number, rate: number): number {
  return roundOre((vat * 100) / rate)
}

/**
 * The VAT share of `part` of a claim whose receivable is `basis` with `openVat`
 * per account. A share is rounded to the öre per account; the net side takes
 * whatever is left, so the voucher always balances.
 */
export function vatSharesOfPart(openVat: Map<string, number>, basis: number, part: number): VatShare[] {
  if (basis <= 0 || part <= 0) return []
  const ratio = Math.min(part, basis) / basis
  const shares: VatShare[] = []
  for (const [account, vat] of [...openVat.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const rate = outputVatRate(account)
    if (rate === null) continue
    const share = part >= basis ? vat : roundOre(vat * ratio)
    if (share <= 0) continue
    shares.push({ account, rate, vat: share, base: baseOf(share, rate) })
  }
  return shares
}

export function totalVat(shares: VatShare[]): number {
  return sumOre(shares.map((s) => s.vat))
}

/** A write-off row as the arithmetic needs it. */
export interface WriteOffRowLike {
  id: string
  kind: 'doubtful' | 'reversed_doubtful' | 'confirmed' | 'recovered' | 'annulled'
  amount: number | string
  net_amount: number | string
  vat_amount: number | string
  vat_by_rate: VatShare[] | null
  reserve_released: number | string
  reverses_id: string | null
  journal_entry_id: string | null
  decided_at: string
}

/** The rows still standing: every row that is neither an annulment nor annulled. */
export function liveRows<T extends WriteOffRowLike>(rows: T[]): T[] {
  const annulled = new Set(rows.filter((r) => r.kind === 'annulled').map((r) => r.reverses_id))
  return rows.filter((r) => r.kind !== 'annulled' && !annulled.has(r.id))
}

/** The befarad reserve still on 1519 for the invoice. */
export function reserveOutstanding(rows: WriteOffRowLike[]): number {
  let total = 0
  for (const row of liveRows(rows)) {
    if (row.kind === 'doubtful') total += n(row.net_amount)
    else if (row.kind === 'reversed_doubtful') total -= n(row.net_amount)
    else if (row.kind === 'confirmed') total -= n(row.reserve_released)
  }
  return Math.max(0, roundOre(total))
}

/** The reserve a still-open part of the claim calls for: the part net of its VAT. */
export function reserveTarget(openVat: Map<string, number>, basis: number, remaining: number): number {
  if (remaining <= 0) return 0
  return roundOre(remaining - totalVat(vatSharesOfPart(openVat, basis, remaining)))
}

/** The live konstaterad decision, if the invoice is written off. */
export function liveConfirmed<T extends WriteOffRowLike>(rows: T[]): T | null {
  return liveRows(rows).find((r) => r.kind === 'confirmed') ?? null
}

/**
 * The VAT share of a recovery of `amount` on a written-off claim: pro rata to
 * the written-off VAT per account, and the exact remainder when the
 * recoveries reach the written-off amount, so every recovery together
 * reports back exactly the VAT the write-off took off, per rate, to the öre.
 */
export function recoveryShares(
  confirmed: WriteOffRowLike,
  priorRecoveries: WriteOffRowLike[],
  amount: number,
): { shares: VatShare[]; left: number } {
  const writtenOff = n(confirmed.amount)
  const recovered = sumOre(priorRecoveries.map((r) => n(r.amount)))
  const left = roundOre(writtenOff - recovered)
  if (amount <= 0 || writtenOff <= 0) return { shares: [], left }
  const prior = new Map<string, number>()
  for (const row of priorRecoveries) {
    for (const s of row.vat_by_rate ?? []) prior.set(s.account, roundOre((prior.get(s.account) ?? 0) + n(s.vat)))
  }
  const closes = roundOre(amount - left) >= 0
  const shares: VatShare[] = []
  for (const s of confirmed.vat_by_rate ?? []) {
    const remainingVat = roundOre(n(s.vat) - (prior.get(s.account) ?? 0))
    const vat = closes ? remainingVat : Math.min(remainingVat, roundOre((n(s.vat) * amount) / writtenOff))
    if (vat <= 0) continue
    shares.push({ account: s.account, rate: s.rate, vat, base: baseOf(vat, s.rate) })
  }
  return { shares, left }
}

// ---------------------------------------------------------------------------
// Voucher lines
// ---------------------------------------------------------------------------

const line = (
  account: string,
  debit: number,
  credit: number,
  description: string,
): CreateJournalEntryLineInput => ({
  account_number: account,
  debit_amount: roundOre(debit),
  credit_amount: roundOre(credit),
  line_description: description,
})

/** F: Dr 6352 / Cr 1519. */
export function doubtfulLines(reserve: number, tag: string): CreateJournalEntryLineInput[] {
  return [
    line('6352', reserve, 0, `Befarad kundförlust faktura ${tag}`),
    line('1519', 0, reserve, `Befarad kundförlust faktura ${tag}`),
  ]
}

/** F2: Dr 1519 / Cr 6352. */
export function reserveReleaseLines(release: number, tag: string): CreateJournalEntryLineInput[] {
  return [
    line('1519', release, 0, `Återförd befarad kundförlust faktura ${tag}`),
    line('6352', 0, release, `Återförd befarad kundförlust faktura ${tag}`),
  ]
}

/** G: Dr 6351 (net) + Dr 26xx per account / Cr 1510, plus the reserve back. */
export function confirmedLines(params: {
  amount: number
  shares: VatShare[]
  reserve: number
  receivableAccount: string
  tag: string
}): CreateJournalEntryLineInput[] {
  const { amount, shares, reserve, receivableAccount, tag } = params
  const net = roundOre(amount - totalVat(shares))
  const out: CreateJournalEntryLineInput[] = []
  if (net > 0) out.push(line('6351', net, 0, `Konstaterad kundförlust faktura ${tag}`))
  for (const s of shares) out.push(line(s.account, s.vat, 0, `Minskad utgående moms ${s.rate} % kundförlust faktura ${tag}`))
  out.push(line(receivableAccount, 0, amount, `Konstaterad kundförlust faktura ${tag}`))
  if (reserve > 0) out.push(...reserveReleaseLines(reserve, tag))
  return out
}

/** H: Dr payment account / Cr 3950 (net) + Cr 26xx per account. */
export function recoveryLines(params: {
  amount: number
  shares: VatShare[]
  paymentAccount: string
  tag: string
}): CreateJournalEntryLineInput[] {
  const { amount, shares, paymentAccount, tag } = params
  const net = roundOre(amount - totalVat(shares))
  const out: CreateJournalEntryLineInput[] = [line(paymentAccount, amount, 0, `Återvunnen kundförlust faktura ${tag}`)]
  if (net > 0) out.push(line('3950', 0, net, `Återvunnen kundförlust faktura ${tag}`))
  for (const s of shares) out.push(line(s.account, 0, s.vat, `Utgående moms ${s.rate} % återvunnen kundförlust faktura ${tag}`))
  return out
}
