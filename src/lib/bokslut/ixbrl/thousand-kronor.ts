/**
 * Thousands of kronor (tkr), a half away from zero: how the årsredovisning
 * rounds a figure it states in tkr (the flerårsöversikt of a year that asks
 * for it), in the iXBRL document and in the PDF, so the two state one
 * figure.
 *
 * What is rounded is the whole-krona figure the statements print: 1 499 kr is
 * 1 tkr, 1 500 kr is 2 tkr and -1 500 kr is -2 tkr. A tkr figure then never
 * lies more than 500 kr from the kronor figure of the same post, which is
 * what lets the iXBRL document tag the post at both scales (TA §2.7.3).
 */
import { roundWhole } from './whole-kronor'

export function roundThousands(amount: number): number {
  const kronor = roundWhole(amount)
  const thousands = Math.round(Math.abs(kronor) / 1000)
  return thousands === 0 ? 0 : Math.sign(kronor) * thousands
}
