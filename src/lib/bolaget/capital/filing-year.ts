import { supportedK10Years } from '../owner-tax/k10-parameters'

/**
 * The inkomstår whose owner filings are due: last year in January, while KU31
 * (dividends) and KU20 (interest to owners) for it are due by 31 January;
 * this year from February. One rule for the pages that work per inkomstår:
 * Kapitalhändelser opens KU31 on it, Ägarskatt och närstående opens on it.
 * `today` is the Stockholm date (todayIsoStockholm). Pure, safe in the browser.
 */
export function incomeYearToFile(today: string): number {
  const year = Number(today.slice(0, 4))
  return today.slice(5, 7) === '01' ? year - 1 : year
}

/**
 * The inkomstår Ägarskatt och närstående opens on: the year to file, unless it
 * has no K10 underlag yet (its inkomstbasbelopp and statslåneränta are not in
 * Accounted) while an earlier year has one: then the latest such year.
 */
export function ownerTaxOpeningYear(today: string): number {
  const year = incomeYearToFile(today)
  const supported = supportedK10Years()
  if (supported.includes(year)) return year
  const earlier = supported.filter((y) => y < year)
  return earlier.length > 0 ? Math.max(...earlier) : year
}
