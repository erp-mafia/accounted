import { signatureDate } from './signature-pages'

/**
 * Datering of the årsredovisning: the day its final content was determined
 * (taxonomy label of UndertecknandeArsredovisningDatum). Each signer also
 * dates their own signature (ÅRL 2 kap. 7 §), and the board determined the
 * content no later than the first of them signed it, so the datering is the
 * EARLIEST signature date. Taking the latest one instead puts the datering
 * after a board signature whenever people sign on different days, which
 * Bolagsverket flags as kontrollkod 1232 ("Datum för årsredovisningen är
 * senare än styrelsens underskrift").
 *
 * One definition for the PDF and every iXBRL path (live draft, locked
 * version, submission) so the filed document never disagrees with the signed
 * original. Takes signed_at instants or signature dates; null while nobody
 * has signed.
 */
export function arsredovisningDatering(
  signedAt: ReadonlyArray<string | null | undefined>,
): string | null {
  const dates = signedAt
    .map((value) => signatureDate(value))
    .filter((value): value is string => value !== null)
    .sort()
  return dates[0] ?? null
}
