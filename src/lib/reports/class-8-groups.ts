/**
 * Class 8 as the resultaträkning's uppställningsform splits it (ÅRL bilaga 2,
 * kostnadsslagsindelad, the form K2 and K3 both use):
 *
 *   Finansiella poster        80-84
 *   = Resultat efter finansiella poster
 *   Bokslutsdispositioner     88
 *   Skatter                   89 (8900-8989)
 *   Årets resultat            8990-8999
 *
 * One definition for both result reports: the resultaträkning (page, PDF and
 * Excel) and the resultatrapport (page, PDF and Excel). The resultaträkning
 * PDF used to hold this split on its own, while its page and Excel put 88 and
 * 89 under Finansiella poster and the resultatrapport showed class 8 as one
 * group.
 *
 * Any other class-8 kontogrupp (85-87, which BAS leaves unused) gets a block
 * of its own above the line rather than vanish from every sum. 8990-8999
 * (årets resultat) sit in kontogrupp 89 but are no tax: they get the block
 * Årets resultat below Skatter, so a hand-booked 8999 never sums into Summa
 * skatter. The resultaträkning leaves them out; the resultatrapport lists
 * them in that block.
 *
 * Report labels: they stay Swedish in both locales. Pure, safe in the browser.
 */

export type Class8GroupKey =
  | 'finansiella_poster'
  | 'ovriga_finansiella_poster'
  | 'bokslutsdispositioner'
  | 'skatter'
  | 'arets_resultat'

export interface Class8Group {
  key: Class8GroupKey
  /** The block's heading in the uppställningsform. */
  heading: string
  /** The line that sums the block. */
  totalLabel: string
  /**
   * Whether the block counts in Resultat efter finansiella poster, the line
   * that follows the last such block.
   */
  aboveResultAfterFinancial: boolean
}

const FINANSIELLA_POSTER: Class8Group = {
  key: 'finansiella_poster',
  heading: 'Finansiella poster',
  totalLabel: 'Summa finansiella poster',
  aboveResultAfterFinancial: true,
}

const OVRIGA_FINANSIELLA_POSTER: Class8Group = {
  key: 'ovriga_finansiella_poster',
  heading: 'Övriga finansiella poster',
  totalLabel: 'Summa övriga finansiella poster',
  aboveResultAfterFinancial: true,
}

const BOKSLUTSDISPOSITIONER: Class8Group = {
  key: 'bokslutsdispositioner',
  heading: 'Bokslutsdispositioner',
  totalLabel: 'Summa bokslutsdispositioner',
  aboveResultAfterFinancial: false,
}

const SKATTER: Class8Group = {
  key: 'skatter',
  heading: 'Skatter',
  totalLabel: 'Summa skatter',
  aboveResultAfterFinancial: false,
}

const ARETS_RESULTAT: Class8Group = {
  key: 'arets_resultat',
  heading: 'Årets resultat',
  totalLabel: 'Summa årets resultat',
  aboveResultAfterFinancial: false,
}

/** The blocks in the uppställningsform's order: every block above the line comes first. */
export const CLASS_8_GROUPS: readonly Class8Group[] = [
  FINANSIELLA_POSTER,
  OVRIGA_FINANSIELLA_POSTER,
  BOKSLUTSDISPOSITIONER,
  SKATTER,
  ARETS_RESULTAT,
]

export const RESULT_AFTER_FINANCIAL_LABEL = 'Resultat efter finansiella poster'

/**
 * The block a class-8 account belongs to, by its BAS kontogrupp (the first two
 * digits), with 8990-8999 (årets resultat) apart from the tax in kontogrupp 89.
 */
export function class8GroupOf(account: string): Class8Group {
  const kontogrupp = account.slice(0, 2)
  if (kontogrupp === '89' && account.slice(2, 3) === '9') return ARETS_RESULTAT
  if (kontogrupp >= '80' && kontogrupp <= '84') return FINANSIELLA_POSTER
  if (kontogrupp === '88') return BOKSLUTSDISPOSITIONER
  if (kontogrupp === '89') return SKATTER
  return OVRIGA_FINANSIELLA_POSTER
}

/**
 * Class-8 items (rows, or sections of one kontogrupp each) in their blocks, in
 * order, each item in the block of its account. A block without items is left
 * out.
 */
export function splitClass8<T>(
  items: readonly T[],
  accountOf: (item: T) => string,
): { group: Class8Group; items: T[] }[] {
  return CLASS_8_GROUPS.map((group) => ({
    group,
    items: items.filter((item) => class8GroupOf(accountOf(item)).key === group.key),
  })).filter((block) => block.items.length > 0)
}
