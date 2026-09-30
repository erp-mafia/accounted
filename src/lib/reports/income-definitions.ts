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
 * the official BAS kopplingstabell). Same accounts is not yet the same
 * figure, for two reasons the `basis` entry below tells the caller:
 *
 *   - Basis. The income statement drops every bokslut entry (source_type
 *     'year_end': skatt, bokslutsdispositioner, year-end avskrivningar, the
 *     kontantmetod cut-off), the operational convention whose move to
 *     'exclude-final' is #1051 stage 2, deliberately deferred. The
 *     årsredovisning and INK2R keep those entries and drop only the
 *     resultatavslut. So the figures agree only while no bokslut entry is
 *     booked; a closed year's filed figures come from
 *     gnubok_preview_arsredovisning.
 *   - Rounding. The income statement is exact to the öre; the årsredovisning
 *     rounds to whole kronor and INK2R truncates them (SFL 22 kap. 1 §).
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
 * never has to guess which accounts a number sums or which entries it
 * leaves out. `basis` comes first because it qualifies every figure after it.
 */
export const INCOME_STATEMENT_DEFINITIONS = {
  basis: {
    accounts: '3000-8998',
    definition:
      "Resultaträkning before bokslut, exact to the öre: every year-end entry (skatt, bokslutsdispositioner, year-end avskrivningar, kontantmetod cut-off) is excluded. Matches the årsredovisning and INK2R only while no bokslut entry is booked; for a closed year's filed figures use gnubok_preview_arsredovisning.",
  },
  nettoomsattning: {
    accounts: '3000-3799',
    definition:
      'Nettoomsättning: sales incl. egna uttag (34xx), fakturerade kostnader, sidointäkter, net of intäktskorrigeringar. Same accounts as the årsredovisning line and INK2R 3.1; see basis.',
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
    definition: 'Operating expenses (class 4-7), including avskrivningar and övriga rörelsekostnader booked outside bokslut; see basis.',
  },
  rorelseresultat: {
    accounts: '3000-7999',
    definition: 'Rörelseresultat before bokslut entries: operating income minus operating expenses, before finansiella poster.',
  },
  total_financial: {
    accounts: '8000-8998',
    definition: 'Class 8 except 8999: finansiella poster, plus any bokslutsdispositioner (88xx) or skatt (89xx) booked outside bokslut; see basis.',
  },
  net_result: {
    accounts: '3000-8998',
    definition: 'Resultat före bokslutstransaktioner: rorelseresultat + total_financial. Not årets resultat once bokslut entries are booked; see basis.',
  },
} as const satisfies Record<string, IncomeFigureDefinition>

export type IncomeStatementDefinitions = typeof INCOME_STATEMENT_DEFINITIONS
