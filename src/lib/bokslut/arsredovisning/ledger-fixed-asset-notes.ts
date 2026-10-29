/**
 * Fixed-asset notes read from the ledger where the asset register does not
 * reach (ÅRL 5 kap. 8 §):
 *   - finansiella anläggningstillgångar (BAS 13xx): per balance sheet post,
 *     the anskaffningsvärde at the start of the year, what came in and went
 *     out, and the accumulated nedskrivningar with the year's change;
 *   - nedskrivningar of immateriella and materiella anläggningstillgångar
 *     (the "Ackumulerade nedskrivningar" accounts 10x8-12x8): the register
 *     roll-forward carries depreciation only.
 *
 * Pure, from the year's FULL trial balance. An account is an impairment
 * account when its name says so ("nedskrivning"), as in BAS (1018, 1118,
 * 1318, 1369, ...): the register cannot carry these and the chart is the
 * only source that names them.
 */
import { K2_BR_MAPPINGS, k2BrSectionForAccount } from '@/lib/bokslut/ixbrl/k2-mapper'
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

/** Accumulated impairments of immateriella and materiella anläggningstillgångar (1000-1299), net debit. */
export function tangibleImpairmentBalance(rows: readonly Row[]): number {
  return rows
    .filter((row) => row.account_number >= '1000' && row.account_number < '1300' && isImpairment(row))
    .reduce((sum, row) => sum + net(row.closing_debit, row.closing_credit), 0)
}

/** The note on nedskrivningar of immateriella and materiella anläggningstillgångar, or null without any. */
export function buildTangibleImpairmentNote(rows: readonly Row[], noteNumber: number): NoteEntry | null {
  const impairments = rows.filter(
    (row) => row.account_number >= '1000' && row.account_number < '1300' && isImpairment(row) && moved(row),
  )
  if (impairments.length === 0) return null
  const blocks = impairments.map((row) => {
    const m = sumMovement([row])
    return [
      row.account_name,
      `  Ingående nedskrivningar: ${fmt(m.opening)}`,
      `  Årets nedskrivningar: ${fmt(m.decrease)}`,
      `  Återförda och avgående nedskrivningar: ${fmt(m.increase)}`,
      `  Utgående nedskrivningar: ${fmt(m.closing)}`,
    ].join('\n')
  })
  return {
    number: noteNumber,
    title: 'Nedskrivningar av anläggningstillgångar',
    body: blocks.join('\n\n'),
  }
}
