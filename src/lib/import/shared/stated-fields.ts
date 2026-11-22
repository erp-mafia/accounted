/**
 * What a register import row states, as against what its parser fills in.
 *
 * The customer and supplier parsers fill in what a file does not give, so a
 * new record is complete: a type read from the rest of the row, the country
 * SE (a customer's from its EU VAT number), a supplier's currency SEK. Those
 * fill-ins are for a record the import creates. An update writes what the row
 * states and keeps the record's own for the rest, as the review step promises
 * ("Endast fält med värden i filen skrivs över"), so each parsed row says what
 * it states (ParsedCustomerRow.customer_type_stated, ParsedSupplierRow).
 */

/**
 * What a row states about the party's type: 'type' when its type cell names
 * one, 'business' when the cell says only that the party is a company (a word
 * like Företag, a no in a private-person column), null when it says nothing.
 */
export type TypeStated = 'type' | 'business' | null

/**
 * Type words that say a company without saying which kind ("Företag" is
 * Fortnox's own value). A new record is read as a Swedish business; an update
 * keeps a company's own kind.
 */
export const ANY_BUSINESS_WORDS: readonly string[] = ['företag', 'foretag', 'business']

/** Whether a type cell says only that the party is a company (ANY_BUSINESS_WORDS). */
export function saysOnlyCompany(cell: string | null): boolean {
  return cell !== null && ANY_BUSINESS_WORDS.includes(cell.toLowerCase().trim())
}

/**
 * What a row states about the type, from what its type cell says: only that
 * the party is a company, or a type the register reads from it. A word for
 * any company is 'business' even though a new record reads it as a Swedish
 * business, so it never replaces a company's own kind.
 */
export function statedType(onlyCompany: boolean, namesType: boolean): TypeStated {
  if (onlyCompany) return 'business'
  return namesType ? 'type' : null
}

/**
 * Whether an update writes the row's type over the matched record's: when the
 * row names a type, or says only that the party is a company and the record is
 * a private person. A company keeps its own kind, and a type the row does not
 * state is never written.
 */
export function updateWritesType(stated: TypeStated, recordType: string): boolean {
  return stated === 'type' || (stated === 'business' && recordType === 'individual')
}

/** A row's type and country as an update weighs them: what it reads, and what of it the file states. */
export interface StatedTypeAndCountry {
  /** Read from the file, or filled in when it gives none. */
  type: string
  type_stated: TypeStated
  country: string
  country_stated: boolean
}

/** The type and country an update writes; a key left out keeps the record's own. */
export interface TypeAndCountryWrite {
  type?: string
  country?: string
}

/**
 * What an update does to a matched record's type and country.
 *
 * It writes what the row states and nothing it does not (updateWritesType for
 * the type). `brokenRule` judges a type and country on the register's own
 * rules, told whether the update writes either, and answers which rule they
 * break, or null. When one breaks, the row's own reading fills in the one of
 * the two the row does not state from the one it does: a type it names in
 * place of the record's takes the country the row reads for it, a country it
 * states takes the type the row reads from it, but never a private person (a
 * personnummer-shaped number may be a sole trader's org number). Anything
 * else that breaks a rule, or still does, is `broken`, beside what the row
 * states: the register decides whether that refuses the row. A VAT number or
 * an org number alone never rewrites a type or a country.
 */
export function typeAndCountryForUpdate(
  row: StatedTypeAndCountry,
  record: { type: string; country: string },
  brokenRule: (type: string, country: string, writesTypeOrCountry: boolean) => string | null,
): { write: TypeAndCountryWrite } | { broken: string; stated: TypeAndCountryWrite } {
  const typeNamed = row.type_stated === 'type'
  const typeStated = updateWritesType(row.type_stated, record.type)
  const type = typeStated ? row.type : record.type
  const country = row.country_stated ? row.country : record.country
  const stated: TypeAndCountryWrite = {
    ...(typeStated ? { type } : {}),
    ...(row.country_stated ? { country } : {}),
  }
  const broken = brokenRule(type, country, typeStated || row.country_stated)
  if (!broken) return { write: stated }
  const fillsIn = typeNamed
    ? !row.country_stated && row.type !== record.type
    : row.country_stated && !typeStated && row.type !== 'individual'
  if (!fillsIn) return { broken, stated }
  const stillBroken = brokenRule(row.type, row.country, true)
  if (stillBroken) return { broken: stillBroken, stated }
  return { write: { type: row.type, country: row.country } }
}
