/**
 * A verifikat named by its number, as a person types it into the "Koppla till
 * verifikat" search: "A17", "A-17", "A 17", "LÖ12", "SAVEQ4-12" or just
 * "17". Pure (no server imports): the picker and the candidate routes read
 * the same grammar.
 *
 * The picker shows a voucher as `${series}-${number}`, so the hyphen form is
 * the unambiguous one: a series that ends in a digit ("SAVEQ4") can only be
 * named with it. Without a separator the trailing digits are the number and
 * the letters before them the series. Without a series every series matches.
 */
export interface VoucherNumber {
  /** Upper-cased series, or null to match the number in every series. */
  series: string | null
  number: number
}

const WITH_SEPARATOR = /^([\p{L}\p{N}_]+)\s*[-\s]\s*(\d{1,9})$/u
const WITHOUT_SEPARATOR = /^([\p{L}_]*)(\d{1,9})$/u

export function parseVoucherNumber(text: string | null | undefined): VoucherNumber | null {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return null
  const match = WITH_SEPARATOR.exec(trimmed) ?? WITHOUT_SEPARATOR.exec(trimmed)
  if (!match) return null
  const number = Number(match[2])
  if (!Number.isSafeInteger(number) || number <= 0) return null
  const series = match[1] ? match[1].toUpperCase() : null
  return { series, number }
}

/** Whether a voucher with this series and number is the one `wanted` names. */
export function voucherNumberMatches(
  wanted: VoucherNumber,
  series: string | null | undefined,
  number: number | null | undefined,
): boolean {
  if (number == null || number !== wanted.number) return false
  return wanted.series === null || (series ?? '').toUpperCase() === wanted.series
}
