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
import { formatPdfKronor } from './pdf-format'

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

const fmt = (n: number) => `${formatPdfKronor(n)} kr`

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
    if (!(row.account_number >= '1000' && row.account_number < '1300' && isImpairment(row))) continue
    const booked = registered.get(row.account_number)
    const remainder = {
      name: row.account_name,
      opening: roundOre(-net(row.opening_debit, row.opening_credit) - (booked?.opening ?? 0)),
      written: roundOre((row.period_credit || 0) - (booked?.writtenDown ?? 0)),
      released: roundOre((row.period_debit || 0) - (booked?.reversed ?? 0) - (booked?.disposed ?? 0)),
      closing: roundOre(-net(row.closing_debit, row.closing_credit) - (booked?.closing ?? 0)),
    }
    const values = [remainder.opening, remainder.written, remainder.released, remainder.closing]
    if (values.every((value) => Math.abs(value) < 0.005)) continue
    if (values.some((value) => value < -0.005)) continue
    out.push(remainder)
  }
  return out
}

/**
 * Accumulated nedskrivningar of immateriella and materiella
 * anläggningstillgångar (1000-1299) booked outside the register, net
 * debit: what the asset note discloses from the ledger next to the
 * register roll-forward.
 */
export function tangibleImpairmentBalance(rows: readonly Row[], registered: RegisteredWriteDowns = new Map()): number {
  return roundOre(outsideRegister(rows, registered).reduce((sum, row) => sum - row.closing, 0))
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
