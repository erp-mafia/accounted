/**
 * The figures the K10 gränsbelopp needs per inkomstår (IL 57 kap. after the
 * 3:12 reform, SFS 2025:1361, in force from inkomstår 2026). Source: the
 * swedish-tax-planning skill (base figures table and references/312-regler.md)
 * and the Bolaget research brief (2026-10-28):
 *
 *   - grundbelopp 4 inkomstbasbelopp for the year before the inkomstår,
 *     split per share (4 x 80 600 = 322 400 kr for 2026);
 *   - lönebaserat utrymme 50 % of the owner's share of the löneunderlag
 *     above 8 inkomstbasbelopp (the same IBB), capped at 50 times the
 *     owner's own cash pay;
 *   - interest on the omkostnadsbelopp above 100 000 kr at the
 *     statslåneränta of 30 November the year before plus 9 percentage
 *     points (2.55 + 9 = 11.55 % for 2026);
 *   - sparat utdelningsutrymme carried forward without uplift;
 *   - takbelopp for dividend taxed as tjänst: 90 inkomstbasbelopp of the
 *     inkomstår (7 506 000 kr for 2026).
 *
 * Only years whose figures are published are here: a year missing from the
 * table has no K10 underlag until its statslåneränta is known. The pre-2026
 * rules (förenklingsregeln, huvudregeln with uplift, lönekrav) are not
 * implemented: the reform replaced them.
 */

export interface K10Parameters {
  income_year: number
  /** Inkomstbasbelopp for the year before the inkomstår (grundbelopp, 8 IBB deduction). */
  ibb_prior_year: number
  /** Inkomstbasbelopp for the inkomstår itself (takbelopp). */
  ibb_income_year: number
  /** Statslåneränta on 30 November the year before, in percent. */
  slr_percent: number
}

/** The first inkomstår of the reformed rules. */
export const K10_FIRST_YEAR = 2026

/** Grundbelopp: 4 IBB per company (IL 57:11 as amended). */
export const BASIC_AMOUNT_IBB = 4
/** Deducted from the owner's share of the löneunderlag: 8 IBB (IL 57:16 as amended). */
export const PAYROLL_DEDUCTION_IBB = 8
/** The share of the löneunderlag above the deduction that counts. */
export const PAYROLL_SHARE = 0.5
/** The lönebaserat utrymme is at most this many times the owner's own cash pay. */
export const OWN_PAY_CAP_MULTIPLE = 50
/** Interest is computed on the omkostnadsbelopp above this. */
export const COST_BASIS_THRESHOLD = 100_000
/** Percentage points above the statslåneränta for the interest on the omkostnadsbelopp. */
export const INTEREST_MARGIN_PP = 9
/** Dividend above the gränsbelopp is taxed as tjänst up to this many IBB. */
export const SERVICE_CEILING_IBB = 90

const PARAMETERS: Record<number, K10Parameters> = {
  2026: { income_year: 2026, ibb_prior_year: 80_600, ibb_income_year: 83_400, slr_percent: 2.55 },
}

export function k10Parameters(year: number): K10Parameters | null {
  return PARAMETERS[year] ?? null
}

export function supportedK10Years(): number[] {
  return Object.keys(PARAMETERS).map(Number).sort((a, b) => a - b)
}
