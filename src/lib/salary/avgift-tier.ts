/**
 * The arbetsgivaravgifter age tier, from the personnummer and the year the
 * pay is made: the one rule the salary engine (calculateAvgifterRate) and the
 * vacation year close (semesterberedning.ts, the 2940 target) share. They
 * each kept a copy.
 *
 *   - born 1937 or earlier: no avgifter
 *   - fyllt `reducedAge` vid årets ingång: only the ålderspensionsavgift
 *     (67 from payment year 2026, SAL 2 kap; the age is in payroll config)
 *   - everyone else: the standard tier
 *
 * The temporary youth rate (Lag 2026:100) is not an age tier of its own
 * here: it also depends on the payment month and caps the basis, so the
 * engine applies it after this tier says standard. Pure.
 */
import { calculateAgeAtYearStart } from './personnummer-format'

export type AvgiftAgeTier = 'exempt' | 'reduced' | 'standard'

/** `personnummer` is the 12-digit plaintext; a malformed one reads as standard. */
export function avgiftAgeTier(personnummer: string, year: number, reducedAge: number): AvgiftAgeTier {
  const birthYear = parseInt(personnummer.slice(0, 4))
  if (!Number.isFinite(birthYear)) return 'standard'
  if (birthYear <= 1937) return 'exempt'
  if (calculateAgeAtYearStart(personnummer, year) >= reducedAge) return 'reduced'
  return 'standard'
}
