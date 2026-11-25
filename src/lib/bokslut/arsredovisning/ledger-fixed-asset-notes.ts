/**
 * Fixed-asset notes read from the ledger where the asset register does not
 * reach (ÅRL 5 kap. 8 §):
 *   - finansiella anläggningstillgångar (BAS 13xx): per balance sheet post,
 *     the anskaffningsvärde at the start of the year, what came in and went
 *     out, and the accumulated nedskrivningar with the year's change;
 *   - nedskrivningar of immateriella and materiella anläggningstillgångar
 *     (the "Ackumulerade nedskrivningar" accounts 10x8-12x8) that were
 *     booked OUTSIDE the anläggningsregister: by hand, or before Accounted.
 *     A write-down posted through the register is in the register
 *     roll-forward (anlaggningstillgangar-note.ts); here each account shows
 *     only what the register did not book (registerWriteDownsByAccount),
 *     so no nedskrivning is disclosed twice (ÅRL 5 kap. 8 § p. 5).
 *
 * Pure, from the year's FULL trial balance. An account is an impairment
 * account when its name says so ("nedskrivning"), as in BAS (1018, 1118,
 * 1318, 1369, ...): the register cannot carry these and the chart is the
 * only source that names them.
 */
import { K2_BR_MAPPINGS, k2BrSectionForAccount } from '@/lib/bokslut/ixbrl/k2-mapper'
import type { WriteDownMovement } from '@/lib/bokslut/assets/value-adjustments'
import { roundOre } from '@/lib/money'
import type { TrialBalanceRow } from '@/types'
import type { NoteEntry } from './types'
import { formatNoteKronor } from './pdf-format'

type Row = Pick<
  TrialBalanceRow,
  'account_number' | 'account_name' | 'opening_debit' | 'opening_credit' | 'period_debit' | 'period_credit' | 'closing_debit' | 'closing_credit'
>

const POST_LABELS: Record<string, string> = {
  AndelarKoncernforetag: 'Andelar i koncernföretag',
  FordringarKoncernforetagLangfristiga: 'Fordringar hos koncernföretag',
  AndelarIntresseforetagGemensamtStyrdaForetag: 'Andelar i intresseföretag och gemensamt styrda företag',
  FordringarIntresseforetagGemensamtStyrdaForetagLangfristiga: 'Fordringar hos intresseföretag och gemensamt styrda företag',
  AgarintressenOvrigaForetag: 'Ägarintressen i övriga företag',
  FordringarOvrigaForetagAgarintresseLangfristiga: 'Fordringar hos övriga företag som det finns ett ägarintresse i',
  AndraLangfristigaVardepappersinnehav: 'Andra långfristiga värdepappersinnehav',
  LanDelagareNarstaende: 'Lån till delägare eller närstående',
  AndraLangfristigaFordringar: 'Andra långfristiga fordringar',
}

const IMPAIRMENT_NAME = /nedskrivning/i

/**
 * Uppskjuten skattefordran (1370-1379) is a post of its own under K3 and is
 * disclosed with deferred tax (K3 kapitel 29), not as a holding.
 */
function isDeferredTaxAsset(account: string): boolean {
  return account >= '1370' && account <= '1379'
}

function isImpairment(row: Row): boolean {
  return IMPAIRMENT_NAME.test(row.account_name ?? '')
}

function moved(row: Row): boolean {
  return [row.opening_debit, row.opening_credit, row.period_debit, row.period_credit].some((n) => Math.abs(n || 0) >= 0.005)
}

const net = (debit: number | undefined, credit: number | undefined) => (debit || 0) - (credit || 0)

interface Movement {
  opening: number
  increase: number
  decrease: number
  closing: number
}

function sumMovement(rows: Row[]): Movement {
  return rows.reduce<Movement>(
    (acc, row) => ({
      opening: acc.opening + net(row.opening_debit, row.opening_credit),
      increase: acc.increase + (row.period_debit || 0),
      decrease: acc.decrease - (row.period_credit || 0),
      closing: acc.closing + net(row.closing_debit, row.closing_credit),
    }),
    { opening: 0, increase: 0, decrease: 0, closing: 0 },
  )
}

const fmt = (n: number) => `${formatNoteKronor(n)} kr`

/** The note on finansiella anläggningstillgångar, or null when the year has none. */
export function buildFinancialFixedAssetsNote(rows: readonly Row[], noteNumber: number): NoteEntry | null {
  const financial = rows.filter(
    (row) =>
      k2BrSectionForAccount(row.account_number, 'aktiebolag') === 'finansiellaAnlaggningstillgangar'
      && !isDeferredTaxAsset(row.account_number)
      && moved(row),
  )
  if (financial.length === 0) return null
  const blocks: string[] = []
  for (const mapping of K2_BR_MAPPINGS) {
    const label = POST_LABELS[mapping.concept]
    if (!label) continue
    const inPost = financial.filter((row) =>
      mapping.ranges.some((range) => row.account_number >= range.start && row.account_number <= range.end),
    )
    if (inPost.length === 0) continue
    const cost = sumMovement(inPost.filter((row) => !isImpairment(row)))
    const impairment = sumMovement(inPost.filter(isImpairment))
    const lines = [
      label,
      `  Ingående anskaffningsvärde: ${fmt(cost.opening)}`,
      `  Tillkommande: ${fmt(cost.increase)}`,
      `  Avgående: ${fmt(cost.decrease)}`,
      `  Utgående anskaffningsvärde: ${fmt(cost.closing)}`,
    ]
    if (impairment.opening !== 0 || impairment.increase !== 0 || impairment.decrease !== 0) {
      lines.push(
        `  Ingående nedskrivningar: ${fmt(impairment.opening)}`,
        `  Årets nedskrivningar: ${fmt(impairment.decrease)}`,
        `  Återförda och avgående nedskrivningar: ${fmt(impairment.increase)}`,
        `  Utgående nedskrivningar: ${fmt(impairment.closing)}`,
      )
    }
    lines.push(`  Utgående redovisat värde: ${fmt(cost.closing + impairment.closing)}`)
    blocks.push(lines.join('\n'))
  }
  if (blocks.length === 0) return null
  return { number: noteNumber, title: 'Finansiella anläggningstillgångar', body: blocks.join('\n\n') }
}

/** What the register booked on one write-down account in the year, by account number. */
export type RegisteredWriteDowns = ReadonlyMap<string, WriteDownMovement>

function isTangibleImpairmentAccount(row: Row): boolean {
  return row.account_number >= '1000' && row.account_number < '1300' && isImpairment(row)
}

/** One write-down account's nedskrivningar booked outside the register (positive amounts). */
interface OutsideRegister {
  name: string
  opening: number
  written: number
  released: number
  closing: number
}

/**
 * The ledger's write-down accounts of 1000-1299 less what the register
 * booked on them. An account whose remainder does not add up as a
 * write-down (the register holds more than the ledger) is left out: the
 * note cannot show it, and the asset note's tie-out reports it instead.
 */
function outsideRegister(rows: readonly Row[], registered: RegisteredWriteDowns): OutsideRegister[] {
  const out: OutsideRegister[] = []
  for (const row of rows) {
    if (!isTangibleImpairmentAccount(row)) continue
    const remainder = remainderOf(row, registered)
    if (isNothing(remainder) || !addsUpAsWriteDown(remainder)) continue
    out.push({ name: row.account_name, ...remainder })
  }
  return out
}

type Remainder = Omit<OutsideRegister, 'name'>

const emptyRow = (account: string): Row => ({
  account_number: account,
  account_name: '',
  opening_debit: 0,
  opening_credit: 0,
  period_debit: 0,
  period_credit: 0,
  closing_debit: 0,
  closing_credit: 0,
})

/** What one write-down account holds beyond what the register booked on it. */
function remainderOf(row: Row, registered: RegisteredWriteDowns): Remainder {
  const booked = registered.get(row.account_number)
  return {
    opening: roundOre(-net(row.opening_debit, row.opening_credit) - (booked?.opening ?? 0)),
    written: roundOre((row.period_credit || 0) - (booked?.writtenDown ?? 0)),
    released: roundOre((row.period_debit || 0) - (booked?.reversed ?? 0) - (booked?.disposed ?? 0)),
    closing: roundOre(-net(row.closing_debit, row.closing_credit) - (booked?.closing ?? 0)),
  }
}

const parts = (remainder: Remainder) => [remainder.opening, remainder.written, remainder.released, remainder.closing]
const isNothing = (remainder: Remainder) => parts(remainder).every((value) => Math.abs(value) < 0.005)
const addsUpAsWriteDown = (remainder: Remainder) => parts(remainder).every((value) => value >= -0.005)

/** What the write-down accounts of one balance sheet post hold beyond the register (positive amounts). */
export interface PostWriteDownsOutsideRegister extends Remainder {
  /** The accounts summed: the ledger note leaves them to the post's table. */
  accounts: string[]
}

/**
 * The same remainder summed per balance sheet post, for the K2 note: its
 * table per post shows every nedskrivning of the post, the register's and
 * what the ledger holds beyond it (k2-fixed-asset-note.ts). Summed over the
 * post and judged there, not per account: a balance the register holds on
 * one write-down account of the post and the ledger on another nets out, and
 * the post then keeps its accounts with nothing beyond the register, so the
 * ledger note does not show the same nedskrivning again. A post whose sum
 * does not add up as a write-down is left out: its accounts stay with the
 * ledger note, account by account as above, and the tie-out reports the rest.
 *
 * `written` and `released` are the year's credits and debits on the
 * accounts: a movement between two of them, and a voucher with its storno,
 * are in both (withoutInternalMovements takes them out).
 */
export function writeDownsOutsideRegisterByPost(
  rows: readonly Row[],
  registered: RegisteredWriteDowns,
  postOfAccount: (account: string) => string | null,
): Map<string, PostWriteDownsOutsideRegister> {
  const sums = new Map<string, PostWriteDownsOutsideRegister>()
  const differs = new Set<string>()
  const add = (account: string, remainder: Remainder) => {
    const post = postOfAccount(account)
    if (!post) return
    if (!isNothing(remainder)) differs.add(post)
    const sum = sums.get(post) ?? { opening: 0, written: 0, released: 0, closing: 0, accounts: [] }
    sums.set(post, {
      opening: roundOre(sum.opening + remainder.opening),
      written: roundOre(sum.written + remainder.written),
      released: roundOre(sum.released + remainder.released),
      closing: roundOre(sum.closing + remainder.closing),
      accounts: [...sum.accounts, account],
    })
  }
  const onLedger = new Set<string>()
  for (const row of rows) {
    onLedger.add(row.account_number)
    if (isTangibleImpairmentAccount(row)) add(row.account_number, remainderOf(row, registered))
  }
  // An account the register wrote down on that the trial balance does not
  // list (nothing on it any more): the ledger holds nothing there, and what
  // the register holds must still be taken off the post's other accounts.
  // An account that is listed is read by its name only, as everywhere here:
  // one the company named itself may hold avskrivningar too.
  for (const account of registered.keys()) {
    if (!onLedger.has(account)) add(account, remainderOf(emptyRow(account), registered))
  }
  for (const [post, sum] of sums) {
    if (!differs.has(post) || !addsUpAsWriteDown(sum)) sums.delete(post)
  }
  return sums
}

/** A year's verifikat as far as the write-down accounts need it. */
export interface WriteDownVoucher {
  id: string
  /** The verifikat this one reverses (a storno), or null. */
  reverses_id: string | null
  /** 'opening_balance' marks a year's ingående balans, which is no movement of the year. */
  source_type?: string | null
  lines: ReadonlyArray<{ account_number: string; debit: number; credit: number }>
}

/** A post whose write-down accounts were both credited and debited beyond the register: the vouchers must say why. */
export function hasBothWriteDownMovements(sum: Pick<PostWriteDownsOutsideRegister, 'written' | 'released'>): boolean {
  return sum.written >= 0.005 && sum.released >= 0.005
}

/**
 * The posts' write-downs beyond the register without the movements that are
 * neither a nedskrivning nor an återföring, read from the year's verifikat
 * on the write-down accounts:
 *   - a verifikat that moves a balance from one write-down account of a post
 *     to another. Only the part its own lines prove: what it credited the
 *     write-down accounts beyond what its other lines debit (a nedskrivning
 *     has its cost, or the asset it came with, on the debit side). A
 *     verifikat that books a nedskrivning on one account and an återföring
 *     on another, each against the result, moves nothing and keeps both;
 *   - a verifikat and its storno, both in the year, cancel each other (a
 *     write-down posted through the register and reversed again is in the
 *     ledger twice and in the register not at all).
 * Both are in the accounts' credits and in their debits, and the post's
 * table would otherwise show them as a nedskrivning and an återföring of the
 * same amount. A year's ingående balans is no movement and is not read.
 */
export function withoutInternalMovements(
  outside: ReadonlyMap<string, PostWriteDownsOutsideRegister>,
  vouchers: readonly WriteDownVoucher[],
): Map<string, PostWriteDownsOutsideRegister> {
  const byId = new Map(vouchers.map((voucher) => [voucher.id, voucher]))
  const result = new Map<string, PostWriteDownsOutsideRegister>()
  for (const [post, sum] of outside) {
    const accounts = new Set(sum.accounts)
    // Per verifikat: what it credited and debited on the post's write-down
    // accounts once a movement between them is taken out.
    const net = new Map<string, { credit: number; debit: number }>()
    let internal = 0
    for (const voucher of vouchers) {
      if (voucher.source_type === 'opening_balance') continue
      let debit = 0
      let credit = 0
      let otherDebit = 0
      for (const line of voucher.lines) {
        if (accounts.has(line.account_number)) {
          debit += line.debit || 0
          credit += line.credit || 0
        } else {
          otherDebit += line.debit || 0
        }
      }
      const moved = Math.max(0, Math.min(debit, credit - otherDebit))
      internal += moved
      net.set(voucher.id, { credit: credit - moved, debit: debit - moved })
    }
    for (const storno of vouchers) {
      const original = storno.reverses_id ? byId.get(storno.reverses_id) : undefined
      if (!original) continue
      const was = net.get(original.id)
      const undone = net.get(storno.id)
      if (!was || !undone) continue
      internal += Math.min(was.credit, undone.debit) + Math.min(was.debit, undone.credit)
    }
    const taken = roundOre(Math.min(internal, sum.written, sum.released))
    result.set(post, {
      ...sum,
      written: roundOre(sum.written - taken),
      released: roundOre(sum.released - taken),
    })
  }
  return result
}

/** What the accounts of one balance sheet post moved in the year, gross. */
export interface PostGrossMovement {
  /** The year's net debit on the post's anskaffningskonton: what raised the booked anskaffningsvärden. */
  cost: number
  /**
   * The year's net credit on its accounts of accumulated avskrivningar: what
   * raised them. Null when one of those accounts also holds nedskrivningar,
   * so the two cannot be told apart.
   */
  depreciation: number | null
}

const DEPRECIATION_NAME = /avskrivning/i
const COMBINED_NAME = /av-\s*och\s*nedskrivning/i

/**
 * The year's movement on each post's accounts of 1000-1299, split in
 * anskaffningsvärden and accumulated avskrivningar: the evidence a stated
 * omräkningsdifferens needs (statedTranslationIssues in
 * k2-fixed-asset-note.ts). An account holds accumulated avskrivningar when
 * the register depreciates an asset on it or its name says so; a write-down
 * account (by name, or one the register wrote down on) is neither, its
 * movements are read on their own; every other account of the post holds
 * anskaffningsvärden.
 */
export function grossMovementsByPost(
  rows: readonly Row[],
  postOfAccount: (account: string) => string | null,
  registerAccounts: { accumulated: ReadonlySet<string>; writeDown: ReadonlySet<string> },
): Map<string, PostGrossMovement> {
  const movements = new Map<string, PostGrossMovement>()
  for (const row of rows) {
    if (row.account_number < '1000' || row.account_number >= '1300') continue
    const post = postOfAccount(row.account_number)
    if (!post) continue
    const movement = movements.get(post) ?? { cost: 0, depreciation: 0 }
    movements.set(post, movement)
    const name = row.account_name ?? ''
    const writeDown = isImpairment(row) || registerAccounts.writeDown.has(row.account_number)
    const accumulated = registerAccounts.accumulated.has(row.account_number) || DEPRECIATION_NAME.test(name)
    if ((writeDown && accumulated) || COMBINED_NAME.test(name)) {
      movement.depreciation = null
    } else if (writeDown) {
      continue
    } else if (accumulated) {
      if (movement.depreciation !== null) {
        movement.depreciation = roundOre(movement.depreciation + (row.period_credit || 0) - (row.period_debit || 0))
      }
    } else {
      movement.cost = roundOre(movement.cost + (row.period_debit || 0) - (row.period_credit || 0))
    }
  }
  return movements
}

/**
 * Accumulated nedskrivningar of immateriella and materiella
 * anläggningstillgångar (1000-1299) booked outside the register, net
 * debit: what the asset note discloses from the ledger next to the
 * register roll-forward, at the end of the year or at its start.
 */
export function tangibleImpairmentBalance(
  rows: readonly Row[],
  registered: RegisteredWriteDowns = new Map(),
  at: 'opening' | 'closing' = 'closing',
): number {
  return roundOre(outsideRegister(rows, registered).reduce((sum, row) => sum - row[at], 0))
}

/**
 * The note on nedskrivningar of immateriella and materiella
 * anläggningstillgångar booked outside the register, or null without any.
 */
export function buildTangibleImpairmentNote(
  rows: readonly Row[],
  noteNumber: number,
  registered: RegisteredWriteDowns = new Map(),
): NoteEntry | null {
  const outside = outsideRegister(rows, registered)
  if (outside.length === 0) return null
  const blocks = outside.map((row) =>
    [
      row.name,
      `  Ingående nedskrivningar: ${fmt(-row.opening)}`,
      `  Årets nedskrivningar: ${fmt(-row.written)}`,
      `  Återförda och avgående nedskrivningar: ${fmt(row.released)}`,
      `  Utgående nedskrivningar: ${fmt(-row.closing)}`,
    ].join('\n'),
  )
  const registerHolds = [...registered.values()].some(
    (m) => m.opening !== 0 || m.writtenDown !== 0 || m.reversed !== 0 || m.disposed !== 0 || m.closing !== 0,
  )
  return {
    number: noteNumber,
    title: 'Nedskrivningar av anläggningstillgångar',
    body: [
      ...(registerHolds
        ? ['Nedskrivningar som bokförts utanför anläggningsregistret. Nedskrivningar som bokförts genom registret redovisas i noten Anläggningstillgångar.', '']
        : []),
      blocks.join('\n\n'),
    ].join('\n'),
  }
}
