import { z } from 'zod'
import { ACCOUNT_NUMBER_RE, ACCOUNT_NUMBER_MESSAGE } from './account-number'
import { ISO_DATE_RE, ISO_DATE_MESSAGE, SANE_DATE_MESSAGE, isSaneDateString } from './iso-date'
import { FISCAL_YEAR_RE, FISCAL_YEAR_MESSAGE } from './fiscal-year'
import { isValidOrgNumber, normalizeOrgNumber } from './org-number'

/**
 * Zod primitives built from the shared rules.
 *
 * Kept in a separate file so consumers that do not use Zod (the MCP server,
 * report generators, SIE import) can import a rule without pulling the
 * dependency into their module graph.
 *
 * `lib/api/schemas.ts` builds its own local aliases on top of these, so the
 * ~100 schemas there inherit any correction made in one place.
 */

/** BAS account number: always a string of exactly 4 digits. */
export const accountNumberSchema = z.string().regex(ACCOUNT_NUMBER_RE, ACCOUNT_NUMBER_MESSAGE)

/** ISO date shape (`YYYY-MM-DD`). Does not check the date exists. */
export const isoDateSchema = z.string().regex(ISO_DATE_RE, ISO_DATE_MESSAGE)

/**
 * ISO date that must also be a real, in-range calendar date. Use this over
 * {@link isoDateSchema} for anything a human typed.
 */
export const saneIsoDateSchema = z.string().refine(isSaneDateString, SANE_DATE_MESSAGE)

/** Four-digit räkenskapsår key. */
export const fiscalYearSchema = z.string().regex(FISCAL_YEAR_RE, FISCAL_YEAR_MESSAGE)

/**
 * Swedish org number in any accepted input form (10 or 12 digits, spaces or
 * hyphens), validated including its Luhn check digit.
 *
 * Does **not** transform: schemas that persist the value should call
 * `normalizeOrgNumber` explicitly at the write site so the canonical form is
 * visible in the calling code rather than hidden in a parser.
 */
export const orgNumberSchema = z
  .string()
  .refine(isValidOrgNumber, 'Ogiltigt organisationsnummer (10 eller 12 siffror, giltig kontrollsiffra)')

/** Org number that is normalized to the canonical 10-digit storage form on parse. */
export const normalizedOrgNumberSchema = orgNumberSchema.transform(
  (v) => normalizeOrgNumber(v) as string,
)
