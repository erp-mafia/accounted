/**
 * One definition of the statutory resultaträkning revenue lines.
 *
 * Nettoomsättning per ÅRL (kostnadsslagsindelad RR, K2 and K3) is BAS
 * 3000-3799: 30xx-33xx sales, 34xx egna uttag (sales to the owner count as
 * sales), 35xx fakturerade kostnader, 36xx sidointäkter and 37xx
 * intäktskorrigeringar. 38xx aktiverat arbete för egen räkning and 39xx
 * övriga rörelseintäkter are separate RR lines above rörelseresultat. INK2R
 * uses the same split (3.1 fältkod 7410 = 3000-3799, 7412 = 38xx, 7413 =
 * 39xx).
 *
 * The iXBRL mapper and the income statement read these ranges from here, and
 * a test pins them to the INK2R mapping (which stays pure data, pinned to
 * the official BAS kopplingstabell), so an agent asking "what is our
 * revenue" gets the same nettoomsättning the årsredovisning and the
 * declaration show.
 *
 * Account numbers are strings; ranges compare lexicographically, exactly as
 * the K2 mapper always has.
 */

export interface AccountRange {
  start: string
  end: string
}

export const NETTOOMSATTNING_RANGES: readonly AccountRange[] = [{ start: '3000', end: '3799' }]
export const AKTIVERAT_ARBETE_RANGES: readonly AccountRange[] = [{ start: '3800', end: '3899' }]
export const OVRIGA_RORELSEINTAKTER_RANGES: readonly AccountRange[] = [{ start: '3900', end: '3999' }]

export function inAccountRanges(account: string, ranges: readonly AccountRange[]): boolean {
  return ranges.some((range) => account >= range.start && account <= range.end)
}

export interface IncomeFigureDefinition {
  /** Human-readable BAS ranges, e.g. "3000-3799". */
  accounts: string
  definition: string
}

/**
 * Returned next to the figures (income statement, MCP, v1) so a caller
 * never has to guess which accounts a number sums.
 */
export const INCOME_STATEMENT_DEFINITIONS = {
  nettoomsattning: {
    accounts: '3000-3799',
    definition:
      'Nettoomsättning per ÅRL: sales incl. egna uttag (34xx), fakturerade kostnader, sidointäkter, net of intäktskorrigeringar. The statutory revenue figure used in the årsredovisning and INK2R 3.1.',
  },
  aktiverat_arbete: {
    accounts: '3800-3899',
    definition: 'Aktiverat arbete för egen räkning. Own work capitalised as an asset; not part of nettoomsättning.',
  },
  ovriga_rorelseintakter: {
    accounts: '3900-3999',
    definition: 'Övriga rörelseintäkter (e.g. gains on sold assets, grants, exchange gains on operating items). Not part of nettoomsättning.',
  },
  total_revenue: {
    accounts: '3000-3999',
    definition: 'All class 3 operating income: nettoomsättning + aktiverat arbete + övriga rörelseintäkter. Not the statutory revenue figure; use nettoomsattning for "revenue".',
  },
  total_expenses: {
    accounts: '4000-7999',
    definition: 'All operating expenses (class 4-7), including avskrivningar and övriga rörelsekostnader.',
  },
  rorelseresultat: {
    accounts: '3000-7999',
    definition: 'Rörelseresultat: all operating income minus all operating expenses, before finansiella poster, bokslutsdispositioner and skatt.',
  },
  total_financial: {
    accounts: '8000-8998',
    definition: 'Finansiella poster, bokslutsdispositioner (88xx) and skatt (89xx) combined; 8999 årets resultat excluded.',
  },
  net_result: {
    accounts: '3000-8998',
    definition: 'Årets resultat: rörelseresultat + total_financial.',
  },
} as const satisfies Record<string, IncomeFigureDefinition>

export type IncomeStatementDefinitions = typeof INCOME_STATEMENT_DEFINITIONS
